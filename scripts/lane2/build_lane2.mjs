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

const PAAPI_HOST = "webservices.amazon.co.jp";
const PAAPI_REGION = "us-west-2";
const PAAPI_SERVICE = "ProductAdvertisingAPI";
const MARKETPLACE = "www.amazon.co.jp";

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
function escXml(s) {
  return String(s ?? "")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");
}

function isLikelySingleEpisode(title) {
  const t = norm(title);
  return (
    /第\s*\d+\s*話/.test(t) ||
    (/(\(\s*\d+\s*\)\s*$)/.test(t) && /話/.test(t)) ||
    /分冊|単話|話売り|Kindle版|電子版/.test(t)
  );
}
function isVol1Like(title) {
  const t = norm(title);
  return (
    /（\s*1\s*）/.test(t) ||
    /第\s*1\s*巻/.test(t) ||
    /Vol\.?\s*1/i.test(t) ||
    /(^|[^0-9])1([^0-9]|$)/.test(t)
  );
}
function isDerivedOrGuide(title) {
  const t = norm(title);
  return /総集編|公式ファンブック|特装版|限定版|ガイド|画集|FULL\s*COLOR/i.test(t);
}

function scoreCandidate({ seriesKey, title, isbn13 }) {
  let score = 0;
  const t = norm(title);
  if (!t) return 0;

  if (isbn13) score += 80;
  if (t.includes(seriesKey)) score += 25;
  if (isVol1Like(t)) score += 25;

  if (/\b(上|前編)\b/.test(t)) score += 5;
  if (isLikelySingleEpisode(t)) score -= 80;
  if (isDerivedOrGuide(t)) score -= 50;

  // “open 20 ... - 国会図書館...” みたいなノイズは強く落とす
  if (/国立国会図書館サーチ|OpenSearch/i.test(t)) score -= 120;

  return score;
}

/**
 * -----------------------
 * NDL OpenSearch (申請不要枠)
 * -----------------------
 * 重要: “フィード全体からISBN拾う”のは禁止。
 * entry/itemごとに title と isbn を対応させて候補化する。
 */
async function ndlSearchOpen({ seriesKey }) {
  const q = encodeURIComponent(`${seriesKey} 1`);
  const url = `https://ndlsearch.ndl.go.jp/api/opensearch?dpid=open&count=20&q=${q}`;

  const r = await fetch(url, {
    headers: { "user-agent": "tools-labo/book-scout lane2" },
  });
  if (!r.ok) throw new Error(`NDL HTTP ${r.status}`);
  const xml = await r.text();

  // RSS(<item>) と Atom(<entry>) の両対応
  const blocks = [
    ...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi),
    ...xml.matchAll(/<entry[^>]*>([\s\S]*?)<\/entry>/gi),
  ].map((m) => m[1]);

  const cands = [];
  let dropped = 0;

  for (const b of blocks.slice(0, 30)) {
    const titleRaw =
      b.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ??
      b.match(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i)?.[1] ??
      "";
    const title = escXml(titleRaw).trim();

    // 作品名が入ってない候補は捨てる（誤爆防止）
    if (!title || !title.includes(seriesKey)) {
      dropped++;
      continue;
    }

    // entry/item内のISBN(13)だけ拾う
    const isbn13 =
      b.match(/97[89]\d{10}/)?.[0] ?? null;

    const score = scoreCandidate({ seriesKey, title, isbn13 });
    if (score <= 0) {
      dropped++;
      continue;
    }

    cands.push({
      source: "ndl_open",
      title,
      isbn13,
      score,
    });
  }

  cands.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  return { query: `${seriesKey} 1`, url, candidates: cands.slice(0, 10), dropped };
}

/**
 * -----------------------
 * Amazon PA-API v5 signing helpers
 * -----------------------
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
  return { xAmzDate: `${y}${m}${day}T${hh}${mm}${ss}Z`, dateStamp: `${y}${m}${day}` };
}

async function paapiRequest({ target, bodyObj }) {
  if (!AMZ_ACCESS_KEY || !AMZ_SECRET_KEY || !AMZ_PARTNER_TAG) {
    return { skipped: true, reason: "missing_paapi_secrets" };
  }

  const endpoint = `https://${PAAPI_HOST}${target.path}`;
  const body = JSON.stringify(bodyObj);

  const { xAmzDate, dateStamp } = amzDate();
  const method = "POST";
  const canonicalUri = target.path;
  const canonicalQuerystring = "";

  const canonicalHeaders =
    `content-encoding:amz-1.0\n` +
    `content-type:application/json; charset=utf-8\n` +
    `host:${PAAPI_HOST}\n` +
    `x-amz-date:${xAmzDate}\n` +
    `x-amz-target:${target.amzTarget}\n`;

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
  const credentialScope = `${dateStamp}/${PAAPI_REGION}/${PAAPI_SERVICE}/aws4_request`;
  const stringToSign = [
    algorithm,
    xAmzDate,
    credentialScope,
    awsHashHex(canonicalRequest),
  ].join("\n");

  const kDate = awsHmac(`AWS4${AMZ_SECRET_KEY}`, dateStamp);
  const kRegion = awsHmac(kDate, PAAPI_REGION);
  const kService = awsHmac(kRegion, PAAPI_SERVICE);
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
      host: PAAPI_HOST,
      "x-amz-date": xAmzDate,
      "x-amz-target": target.amzTarget,
      Authorization: authorizationHeader,
    },
    body,
  });

  const text = await r.text();
  if (!r.ok) return { ok: false, status: r.status, body: text.slice(0, 1200) };
  return { ok: true, json: JSON.parse(text) };
}

function extractIsbn13(item) {
  const vals = item?.ItemInfo?.ExternalIds?.ISBN?.DisplayValues;
  if (Array.isArray(vals) && vals.length) {
    const v = String(vals[0]).replace(/[^0-9X]/gi, "");
    if (/^97[89]\d{10}$/.test(v)) return v;
  }
  return null;
}
function extractTitle(item) {
  return item?.ItemInfo?.Title?.DisplayValue || "";
}
function extractImage(item) {
  return item?.Images?.Primary?.Large?.URL || null;
}
function extractDetailUrl(item) {
  // DetailPageURLはレスポンスに含まれる
  return item?.DetailPageURL || null;
}
function extractAsin(item) {
  return item?.ASIN || null;
}

async function paapiGetItemsByIsbn({ isbns }) {
  const bodyObj = {
    ItemIds: isbns,
    ItemIdType: "ISBN",
    Marketplace: MARKETPLACE,
    PartnerTag: AMZ_PARTNER_TAG,
    PartnerType: "Associates",
    Resources: [
      "ItemInfo.Title",
      "ItemInfo.ExternalIds",
      "ItemInfo.ByLineInfo",
      "Images.Primary.Large",
    ],
  };

  return await paapiRequest({
    target: {
      path: "/paapi5/getitems",
      amzTarget: "com.amazon.paapi5.v1.ProductAdvertisingAPIv1.GetItems",
    },
    bodyObj,
  });
}

async function paapiSearchItems({ keywords }) {
  const bodyObj = {
    Keywords: keywords,
    SearchIndex: "Books",
    ItemCount: 10,
    Marketplace: MARKETPLACE,
    PartnerTag: AMZ_PARTNER_TAG,
    PartnerType: "Associates",
    Resources: [
      "ItemInfo.Title",
      "ItemInfo.ExternalIds",
      "ItemInfo.ByLineInfo",
      "Images.Primary.Large",
    ],
  };

  return await paapiRequest({
    target: {
      path: "/paapi5/searchitems",
      amzTarget: "com.amazon.paapi5.v1.ProductAdvertisingAPIv1.SearchItems",
    },
    bodyObj,
  });
}

/**
 * -----------------------
 * “誤confirmed”潰し（最重要）
 * -----------------------
 * confirmed条件:
 *  1) seriesKey がタイトルに含まれる（ゆるくcontains）
 *  2) 1巻っぽい（isVol1Like）
 *  3) 単話/派生/ガイド等を除外
 *  4) ISBN13 が取れている（PA-API側のISBNを正とする）
 *
 * NDL候補ISBN → PA-API GetItems(ISBN) で検証して通ったものだけ確定。
 */
function isConfirmedVol1({ seriesKey, title }) {
  const t = norm(title);
  if (!t) return false;
  if (!t.includes(seriesKey)) return false;
  if (!isVol1Like(t)) return false;
  if (isLikelySingleEpisode(t)) return false;
  if (isDerivedOrGuide(t)) return false;
  return true;
}

async function main() {
  const seeds = await loadJson(SEEDS_PATH, { items: [] });
  const seedItems = Array.isArray(seeds?.items) ? seeds.items : [];

  const confirmed = [];
  const todo = [];
  const debug = [];

  for (const s of seedItems) {
    const seriesKey = norm(s?.seriesKey);
    if (!seriesKey) continue;

    const author = norm(s?.author) || null;

    // 1) NDLで候補ISBNを作る（ただし“確定”はしない）
    let ndl;
    try {
      ndl = await ndlSearchOpen({ seriesKey });
    } catch (e) {
      ndl = { error: true, message: String(e?.message || e) };
    }

    const ndlCands = Array.isArray(ndl?.candidates) ? ndl.candidates : [];
    const ndlIsbns = ndlCands
      .map((c) => c?.isbn13)
      .filter((x) => /^97[89]\d{10}$/.test(String(x || "")));

    const uniqIsbns = [...new Set(ndlIsbns)].slice(0, 10);

    // 2) NDL候補ISBNがあるなら PA-API GetItems(ISBN) でタイトル検証
    let getitems = null;
    let getitemsErr = null;

    if (uniqIsbns.length) {
      const res = await paapiGetItemsByIsbn({ isbns: uniqIsbns });
      if (res?.skipped) {
        getitemsErr = { skipped: true, reason: res.reason };
      } else if (!res?.ok) {
        getitemsErr = { ok: false, status: res.status, body: res.body };
      } else {
        getitems = res.json;
      }
      await sleep(600);
    }

    // 3) GetItems結果から“確定できる1巻”を探す
    const giItems = getitems?.ItemResult?.Items || getitems?.ItemsResult?.Items || getitems?.Items || [];
    const okOnAmazon = [];

    for (const it of giItems) {
      const title = extractTitle(it);
      const isbn13 = extractIsbn13(it);
      const image = extractImage(it);
      const amazonDp = extractDetailUrl(it);
      const asin = extractAsin(it);

      if (!isbn13) continue;
      if (!isConfirmedVol1({ seriesKey, title })) continue;

      okOnAmazon.push({
        title,
        isbn13,
        asin,
        image,
        amazonDp,
      });
    }

    // 4) 確定（最初の1件だけ採用）
    if (okOnAmazon.length) {
      const best = okOnAmazon[0];
      confirmed.push({
        seriesKey,
        author,
        vol1: {
          title: best.title,
          isbn13: best.isbn13,
          image: best.image || null,
          amazonDp: best.amazonDp || (best.asin ? `https://www.amazon.co.jp/dp/${best.asin}` : null),
          source: "ndl_open + paapi_getitems(isbn)",
        },
      });
      debug.push({
        seriesKey,
        step: "ndl_then_paapi_getitems",
        ndl: { query: ndl?.query, url: ndl?.url, candidates: ndlCands, dropped: ndl?.dropped ?? null },
        paapi: { triedIsbns: uniqIsbns, getitemsErr, matched: okOnAmazon },
      });
      await sleep(300);
      continue;
    }

    // 5) NDL→GetItemsで取れない場合だけ、PA-API SearchItems を“保険”で使う
    const searchTries = [`${seriesKey} 1`, `${seriesKey} （1）`];
    const searchResults = [];
    let foundFromSearch = null;

    for (const kw of searchTries) {
      const res = await paapiSearchItems({ keywords: kw });
      if (res?.skipped) {
        searchResults.push({ query: kw, ok: false, skipped: true, reason: res.reason });
        continue;
      }
      if (!res?.ok) {
        searchResults.push({ query: kw, ok: false, status: res.status, body: res.body });
        continue;
      }

      const items = res?.json?.SearchResult?.Items || [];
      for (const it of items) {
        const title = extractTitle(it);
        const isbn13 = extractIsbn13(it);
        const image = extractImage(it);
        const amazonDp = extractDetailUrl(it);
        const asin = extractAsin(it);

        if (!isbn13) continue;
        if (!isConfirmedVol1({ seriesKey, title })) continue;

        foundFromSearch = { title, isbn13, asin, image, amazonDp };
        break;
      }

      searchResults.push({ query: kw, ok: true, returned: items.length, found: !!foundFromSearch });
      await sleep(900);
      if (foundFromSearch) break;
    }

    if (foundFromSearch) {
      confirmed.push({
        seriesKey,
        author,
        vol1: {
          title: foundFromSearch.title,
          isbn13: foundFromSearch.isbn13,
          image: foundFromSearch.image || null,
          amazonDp:
            foundFromSearch.amazonDp ||
            (foundFromSearch.asin ? `https://www.amazon.co.jp/dp/${foundFromSearch.asin}` : null),
          source: "paapi_searchitems(fallback)",
        },
      });

      debug.push({
        seriesKey,
        step: "paapi_search_fallback",
        ndl: { query: ndl?.query, url: ndl?.url, candidates: ndlCands, dropped: ndl?.dropped ?? null },
        paapi: { searchTries, searchResults, foundFromSearch },
      });
    } else {
      todo.push({
        seriesKey,
        author,
        reason: `not_confirmed(ndlCandidates=${ndlCands.length}, ndlIsbns=${uniqIsbns.length}, paapiGetItemsMatched=0)`,
        best: uniqIsbns.length
          ? { source: "ndl_open", triedIsbns: uniqIsbns }
          : { source: "none", triedIsbns: [] },
      });

      debug.push({
        seriesKey,
        step: "todo",
        ndl: { query: ndl?.query, url: ndl?.url, candidates: ndlCands, dropped: ndl?.dropped ?? null, error: ndl?.error ?? null },
        paapi: { triedIsbns: uniqIsbns, getitemsErr, searchTries, searchResults },
      });
    }

    await sleep(400);
  }

  await saveJson(OUT_SERIES, {
    updatedAt: nowIso(),
    total: seedItems.length,
    confirmed: confirmed.length,
    todo: todo.length,
    items: confirmed,
  });

  await saveJson(OUT_TODO, {
    updatedAt: nowIso(),
    total: todo.length,
    items: todo,
  });

  await saveJson(OUT_DEBUG, {
    updatedAt: nowIso(),
    items: debug,
  });

  console.log(`[lane2] seeds=${seedItems.length} confirmed=${confirmed.length} todo=${todo.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
