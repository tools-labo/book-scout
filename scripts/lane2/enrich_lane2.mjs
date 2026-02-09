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

function extractAsinFromAmazonDp(amazonDp) {
  const u = String(amazonDp ?? "");
  const m = u.match(/\/dp\/([A-Z0-9]{10})/i);
  return m ? m[1].toUpperCase() : null;
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

  const canonicalRequest = [method, canonicalUri, canonicalQuerystring, canonicalHeaders, signedHeaders, payloadHash].join("\n");
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
  if (!r.ok) return { error: true, status: r.status, body: text.slice(0, 1800) };
  return { ok: true, json: JSON.parse(text) };
}

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

function extractPublisher(item) {
  const brand = item?.ItemInfo?.ByLineInfo?.Brand?.DisplayValue || null;
  const manufacturer = item?.ItemInfo?.ByLineInfo?.Manufacturer?.DisplayValue || null;
  return { brand, manufacturer };
}
function extractContributors(item) {
  const arr = item?.ItemInfo?.ByLineInfo?.Contributors;
  if (!Array.isArray(arr)) return [];
  return arr
    .map((x) => ({
      name: x?.Name ?? null,
      role: x?.Role ?? null,
      roleType: x?.RoleType ?? null,
    }))
    .filter((x) => x.name);
}

// 出版日っぽいフィールドを “あるだけ拾う”
function extractReleaseDate(item) {
  // どれが取れるかは Resources 次第なので、候補を広めに
  const ci = item?.ItemInfo?.ContentInfo;
  const pi = item?.ItemInfo?.ProductInfo;

  const candidates = [
    ci?.PublicationDate?.DisplayValue,
    ci?.ReleaseDate?.DisplayValue,
    pi?.ReleaseDate?.DisplayValue,
    pi?.PublicationDate?.DisplayValue,
  ]
    .map((x) => (x == null ? null : String(x).trim()))
    .filter(Boolean);

  return candidates.length ? candidates[0] : null;
}

// 説明文（EditorialReviews）の取り出し（取れた時だけ）
function extractDescription(item) {
  const ers = item?.EditorialReviews?.EditorialReview;
  if (!Array.isArray(ers) || !ers.length) return null;

  // まずは “日本語っぽい/長い” を優先して拾う（安全側）
  const texts = ers
    .map((x) => x?.Content ?? x?.DisplayValue ?? null)
    .map((x) => (x == null ? null : String(x).trim()))
    .filter(Boolean);

  if (!texts.length) return null;

  texts.sort((a, b) => b.length - a.length);
  return texts[0] || null;
}

function isInvalidResourceError(rawBody) {
  const s = String(rawBody ?? "");
  return s.includes("InvalidParameterValue") && s.includes("provided in the request for Resources is invalid");
}

async function getItemWithResourceProbe({ asin, debugSteps }) {
  // まず確実に通る最小セット
  const base = [
    "ItemInfo.Title",
    "ItemInfo.ByLineInfo",
    "ItemInfo.ExternalIds",
    "Images.Primary.Large",
  ];

  // “欲しいもの”候補（JPで有効かは環境次第なので probe）
  // ※ここは「一個ずつ足して試す」方式
  const optionalCandidates = [
    "ItemInfo.ContentInfo",
    "ItemInfo.ProductInfo",
    // EditorialReviews は root or sub のどちらが許されるか環境で違う可能性があるので両方試す
    "EditorialReviews",
    "EditorialReviews.EditorialReview",
  ];

  let okJson = null;
  let okResources = base.slice();

  // 429はここで指数バックオフ
  async function callWithRetry(resources, label) {
    let wait = 900;
    for (let i = 0; i < 4; i++) {
      const res = await paapiGetItems({ itemIds: [asin], resources });
      if (res?.ok) return { ok: true, res };
      if (res?.skipped) return { ok: false, skipped: true, res };

      if (res?.error && res.status === 429) {
        debugSteps.retries = debugSteps.retries || [];
        debugSteps.retries.push({ label, attempt: i + 1, status: 429, waitMs: wait });
        await sleep(wait);
        wait *= 2;
        continue;
      }
      return { ok: false, res };
    }
    return { ok: false, res: { error: true, status: 429, body: "retry_exhausted" } };
  }

  // まず base で取得
  {
    const got = await callWithRetry(okResources, "base");
    debugSteps.base = got?.res ?? null;
    if (!got?.ok) return { ok: false, reason: got?.skipped ? `paapi_skipped(${got.res.reason})` : `paapi_getitems_error(${got?.res?.status ?? "unknown"})`, raw: got?.res };
    okJson = got.res.json;
  }

  // optional を 1個ずつ追加して試す（InvalidResourceなら捨てる）
  debugSteps.probe = [];
  for (const opt of optionalCandidates) {
    const trial = okResources.concat([opt]);
    const got = await callWithRetry(trial, `probe:${opt}`);

    if (got?.ok) {
      // 成功：採用
      okResources = trial;
      okJson = got.res.json;
      debugSteps.probe.push({ resource: opt, adopted: true });
      await sleep(650);
      continue;
    }

    // 無効 resource は捨てて次へ
    if (got?.res?.error && got.res.status === 400 && isInvalidResourceError(got.res.body)) {
      debugSteps.probe.push({ resource: opt, adopted: false, reason: "invalid_resource" });
      await sleep(650);
      continue;
    }

    // それ以外の失敗は “採用せず次へ” に倒す（enrich 全体が止まるよりマシ）
    debugSteps.probe.push({ resource: opt, adopted: false, reason: `error(${got?.res?.status ?? "unknown"})` });
    await sleep(650);
  }

  const item = okJson?.ItemsResult?.Items?.[0] || null;
  if (!item) return { ok: false, reason: "no_item", raw: okJson };

  return { ok: true, item, usedResources: okResources };
}

async function main() {
  const series = await loadJson(IN_SERIES, { items: [] });
  const items = Array.isArray(series?.items) ? series.items : [];

  const enriched = [];
  const debug = [];

  let ok = 0;
  let ng = 0;

  for (const x of items) {
    const seriesKey = norm(x?.seriesKey);
    const author = norm(x?.author);
    const lane2Title = x?.vol1?.title ?? null;
    const isbn13 = x?.vol1?.isbn13 ?? null;
    const amazonDp = x?.vol1?.amazonDp ?? null;

    const one = {
      seriesKey,
      author,
      input: {
        lane2Title,
        isbn13,
        amazonDp,
        source: x?.vol1?.source ?? null,
      },
      steps: {},
      ok: false,
      reason: null,
      output: null,
    };

    const asin = extractAsinFromAmazonDp(amazonDp);
    if (!asin) {
      one.reason = "no_asin_in_amazonDp";
      debug.push(one);
      ng++;
      await sleep(350);
      continue;
    }

    const step = {};
    const got = await getItemWithResourceProbe({ asin, debugSteps: step });
    one.steps.getItemByAsin = {
      ok: !!got.ok,
      reason: got.ok ? null : got.reason,
      asin,
      raw: got.ok ? { usedResources: got.usedResources } : got.raw,
      probe: step.probe || null,
      retries: step.retries || null,
    };

    if (!got.ok) {
      one.ok = false;
      one.reason = got.reason;
      debug.push(one);
      ng++;
      await sleep(650);
      continue;
    }

    const item = got.item;

    const paTitle = extractTitle(item) || null;
    const paIsbn13 = extractIsbn13(item) || null;

    // ここが重要：最終タイトルは PA-API 正
    const finalTitle = paTitle || lane2Title || seriesKey || null;

    const out = {
      seriesKey,
      author,
      vol1: {
        title: finalTitle,          // ★正
        titleLane2: lane2Title,     // ★監査用
        isbn13: paIsbn13 || isbn13 || null,
        asin,
        image: extractImage(item) || null,
        amazonDp: `https://www.amazon.co.jp/dp/${asin}`,
        publisher: extractPublisher(item),
        contributors: extractContributors(item),
        releaseDate: extractReleaseDate(item),     // 取れた時だけ入る
        description: extractDescription(item),     // 取れた時だけ入る
        source: "enrich(paapi_getitems_probe_by_asin)",
      },
    };

    one.ok = true;
    one.output = out;
    debug.push(one);
    enriched.push(out);
    ok++;

    // 安全な間隔
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
    ok,
    ng,
    items: debug,
  });

  console.log(`[lane2:enrich] total=${items.length} enriched=${enriched.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
