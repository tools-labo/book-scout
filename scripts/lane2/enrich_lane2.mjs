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
 * Amazon PA-API（公式APIのみ）
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

async function paapiRequest({ target, pathUri, bodyObj }) {
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
  if (!r.ok) return { error: true, status: r.status, body: text.slice(0, 1400) };
  return { ok: true, json: JSON.parse(text) };
}

const ENRICH_RESOURCES = [
  // 表示・同定
  "ItemInfo.Title",
  "ItemInfo.ByLineInfo",
  "ItemInfo.ExternalIds",
  "Images.Primary.Large",

  // 発売日（取れる場合）
  "ItemInfo.ContentInfo",

  // 説明文（取れる場合）
  "EditorialReviews",
];

async function paapiGetItems({ itemIds }) {
  return paapiRequest({
    target: "com.amazon.paapi5.v1.ProductAdvertisingAPIv1.GetItems",
    pathUri: "/paapi5/getitems",
    bodyObj: {
      ItemIds: itemIds,
      PartnerTag: AMZ_PARTNER_TAG,
      PartnerType: "Associates",
      Resources: ENRICH_RESOURCES,
    },
  });
}

async function paapiSearchItems({ keywords }) {
  return paapiRequest({
    target: "com.amazon.paapi5.v1.ProductAdvertisingAPIv1.SearchItems",
    pathUri: "/paapi5/searchitems",
    bodyObj: {
      Keywords: keywords,
      SearchIndex: "Books",
      ItemCount: 10,
      PartnerTag: AMZ_PARTNER_TAG,
      PartnerType: "Associates",
      Resources: ENRICH_RESOURCES,
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
  // Brand/Manufacturer は lane2 でも見えてたので同様に拾う
  const brand = item?.ItemInfo?.ByLineInfo?.Brand?.DisplayValue || "";
  const manu = item?.ItemInfo?.ByLineInfo?.Manufacturer?.DisplayValue || "";
  return { brand: norm(brand) || null, manufacturer: norm(manu) || null };
}
function extractPublicationDate(item) {
  // ContentInfo.PublicationDate は環境や商品で出たり出なかったりする
  const d = item?.ItemInfo?.ContentInfo?.PublicationDate?.DisplayValue;
  const s = norm(d);
  return s || null; // 例: "2022-06-10" みたいなのが来ることがある
}
function extractDescription(item) {
  // EditorialReviews は複数来ることがある
  const ed = item?.EditorialReviews?.EditorialReview;
  if (!Array.isArray(ed)) return null;
  const texts = ed
    .map((x) => norm(x?.Content))
    .filter(Boolean)
    .slice(0, 2); // 長くなりすぎるのを抑える（必要なら後で調整）
  if (!texts.length) return null;
  return texts.join("\n\n");
}

/**
 * isbn13 -> SearchItems で ASIN を引く（紙/Kindle混在はあり得るので first-hit だけ採用）
 * 目的は「GetItemsを叩けるASINに変換」なので、同定は lane2 側で担保済みという前提。
 */
async function findAsinByIsbn13(isbn13) {
  const q = norm(isbn13);
  if (!q) return { ok: false, reason: "missing_isbn13" };

  const s = await paapiSearchItems({ keywords: q });
  if (s?.skipped) return { ok: false, reason: `paapi_skipped(${s.reason})`, raw: s };
  if (s?.error) return { ok: false, reason: `paapi_search_error(${s.status})`, raw: s };

  const items = s?.json?.SearchResult?.Items || [];
  const hit =
    items.find((it) => {
      const e = extractIsbn13(it);
      return e === q;
    }) ||
    items.find((it) => !!it?.ASIN) ||
    null;

  return hit?.ASIN ? { ok: true, asin: hit.ASIN, raw: s } : { ok: false, reason: "no_asin_found", raw: s };
}

async function getItemByAsin(asin) {
  const a = norm(asin);
  if (!a) return { ok: false, reason: "missing_asin" };

  const g = await paapiGetItems({ itemIds: [a] });
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

  for (const it of items) {
    const seriesKey = norm(it?.seriesKey);
    const author = norm(it?.author) || null;

    const vol1 = it?.vol1 || {};
    const lane2Title = norm(vol1?.title) || null;
    const isbn13 = norm(vol1?.isbn13) || null;

    // lane2 の amazonDp は dp/ISBN13 になってる場合があるので
    // enrich では ASIN を決めて dp/ASIN を作る
    let asin = null;

    // まず lane2 の amazonDp から ASINっぽいものを抜く（dp/XXXX）
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

    // ASINがなければ ISBN13 で ASIN を引く
    if (!asin && isbn13) {
      const r = await findAsinByIsbn13(isbn13);
      one.steps.findAsinByIsbn13 = r;
      if (r?.ok) asin = r.asin;
    }

    if (!asin) {
      one.ok = false;
      one.reason = "cannot_resolve_asin";
      debug.push(one);
      // 次へ（enrich 失敗しても lane2 は壊さない）
      await sleep(500);
      continue;
    }

    // GetItems で最終情報取得（ここで title も再取得＝確定）
    const g = await getItemByAsin(asin);
    one.steps.getItemByAsin = { ok: g.ok, reason: g.reason || null, asin, raw: g.raw };
    if (!g.ok) {
      one.ok = false;
      one.reason = g.reason || "getitems_failed";
      debug.push(one);
      await sleep(500);
      continue;
    }

    const itemObj = g.item;
    const finalTitle = norm(extractTitle(itemObj)) || lane2Title || null;

    // isbn13 は lane2 の同定結果を基本にしつつ、PA-APIが返すなら上書き可
    const isbn13FromPa = extractIsbn13(itemObj);
    const finalIsbn13 = isbn13FromPa || isbn13 || null;

    const image = extractImage(itemObj) || null;
    const contributors = extractContributors(itemObj);
    const pub = extractPublisher(itemObj);
    const releaseDate = extractPublicationDate(itemObj);
    const description = extractDescription(itemObj);

    const out = {
      seriesKey,
      author,
      vol1: {
        title: finalTitle,
        titleLane2: lane2Title, // 監査用に残す（表示は title を使う）
        isbn13: finalIsbn13,
        asin,
        image,
        amazonDp: dpFromAsin(asin),
        publisher: pub,
        contributors,
        releaseDate,
        description,
        source: "enrich(paapi_getitems_by_asin)",
      },
    };

    one.ok = true;
    one.output = out;
    enriched.push(out);
    debug.push(one);

    // PA-APIの負荷避け
    await sleep(900);
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
