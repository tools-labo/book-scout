// scripts/lane2/build_lane2.mjs
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const SEEDS_PATH = "data/lane2/seeds.json";
const OUT_SERIES = "data/lane2/series.json";
const OUT_TODO = "data/lane2/todo.json";
const OUT_DEBUG = "data/lane2/debug_candidates.json";

// ★ env 名は AMZ_ に統一
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

function normLoose(s) {
  return norm(s).toLowerCase().replace(/\s+/g, "");
}

function isLikelySingleEpisode(title) {
  const t = norm(title);
  return (
    /第\s*\d+\s*話/.test(t) ||
    (/話/.test(t) && /\(\s*\d+\s*\)\s*$/.test(t)) ||
    /分冊|単話|話売り|Kindle版|電子版/.test(t)
  );
}

function isVol1Like(title) {
  const t = norm(title);
  return (
    /（\s*1\s*）/.test(t) ||
    /\(\s*1\s*\)/.test(t) ||
    /第\s*1\s*巻/.test(t) ||
    /Vol\.?\s*1/i.test(t) ||
    /[^0-9]1[^0-9]/.test(t)
  );
}

function hasSeriesInTitle(seriesKey, title) {
  const a = normLoose(seriesKey);
  const b = normLoose(title);
  return a && b.includes(a);
}

function scoreCandidate({ seriesKey, title, isbn13 }) {
  let score = 0;
  const t = norm(title);
  if (!t) return 0;

  if (isbn13) score += 80;
  if (hasSeriesInTitle(seriesKey, t)) score += 40;
  if (isVol1Like(t)) score += 30;

  if (/（?上）?/.test(t)) score += 2;

  if (isLikelySingleEpisode(t)) score -= 80;
  if (/FULL\s*COLOR/i.test(t)) score -= 15;
  if (/総集編|公式ファンブック|特装版|限定版|ガイド|画集/.test(t)) score -= 40;

  // NDLの検索結果タイトル（"open 20 ... OpenSearch"）は完全にノイズ
  if (/OpenSearch/i.test(t)) score -= 200;

  return score;
}

function pickBestCandidate(cands) {
  if (!cands.length) return null;
  cands.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  return cands[0];
}

function uniqBy(arr, keyFn) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    const k = keyFn(x);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}

/**
 * -----------------------
 * NDL Search (open) : item単位で title と ISBN を紐づけて拾う
 * -----------------------
 */
async function ndlSearchOpen({ seriesKey }) {
  const q = encodeURIComponent(`${seriesKey} 1`);
  const url = `https://ndlsearch.ndl.go.jp/api/opensearch?dpid=open&count=20&q=${q}`;

  const r = await fetch(url, {
    headers: { "user-agent": "tools-labo/book-scout lane2" },
  });
  if (!r.ok) throw new Error(`NDL HTTP ${r.status}`);
  const xml = await r.text();

  // item単位に分割（粗いがこの用途では十分）
  const blocks = xml.split("<item>").slice(1).map((b) => b.split("</item>")[0]);

  const cands = [];
  for (const block of blocks) {
    const tm = block.match(/<title>([^<]+)<\/title>/);
    const title = tm ? tm[1].replace(/&amp;/g, "&").trim() : "";
    // item内の identifier から ISBN13 を拾う（最初の1つ）
    const im = block.match(/97[89]\d{10}/);
    const isbn13 = im ? im[0] : null;

    // ノイズを強めに排除
    if (!title) continue;
    if (!hasSeriesInTitle(seriesKey, title)) continue;
    if (!isVol1Like(title)) continue;

    const score = scoreCandidate({ seriesKey, title, isbn13 });
    cands.push({
      source: "ndl_open",
      title,
      isbn13,
      score,
      reason: isbn13 ? "ndl_item_has_isbn" : "ndl_item_no_isbn",
      detailUrl: null,
    });
  }

  // 同じISBNが複数出てもいいけど、重複は潰す
  const uniq = uniqBy(cands, (x) => `${x.isbn13 || ""}|${x.title}`);
  uniq.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

  return { query: `${seriesKey} 1`, url, candidates: uniq.slice(0, 10) };
}

/**
 * -----------------------
 * Amazon PA-API (SearchItems)
 * -----------------------
 */
function awsHmac(key, data) {
  return crypto.createHmac("sha256", key).update(data, "utf8").digest();
}
function awsHash(data) {
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
    amzDate: `${y}${m}${day}T${hh}${mm}${ss}Z`,
    dateStamp: `${y}${m}${day}`,
  };
}

async function paapiSearchItems({ keywords }) {
  if (!AMZ_ACCESS_KEY || !AMZ_SECRET_KEY || !AMZ_PARTNER_TAG) {
    return { skipped: true, reason: "missing_paapi_secrets" };
  }

  const host = "webservices.amazon.co.jp";
  const region = "us-west-2";
  const service = "ProductAdvertisingAPI";
  const endpoint = `https://${host}/paapi5/searchitems`;

  // ★ Resources から DetailPageURL を外す（これが400の原因）
  // SearchItems の Resources はドキュメントの列挙から選ぶ  [oai_citation:1‡Amazon Web Services](https://webservices.amazon.com/paapi5/documentation/search-items.html)
  const bodyObj = {
    Keywords: keywords,
    SearchIndex: "Books",
    ItemCount: 10,
    PartnerTag: AMZ_PARTNER_TAG,
    PartnerType: "Associates",
    Resources: [
      "ItemInfo.Title",
      "ItemInfo.ByLineInfo",
      "ItemInfo.ExternalIds",
      "Images.Primary.Large",
    ],
  };
  const body = JSON.stringify(bodyObj);

  const { amzDate: xAmzDate, dateStamp } = amzDate();
  const method = "POST";
  const canonicalUri = "/paapi5/searchitems";
  const canonicalQuerystring = "";
  const canonicalHeaders =
    `content-encoding:amz-1.0\ncontent-type:application/json; charset=utf-8\nhost:${host}\nx-amz-date:${xAmzDate}\nx-amz-target:com.amazon.paapi5.v1.ProductAdvertisingAPIv1.SearchItems\n`;
  const signedHeaders = "content-encoding;content-type;host;x-amz-date;x-amz-target";
  const payloadHash = awsHash(body);

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
    awsHash(canonicalRequest),
  ].join("\n");

  const kDate = awsHmac(`AWS4${AMZ_SECRET_KEY}`, dateStamp);
  const kRegion = awsHmac(kDate, region);
  const kService = awsHmac(kRegion, service);
  const kSigning = awsHmac(kService, "aws4_request");
  const signature = crypto
    .createHmac("sha256", kSigning)
    .update(stringToSign, "utf8")
    .digest("hex");

  const authorizationHeader =
    `${algorithm} Credential=${AMZ_ACCESS_KEY}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const r = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-encoding": "amz-1.0",
      "content-type": "application/json; charset=utf-8",
      host,
      "x-amz-date": xAmzDate,
      "x-amz-target": "com.amazon.paapi5.v1.ProductAdvertisingAPIv1.SearchItems",
      Authorization: authorizationHeader,
    },
    body,
  });

  const text = await r.text();
  if (!r.ok) {
    return { error: true, status: r.status, body: text.slice(0, 800) };
  }
  return { ok: true, json: JSON.parse(text) };
}

function extractIsbn13FromPaapiItem(item) {
  const vals = item?.ItemInfo?.ExternalIds?.ISBN?.DisplayValues;
  if (Array.isArray(vals) && vals.length) {
    const v = String(vals[0]).replace(/[^0-9]/g, "");
    if (/^97[89]\d{10}$/.test(v)) return v;
  }
  return null;
}

function extractTitleFromPaapiItem(item) {
  return item?.ItemInfo?.Title?.DisplayValue || "";
}

function extractAuthorFromPaapiItem(item) {
  const v = item?.ItemInfo?.ByLineInfo?.Contributors;
  if (Array.isArray(v) && v.length) {
    // ざっくり。表示用の最小限だけ
    return v
      .map((x) => x?.Name)
      .filter(Boolean)
      .slice(0, 3)
      .join("/");
  }
  return null;
}

function dpFromAsin(asin) {
  if (!asin) return null;
  return `https://www.amazon.co.jp/dp/${asin}`;
}

function extractImageFromPaapiItem(item) {
  return item?.Images?.Primary?.Large?.URL || null;
}

/**
 * 「誤confirmed」を強く潰すための検証：
 * NDLのISBNを PA-API で検索 → “同じISBNが返る” かつ “シリーズ名と1巻っぽさ” を満たすものだけ確定。
 */
async function verifyIsbnByPaapi({ seriesKey, isbn13 }) {
  const res = await paapiSearchItems({ keywords: isbn13 });
  if (res?.skipped) return { skipped: true, reason: res.reason };
  if (res?.error) return { error: true, status: res.status, body: res.body };

  const items = res?.json?.SearchResult?.Items || [];
  const cands = [];

  for (const it of items) {
    const title = extractTitleFromPaapiItem(it);
    const gotIsbn = extractIsbn13FromPaapiItem(it);
    const asin = it?.ASIN || null;

    // “ISBN一致”が最優先（ここで一致しないなら採用しない）
    if (!gotIsbn || gotIsbn !== isbn13) continue;

    // さらに安全策：シリーズ名を含む + 1巻っぽい
    if (!hasSeriesInTitle(seriesKey, title)) continue;
    if (!isVol1Like(title)) continue;
    if (isLikelySingleEpisode(title)) continue;

    cands.push({
      score: 200, // ここまで来たらほぼ確
      title,
      isbn13: gotIsbn,
      asin,
      amazonDp: dpFromAsin(asin),
      image: extractImageFromPaapiItem(it),
      author: extractAuthorFromPaapiItem(it),
    });
  }

  return { ok: true, candidates: cands, rawCount: items.length };
}

async function main() {
  const seeds = await loadJson(SEEDS_PATH, { items: [] });
  const seedItems = Array.isArray(seeds?.items) ? seeds.items : [];

  const confirmed = [];
  const todo = [];
  const debug = [];

  for (const s of seedItems) {
    const seriesKey = norm(s?.seriesKey);
    const seedAuthor = norm(s?.author) || null;
    if (!seriesKey) continue;

    // 1) NDL(open) で “巻1らしい & シリーズ名含む & ISBNあり” の候補を作る
    let ndl;
    try {
      ndl = await ndlSearchOpen({ seriesKey });
    } catch (e) {
      ndl = { error: true, message: String(e?.message || e) };
    }

    const ndlCands = Array.isArray(ndl?.candidates) ? ndl.candidates : [];
    const ndlBest = pickBestCandidate(ndlCands);

    // NDL側でISBNが取れない/候補がない
    if (!ndlBest?.isbn13) {
      todo.push({
        seriesKey,
        author: seedAuthor,
        reason: "ndl_no_candidate_or_no_isbn",
        best: ndlBest
          ? { source: "ndl_open", score: ndlBest.score, title: ndlBest.title, isbn13: ndlBest.isbn13 }
          : null,
      });
      debug.push({ seriesKey, ndl });
      await sleep(400);
      continue;
    }

    // 2) 重要：NDLのISBNを PA-API で検証して “一致確認できたときだけ” confirmed
    const verify = await verifyIsbnByPaapi({ seriesKey, isbn13: ndlBest.isbn13 });

    if (verify?.skipped) {
      // Secrets 無い等 → “確定できない” ので todo
      todo.push({
        seriesKey,
        author: seedAuthor,
        reason: `ndl_has_isbn_but_paapi_skipped(${verify.reason})`,
        best: { source: "ndl_open", score: ndlBest.score, title: ndlBest.title, isbn13: ndlBest.isbn13 },
      });
      debug.push({ seriesKey, ndl, paapi: { skipped: true, reason: verify.reason } });
      await sleep(400);
      continue;
    }
    if (verify?.error) {
      todo.push({
        seriesKey,
        author: seedAuthor,
        reason: `paapi_error(status=${verify.status})`,
        best: { source: "ndl_open", score: ndlBest.score, title: ndlBest.title, isbn13: ndlBest.isbn13 },
      });
      debug.push({ seriesKey, ndl, paapi: { error: true, status: verify.status, body: verify.body } });
      // 429対策：ここで長めに待つ
      await sleep(1500);
      continue;
    }

    const okCands = Array.isArray(verify?.candidates) ? verify.candidates : [];
    const best = okCands[0] || null;

    if (best) {
      confirmed.push({
        seriesKey,
        author: seedAuthor || best.author || null,
        vol1: {
          title: best.title,
          isbn13: best.isbn13,
          image: best.image || null,
          amazonDp: best.amazonDp || null,
          source: "ndl_open+paapi_verify",
        },
      });
      debug.push({
        seriesKey,
        ndl,
        paapi: { verified: true, isbn13: ndlBest.isbn13, picked: best, rawCount: verify.rawCount },
      });
    } else {
      todo.push({
        seriesKey,
        author: seedAuthor,
        reason: "paapi_verify_no_match",
        best: { source: "ndl_open", score: ndlBest.score, title: ndlBest.title, isbn13: ndlBest.isbn13 },
      });
      debug.push({ seriesKey, ndl, paapi: { verified: false, isbn13: ndlBest.isbn13, rawCount: verify.rawCount } });
    }

    // 429を避けるため、1作品ごとに待つ
    await sleep(1200);
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
