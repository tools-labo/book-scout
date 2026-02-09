// scripts/lane2/enrich_lane2.mjs
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const IN_SERIES = "data/lane2/series.json";
const OUT_ENRICHED = "data/lane2/enriched.json";
const OUT_DEBUG = "data/lane2/debug_enrich.json";

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
function dpFromAsin(asin) {
  const a = norm(asin);
  if (!a) return null;
  if (/^[A-Z0-9]{10}$/i.test(a)) return `https://www.amazon.co.jp/dp/${a.toUpperCase()}`;
  if (/^\d{10}$/.test(a)) return `https://www.amazon.co.jp/dp/${a}`;
  return null;
}

/* -----------------------
 * Amazon PA-API
 * ----------------------- */
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
  return { amzDate: `${y}${m}${day}T${hh}${mm}${ss}Z`, dateStamp: `${y}${m}${day}` };
}

function isInvalidResourcesError(bodyText) {
  const s = String(bodyText || "");
  return s.includes("ValidationException") && s.includes("InvalidParameterValue") && s.includes("Resources");
}

async function paapiRequest({ target, pathUri, bodyObj, retry = 0 }) {
  if (!AMZ_ACCESS_KEY || !AMZ_SECRET_KEY || !AMZ_PARTNER_TAG) {
    return { skipped: true, reason: "missing_paapi_secrets" };
  }

  const host = "webservices.amazon.co.jp";
  const region = "us-west-2";
  const service = "ProductAdvertisingAPI";
  const endpoint = `https://${host}${pathUri}`;
  const body = JSON.stringify(bodyObj);

  const { amzDate: xAmzDate, dateStamp } = amzDate();
  const method = "POST";
  const canonicalUri = pathUri;
  const canonicalQuerystring = "";
  const canonicalHeaders =
    `content-encoding:amz-1.0\ncontent-type:application/json; charset=utf-8\nhost:${host}\nx-amz-date:${xAmzDate}\nx-amz-target:${target}\n`;
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
  const stringToSign = [algorithm, xAmzDate, credentialScope, awsHash(canonicalRequest)].join("\n");

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
      "x-amz-target": target,
      Authorization: authorizationHeader,
    },
    body,
  });

  const text = await r.text();

  // 429: 指数バックオフでリトライ
  if (r.status === 429 && retry < 5) {
    const wait = 1200 * Math.pow(2, retry); // 1.2s, 2.4s, 4.8s, 9.6s, 19.2s
    await sleep(wait);
    return paapiRequest({ target, pathUri, bodyObj, retry: retry + 1 });
  }

  if (!r.ok) return { error: true, status: r.status, body: text.slice(0, 1600) };
  return { ok: true, json: JSON.parse(text) };
}

// まずは lane2 で実績ある最小セットだけ（成功優先）
const RESOURCES_MIN = [
  "ItemInfo.Title",
  "ItemInfo.ExternalIds",
  "ItemInfo.ByLineInfo",
  "Images.Primary.Large",
];

// 将来拡張用（いまは使わない：無効で落ちたため）
// const RESOURCES_FULL = [...RESOURCES_MIN, "ItemInfo.ContentInfo", "EditorialReviews"];

async function paapiGetItems({ itemIds, resources }) {
  return paapiRequest({
    target: "com.amazon.paapi5.v1.ProductAdvertisingAPIv1.GetItems",
    pathUri: "/paapi5/getitems",
    bodyObj: {
      ItemIds: itemIds,
      PartnerTag: AMZ_PARTNER_TAG,
      PartnerType: "Associates",
      Resources: resources,
    },
  });
}

async function paapiSearchItems({ keywords, resources }) {
  return paapiRequest({
    target: "com.amazon.paapi5.v1.ProductAdvertisingAPIv1.SearchItems",
    pathUri: "/paapi5/searchitems",
    bodyObj: {
      Keywords: keywords,
      SearchIndex: "Books",
      ItemCount: 10,
      PartnerTag: AMZ_PARTNER_TAG,
      PartnerType: "Associates",
      Resources: resources,
    },
  });
}

function extractTitle(item) {
  return item?.ItemInfo?.Title?.DisplayValue || "";
}
function extractImage(item) {
  return item?.Images?.Primary?.Large?.URL || null;
}
function extractIsbn13(item) {
  const eans = item?.ItemInfo?.ExternalIds?.EANs?.DisplayValues;
  if (Array.isArray(eans) && eans.length) {
    const v = String(eans[0]).replace(/[^0-9]/g, "");
    if (/^97[89]\d{10}$/.test(v)) return v;
  }
  const isbns = item?.ItemInfo?.ExternalIds?.ISBNs?.DisplayValues;
  if (Array.isArray(isbns) && isbns.length) {
    const v = String(isbns[0]).replace(/[^0-9]/g, "");
    if (/^97[89]\d{10}$/.test(v)) return v;
  }
  return null;
}
function extractContributors(item) {
  const arr = item?.ItemInfo?.ByLineInfo?.Contributors;
  if (!Array.isArray(arr)) return [];
  return arr
    .map((c) => ({
      name: norm(c?.Name),
      role: norm(c?.Role),
      roleType: norm(c?.RoleType),
    }))
    .filter((x) => x.name);
}
function extractPublisher(item) {
  const brand = item?.ItemInfo?.ByLineInfo?.Brand?.DisplayValue || "";
  const manu = item?.ItemInfo?.ByLineInfo?.Manufacturer?.DisplayValue || "";
  return { brand: norm(brand) || null, manufacturer: norm(manu) || null };
}

/**
 * isbn13 -> SearchItems で ASIN を引く
 * 目的は GetItems を叩ける ASIN を得ること
 */
async function findAsinByIsbn13(isbn13) {
  const q = norm(isbn13);
  if (!q) return { ok: false, reason: "missing_isbn13" };

  const s = await paapiSearchItems({ keywords: q, resources: RESOURCES_MIN });
  if (s?.skipped) return { ok: false, reason: `paapi_skipped(${s.reason})`, raw: s };
  if (s?.error) return { ok: false, reason: `paapi_search_error(${s.status})`, raw: s };

  const items = s?.json?.SearchResult?.Items || [];
  const hit =
    items.find((it) => extractIsbn13(it) === q) ||
    items.find((it) => !!it?.ASIN) ||
    null;

  return hit?.ASIN ? { ok: true, asin: hit.ASIN, raw: s } : { ok: false, reason: "no_asin_found", raw: s };
}

/**
 * ASIN -> GetItems（Resources エラーはフォールバック）
 */
async function getItemByAsin(asin) {
  const a = norm(asin);
  if (!a) return { ok: false, reason: "missing_asin" };

  // まず最小セットで GetItems（成功優先）
  let g = await paapiGetItems({ itemIds: [a], resources: RESOURCES_MIN });

  // もし Resources が原因で落ちるなら（保険：今後 resources 増やした時も落ちない）
  if (g?.error && g.status === 400 && isInvalidResourcesError(g.body)) {
    g = await paapiGetItems({ itemIds: [a], resources: RESOURCES_MIN });
  }

  if (g?.skipped) return { ok: false, reason: `paapi_skipped(${g.reason})`, raw: g };
  if (g?.error) return { ok: false, reason: `paapi_getitems_error(${g.status})`, raw: g };

  const item = g?.json?.ItemsResult?.Items?.[0] || null;
  return item ? { ok: true, item, raw: g } : { ok: false, reason: "no_item_returned", raw: g };
}

/* -----------------------
 * main
 * ----------------------- */
async function main() {
  const series = await loadJson(IN_SERIES, { items: [] });
  const items = Array.isArray(series?.items) ? series.items : [];

  const enriched = [];
  const debug = [];

  // build の直後に enrich なので、ここは少し間を空ける（429回避）
  await sleep(1200);

  for (const it of items) {
    const seriesKey = norm(it?.seriesKey);
    const author = norm(it?.author) || null;

    const vol1 = it?.vol1 || {};
    const lane2Title = norm(vol1?.title) || null;
    const isbn13 = norm(vol1?.isbn13) || null;

    let asin = null;

    // lane2 の amazonDp が dp/XXXX ならそれを ASIN とみなす（10桁）
    const dp = norm(vol1?.amazonDp);
    const m = dp.match(/\/dp\/([A-Z0-9]{10})/i);
    if (m) asin = m[1].toUpperCase();

    const one = {
      seriesKey,
      author,
      input: {
        lane2Title,
        isbn13,
        amazonDp: dp || null,
        source: norm(vol1?.source) || null,
      },
      steps: {},
      ok: false,
      reason: null,
      output: null,
    };

    // ASINがなければ ISBN13 で引く
    if (!asin && isbn13) {
      const r = await findAsinByIsbn13(isbn13);
      one.steps.findAsinByIsbn13 = r;
      if (r?.ok) asin = r.asin;
    }

    if (!asin) {
      one.reason = "cannot_resolve_asin";
      debug.push(one);
      await sleep(900);
      continue;
    }

    // GetItems（最終タイトルをここで再取得）
    const g = await getItemByAsin(asin);
    one.steps.getItemByAsin = { ok: g.ok, reason: g.reason || null, asin, raw: g.raw };

    if (!g.ok) {
      one.reason = g.reason || "getitems_failed";
      debug.push(one);
      await sleep(900);
      continue;
    }

    const itemObj = g.item;
    const finalTitle = norm(extractTitle(itemObj)) || lane2Title || null;

    const isbn13FromPa = extractIsbn13(itemObj);
    const finalIsbn13 = isbn13FromPa || isbn13 || null;

    const image = extractImage(itemObj) || null;
    const contributors = extractContributors(itemObj);
    const pub = extractPublisher(itemObj);

    const out = {
      seriesKey,
      author,
      vol1: {
        // 表示用（PA-APIから再取得したタイトル）
        title: finalTitle,

        // 監査用（lane2側のタイトル）
        titleLane2: lane2Title,

        isbn13: finalIsbn13,
        asin,
        image,
        amazonDp: dpFromAsin(asin),
        publisher: pub,
        contributors,

        // ※説明文・発売日は PA-API Resources が確定してから追加（いまは成功優先）
        releaseDate: null,
        description: null,

        source: "enrich(paapi_getitems_by_asin)",
      },
    };

    one.ok = true;
    one.output = out;
    enriched.push(out);
    debug.push(one);

    // 429回避
    await sleep(1100);
  }

  await saveJson(OUT_ENRICHED, {
    updatedAt: nowIso(),
    total: items.length,
    enriched: enriched.length,
    items: enriched,
  });

  await saveJson(OUT_DEBUG, {
    updatedAt: nowIso(),
    total: items.length,
    ok: enriched.length,
    ng: items.length - enriched.length,
    items: debug,
  });

  console.log(`[lane2:enrich] total=${items.length} enriched=${enriched.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
