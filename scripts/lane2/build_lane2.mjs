// scripts/lane2/build_lane2.mjs
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const SEEDS_PATH = "data/lane2/seeds.json";
const OUT_SERIES = "data/lane2/series.json";
const OUT_TODO = "data/lane2/todo.json";
const OUT_DEBUG = "data/lane2/debug_candidates.json";

const AMZ_ACCESS_KEY = process.env.AMZ_ACCESS_KEY || "";
const AMZ_SECRET_KEY = process.env.AMZ_SECRET_KEY || "";
const AMZ_PARTNER_TAG = process.env.AMZ_PARTNER_TAG || "";

function nowIso() {
  return new Date().toISOString();
}

async function loadJson(p, fallback) {
  try {
    return JSON.parse(await fs.readFile(p, "utf8"));
  } catch {
    return fallback;
  }
}
async function saveJson(p, obj) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(obj, null, 2));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function norm(s) {
  return String(s ?? "").trim();
}

// 全角数字を半角へ
function z2hDigits(s) {
  return String(s ?? "").replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}

function isLikelySingleEpisode(title) {
  const t = z2hDigits(norm(title));
  return /第\s*\d+\s*話/.test(t) || /分冊|単話|話売り|Kindle版|電子版/.test(t);
}

function isVol1Like(title) {
  const t = z2hDigits(norm(title));
  return (
    /（\s*1\s*）/.test(t) ||
    /\(\s*1\s*\)/.test(t) ||
    /第\s*1\s*巻/.test(t) ||
    /\bVol\.?\s*1\b/i.test(t) ||
    /(^|[^0-9])1([^0-9]|$)/.test(t)
  );
}

function scoreCandidate({ title, isbn13, seriesKey, author }) {
  const t = z2hDigits(norm(title));
  let score = 0;

  if (isbn13) score += 80;
  if (t && seriesKey && t.includes(seriesKey)) score += 30;
  if (author && t.includes(author)) score += 10;
  if (isVol1Like(t)) score += 30;

  if (isLikelySingleEpisode(t)) score -= 80;
  if (/FULL\s*COLOR/i.test(t)) score -= 15;
  if (/総集編|公式ファンブック|特装版|限定版|ガイド|画集/.test(t)) score -= 40;

  return score;
}

function pickBest(cands) {
  if (!cands.length) return null;
  cands.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  return cands[0];
}

/**
 * -----------------------
 * NDL OpenSearch (申請不要枠)
 * -----------------------
 * 仕様通り title/creator/any で検索し、RSS2.0 item単位で title + ISBN を紐付ける
 */
function extractBetween(s, a, b) {
  const i = s.indexOf(a);
  if (i < 0) return null;
  const j = s.indexOf(b, i + a.length);
  if (j < 0) return null;
  return s.slice(i + a.length, j);
}

function decodeXml(s) {
  return String(s ?? "")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");
}

function extractIsbn13(str) {
  const m = String(str ?? "").match(/97[89]\d{10}/);
  return m ? m[0] : null;
}

async function ndlOpenSearch({ seriesKey, author }) {
  // q= は使わない（仕様外）。title/creator/any を使う。  [oai_citation:2‡国立国会図書館サーチ（NDLサーチ）](https://ndlsearch.ndl.go.jp/file/help/api/specifications/ndlsearch_api_20240712.pdf)
  const params = new URLSearchParams();
  params.set("dpid", "open");
  params.set("cnt", "20");

  // タイトルを主軸。作者があるなら creator を併用（AND検索）
  params.set("title", seriesKey);
  if (author) params.set("creator", author);

  const url = `https://ndlsearch.ndl.go.jp/api/opensearch?${params.toString()}`;
  const r = await fetch(url, { headers: { "user-agent": "tools-labo/book-scout lane2" } });
  if (!r.ok) throw new Error(`NDL HTTP ${r.status}`);
  const xml = await r.text();

  // item単位でパース
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  for (const m of xml.matchAll(itemRe)) {
    const block = m[1];

    const titleRaw = extractBetween(block, "<title>", "</title>");
    const title = decodeXml(titleRaw || "");
    if (!title) continue;

    // identifier から ISBNらしきものを拾う（dc:identifier のどこかに混ざることが多い）
    const isbn13 = extractIsbn13(block);

    items.push({ title, isbn13, block });
  }

  const candidates = [];
  for (const it of items) {
    // 単話っぽいのをNDL側で弾く
    if (isLikelySingleEpisode(it.title)) continue;

    const score = scoreCandidate({
      title: it.title,
      isbn13: it.isbn13,
      seriesKey,
      author,
    });

    candidates.push({
      source: "ndl_open",
      title: it.title,
      isbn13: it.isbn13 || null,
      score,
    });
  }

  return {
    query: { title: seriesKey, creator: author || null },
    url,
    returned: items.length,
    candidates,
  };
}

/**
 * -----------------------
 * Amazon PA-API (SearchItems -> GetItems)
 * -----------------------
 * SearchItemsでASIN候補を取って、GetItemsでISBNを確定させる
 * （SearchItemsのResources指定で落ちる/揺れるのを避ける）
 */
function awsHmac(key, data) {
  return crypto.createHmac("sha256", key).update(data, "utf8").digest();
}
function awsHashHex(data) {
  return crypto.createHash("sha256").update(data, "utf8").digest("hex");
}
function amzDate() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  return {
    xAmzDate: `${y}${m}${day}T${hh}${mm}${ss}Z`,
    dateStamp: `${y}${m}${day}`,
  };
}

async function paapiRequest({ target, bodyObj }) {
  if (!AMZ_ACCESS_KEY || !AMZ_SECRET_KEY || !AMZ_PARTNER_TAG) {
    return { skipped: true, reason: "missing_paapi_secrets" };
  }

  const host = "webservices.amazon.co.jp";
  const region = "us-west-2";
  const service = "ProductAdvertisingAPI";
  const endpoint = `https://${host}${target}`;

  const body = JSON.stringify(bodyObj);
  const { xAmzDate, dateStamp } = amzDate();

  const method = "POST";
  const canonicalUri = target;
  const canonicalQuerystring = "";
  const canonicalHeaders =
    `content-encoding:amz-1.0\ncontent-type:application/json; charset=utf-8\nhost:${host}\nx-amz-date:${xAmzDate}\nx-amz-target:com.amazon.paapi5.v1.ProductAdvertisingAPIv1.${bodyObj.__Target}\n`;
  const signedHeaders = "content-encoding;content-type;host;x-amz-date;x-amz-target";
  const payloadHash = awsHashHex(body);

  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuerystring,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const algorithm = "AWS4-HMAC-SHA256";
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    algorithm,
    xAmzDate,
    credentialScope,
    awsHashHex(canonicalRequest),
  ].join("\n");

  const kDate = awsHmac(`AWS4${AMZ_SECRET_KEY}`, dateStamp);
  const kRegion = awsHmac(kDate, region);
  const kService = awsHmac(kRegion, service);
  const kSigning = awsHmac(kService, "aws4_request");
  const signature = crypto.createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");

  const authorizationHeader =
    `${algorithm} Credential=${AMZ_ACCESS_KEY}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const r = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-encoding": "amz-1.0",
      "content-type": "application/json; charset=utf-8",
      host,
      "x-amz-date": xAmzDate,
      "x-amz-target": `com.amazon.paapi5.v1.ProductAdvertisingAPIv1.${bodyObj.__Target}`,
      Authorization: authorizationHeader,
    },
    body,
  });

  const text = await r.text();
  if (!r.ok) return { ok: false, status: r.status, body: text.slice(0, 800) };

  return { ok: true, json: JSON.parse(text) };
}

async function paapiSearchAsins({ keywords }) {
  const bodyObj = {
    __Target: "SearchItems",
    Keywords: keywords,
    SearchIndex: "Books",
    ItemCount: 10,
    PartnerTag: AMZ_PARTNER_TAG,
    PartnerType: "Associates",
    // SearchItemsではまず ASIN と Title だけ取れればOK
    Resources: ["ItemInfo.Title", "DetailPageURL"],
  };

  const res = await paapiRequest({ target: "/paapi5/searchitems", bodyObj });
  if (res?.skipped) return res;
  if (!res.ok) return res;

  const items = res.json?.SearchResult?.Items || [];
  return {
    ok: true,
    items: items.map((it) => ({
      asin: it?.ASIN || null,
      title: it?.ItemInfo?.Title?.DisplayValue || "",
      detail: it?.DetailPageURL || null,
    })).filter((x) => x.asin),
  };
}

function extractIsbn13FromGetItems(item) {
  const vals = item?.ItemInfo?.ExternalIds?.ISBN?.DisplayValues;
  if (Array.isArray(vals) && vals.length) {
    const v = String(vals[0]).replace(/[^0-9X]/gi, "");
    if (/^97[89]\d{10}$/.test(v)) return v;
  }
  return null;
}

async function paapiGetItems({ asins }) {
  const bodyObj = {
    __Target: "GetItems",
    ItemIds: asins,
    PartnerTag: AMZ_PARTNER_TAG,
    PartnerType: "Associates",
    Resources: [
      "ItemInfo.Title",
      "ItemInfo.ByLineInfo",
      "ItemInfo.ExternalIds",
      "DetailPageURL",
      "Images.Primary.Large",
    ],
  };

  const res = await paapiRequest({ target: "/paapi5/getitems", bodyObj });
  if (res?.skipped) return res;
  if (!res.ok) return res;

  const items = res.json?.ItemsResult?.Items || [];
  return {
    ok: true,
    items: items.map((it) => ({
      asin: it?.ASIN || null,
      title: it?.ItemInfo?.Title?.DisplayValue || "",
      isbn13: extractIsbn13FromGetItems(it),
      image: it?.Images?.Primary?.Large?.URL || null,
      amazonDp: it?.DetailPageURL || null,
    })).filter((x) => x.asin),
  };
}

/**
 * -----------------------
 * “誤confirmed”防止の確定ロジック
 * -----------------------
 * confirmed条件：NDL候補ISBN == PA-API GetItemsのISBN（完全一致） かつ Vol1っぽい
 */
async function confirmVol1({ seriesKey, author }) {
  const debug = { seriesKey, ndl: null, paapi: null, decided: null };

  // 1) NDL候補
  let ndl;
  try {
    ndl = await ndlOpenSearch({ seriesKey, author });
  } catch (e) {
    ndl = { error: true, message: String(e?.message || e) };
  }
  debug.ndl = ndl;

  const ndlCands = (ndl?.candidates || [])
    .filter((c) => c.isbn13 && isVol1Like(c.title))
    .map((c) => ({ ...c, score: scoreCandidate({ title: c.title, isbn13: c.isbn13, seriesKey, author }) }));

  const ndlBest = pickBest(ndlCands);

  // NDLでISBNが取れないなら即todo（安全第一）
  if (!ndlBest?.isbn13) {
    debug.decided = { step: "todo", reason: "ndl_no_isbn" };
    return { ok: false, debug };
  }

  // 2) Amazon SearchItemsでASIN候補
  const q1 = `${seriesKey} 1`;
  const q2 = `${seriesKey} （1）`;
  const queries = [q1, q2];

  const searchResults = [];
  let asins = [];
  for (const q of queries) {
    const sres = await paapiSearchAsins({ keywords: q });
    if (sres?.skipped) {
      debug.paapi = { skipped: true, reason: sres.reason };
      debug.decided = { step: "todo", reason: `paapi_skipped(${sres.reason})`, ndlIsbn: ndlBest.isbn13 };
      return { ok: false, debug };
    }
    if (!sres.ok) {
      searchResults.push({ query: q, ok: false, status: sres.status, body: sres.body });
      await sleep(800);
      continue;
    }
    searchResults.push({ query: q, ok: true, returned: sres.items.length });

    // “1巻っぽい + シリーズ名入り + 単話除外”でASIN候補化
    for (const it of sres.items) {
      const t = z2hDigits(norm(it.title));
      if (!t) continue;
      if (!t.includes(seriesKey)) continue;
      if (!isVol1Like(t)) continue;
      if (isLikelySingleEpisode(t)) continue;
      asins.push(it.asin);
    }

    await sleep(800);
  }

  asins = [...new Set(asins)].slice(0, 10);

  debug.paapi = { queries, searchResults, pickedAsins: asins, ndlBest };

  if (!asins.length) {
    debug.decided = { step: "todo", reason: "paapi_no_asin_candidate", ndlIsbn: ndlBest.isbn13 };
    return { ok: false, debug };
  }

  // 3) GetItemsでISBN確定 → NDL ISBNと一致のみconfirmed
  const getres = await paapiGetItems({ asins });
  if (getres?.skipped) {
    debug.decided = { step: "todo", reason: `paapi_skipped(${getres.reason})`, ndlIsbn: ndlBest.isbn13 };
    return { ok: false, debug };
  }
  if (!getres.ok) {
    debug.decided = { step: "todo", reason: `paapi_getitems_error(${getres.status})`, ndlIsbn: ndlBest.isbn13 };
    debug.paapi.getItemsError = { status: getres.status, body: getres.body };
    return { ok: false, debug };
  }

  const matched = getres.items.find((x) => x.isbn13 && x.isbn13 === ndlBest.isbn13);
  debug.paapi.getItems = { returned: getres.items.length, items: getres.items };

  if (!matched) {
    debug.decided = { step: "todo", reason: "isbn_mismatch(ndl_vs_paapi)", ndlIsbn: ndlBest.isbn13 };
    return { ok: false, debug };
  }

  // confirmed（ここまで来たら“誤confirmed”は出ない）
  debug.decided = { step: "confirmed", isbn13: matched.isbn13, asin: matched.asin };

  return {
    ok: true,
    item: {
      seriesKey,
      author: author || null,
      vol1: {
        title: matched.title || ndlBest.title || seriesKey,
        isbn13: matched.isbn13,
        image: matched.image || null,
        amazonDp: matched.amazonDp || null,
        source: "ndl_open+paapi_getitems",
      },
    },
    debug,
  };
}

async function main() {
  const seeds = await loadJson(SEEDS_PATH, { items: [] });
  const seedItems = Array.isArray(seeds?.items) ? seeds.items : [];

  const confirmed = [];
  const todo = [];
  const debug = [];

  for (const s of seedItems) {
    const seriesKey = norm(s?.seriesKey);
    const author = norm(s?.author) || null;
    if (!seriesKey) continue;

    const res = await confirmVol1({ seriesKey, author });
    debug.push(res.debug);

    if (res.ok) {
      confirmed.push(res.item);
    } else {
      todo.push({
        seriesKey,
        author,
        reason: res.debug?.decided?.reason || "not_confirmed",
        best: {
          source: "ndl_open",
          score: res.debug?.paapi?.ndlBest?.score ?? null,
          title: res.debug?.paapi?.ndlBest?.title ?? null,
          isbn13: res.debug?.paapi?.ndlBest?.isbn13 ?? null,
        },
      });
    }

    // 優しめ
    await sleep(600);
  }

  const outSeries = {
    updatedAt: nowIso(),
    total: seedItems.length,
    confirmed: confirmed.length,
    todo: todo.length,
    items: confirmed,
  };

  const outTodo = {
    updatedAt: nowIso(),
    total: todo.length,
    items: todo,
  };

  await saveJson(OUT_SERIES, outSeries);
  await saveJson(OUT_TODO, outTodo);
  await saveJson(OUT_DEBUG, { updatedAt: nowIso(), items: debug });

  console.log(`[lane2] seeds=${seedItems.length} confirmed=${confirmed.length} todo=${todo.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
