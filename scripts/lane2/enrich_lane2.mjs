// scripts/lane2/enrich_lane2.mjs
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const IN_SERIES = "data/lane2/series.json";
const OUT_ENRICHED = "data/lane2/enriched.json";
const OUT_DEBUG = "data/lane2/debug_enrich.json";

// 軽キャッシュ（Actionsでも効く：リポジトリに残る）
const CACHE_DIR = "data/lane2/cache";
const CACHE_OPENBD = `${CACHE_DIR}/openbd.json`;
const CACHE_WIKI = `${CACHE_DIR}/wiki.json`;
const CACHE_PAAPI = `${CACHE_DIR}/paapi.json`; // ISBN13→ASIN 解決キャッシュ

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
  return norm(s).replace(/\s+/g, "");
}
function toHalfWidth(s) {
  return String(s ?? "")
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[（]/g, "(")
    .replace(/[）]/g, ")")
    .replace(/[　]/g, " ");
}
function isJaLikeText(s) {
  const t = norm(s);
  if (!t) return false;
  return /[ぁ-ゖァ-ヺ一-龯]/.test(t);
}

// dp から「10桁ASIN or 13桁ISBN」を安全に取り出す
function parseAmazonDpId(amazonDp) {
  const u = String(amazonDp ?? "");
  const m = u.match(/\/dp\/([A-Z0-9]{10,13})/i);
  if (!m) return { asin: null, isbn13FromDp: null };

  const id = m[1].toUpperCase();

  if (/^[A-Z0-9]{10}$/.test(id)) return { asin: id, isbn13FromDp: null };
  if (/^\d{13}$/.test(id)) return { asin: null, isbn13FromDp: id };

  return { asin: null, isbn13FromDp: null };
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

// ISBN13→ASIN解決用
async function paapiSearchItems({ keywords, resources, itemCount = 10 }) {
  return paapiRequest({
    target: "com.amazon.paapi5.v1.ProductAdvertisingAPIv1.SearchItems",
    pathUri: "/paapi5/searchitems",
    bodyObj: {
      Keywords: keywords,
      SearchIndex: "Books",
      ItemCount: itemCount,
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
function extractReleaseDate(item) {
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

async function getItemSafe({ asin, debugSteps }) {
  // EditorialReviews は使わない（英語＆invalidが多い）
  const resources = [
    "ItemInfo.Title",
    "ItemInfo.ByLineInfo",
    "ItemInfo.ExternalIds",
    "Images.Primary.Large",
    "ItemInfo.ContentInfo",
    "ItemInfo.ProductInfo",
  ];

  let wait = 900;
  for (let i = 0; i < 4; i++) {
    const res = await paapiGetItems({ itemIds: [asin], resources });
    if (res?.ok) {
      const item = res?.json?.ItemsResult?.Items?.[0] || null;
      if (!item) return { ok: false, reason: "no_item", raw: res?.json };
      return { ok: true, item, usedResources: resources };
    }
    if (res?.skipped) return { ok: false, reason: `paapi_skipped(${res.reason})`, raw: res };

    if (res?.error && res.status === 429) {
      debugSteps.retries = debugSteps.retries || [];
      debugSteps.retries.push({ label: "paapi_getitems", attempt: i + 1, status: 429, waitMs: wait });
      await sleep(wait);
      wait *= 2;
      continue;
    }
    return { ok: false, reason: `paapi_getitems_error(${res?.status ?? "unknown"})`, raw: res };
  }
  return { ok: false, reason: "paapi_getitems_retry_exhausted", raw: { status: 429 } };
}

// ISBN13→ASIN解決（SearchItemsでEAN一致）
async function resolveAsinByIsbn13({ isbn13, cache, debugSteps }) {
  const key = norm(isbn13);
  if (!/^97[89]\d{10}$/.test(key)) return { ok: false, reason: "invalid_isbn13" };

  if (cache[key]) {
    debugSteps.paapiResolve = { cached: true, asin: cache[key] };
    return { ok: true, asin: cache[key], cached: true };
  }

  const resources = ["ItemInfo.ExternalIds", "ItemInfo.Title"];
  let wait = 900;

  for (let i = 0; i < 4; i++) {
    const res = await paapiSearchItems({ keywords: key, resources, itemCount: 10 });

    if (res?.skipped) {
      debugSteps.paapiResolve = { cached: false, ok: false, skipped: true, reason: res.reason };
      return { ok: false, reason: `paapi_skipped(${res.reason})` };
    }

    if (res?.error && res.status === 429) {
      debugSteps.retries = debugSteps.retries || [];
      debugSteps.retries.push({ label: "paapi_search_isbn13", attempt: i + 1, status: 429, waitMs: wait });
      await sleep(wait);
      wait *= 2;
      continue;
    }

    if (!res?.ok) {
      debugSteps.paapiResolve = { cached: false, ok: false, status: res?.status ?? "unknown", body: res?.body ?? null };
      return { ok: false, reason: `paapi_search_error(${res?.status ?? "unknown"})` };
    }

    const items = res?.json?.SearchResult?.Items || [];
    const hit =
      items.find((it) => {
        const e = extractIsbn13(it);
        return e === key;
      }) || null;

    const asin = hit?.ASIN || null;
    debugSteps.paapiResolve = { cached: false, ok: true, found: !!asin, returned: items.length, asin };

    if (asin) {
      cache[key] = asin;
      return { ok: true, asin, cached: false };
    }

    return { ok: false, reason: "asin_not_found_by_isbn13" };
  }

  return { ok: false, reason: "paapi_search_retry_exhausted" };
}

/* -----------------------
 * openBD（公式APIのみ）
 * ----------------------- */
function stripHtml(s) {
  const x = String(s ?? "");
  return x
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function fetchOpenBdByIsbn13({ isbn13, cache, debugSteps }) {
  if (!isbn13) return { ok: false, reason: "no_isbn13" };

  if (Object.prototype.hasOwnProperty.call(cache, isbn13)) {
    debugSteps.openbd = { cached: true };
    return { ok: true, data: cache[isbn13], cached: true };
  }

  const url = `https://api.openbd.jp/v1/get?isbn=${encodeURIComponent(isbn13)}`;
  let r;
  try {
    r = await fetch(url, { headers: { "user-agent": "tools-labo/book-scout lane2 openbd" } });
  } catch (e) {
    debugSteps.openbd = { cached: false, ok: false, error: String(e?.message || e) };
    return { ok: false, reason: "openbd_fetch_error" };
  }

  if (!r.ok) {
    debugSteps.openbd = { cached: false, ok: false, status: r.status };
    return { ok: false, reason: `openbd_http_${r.status}` };
  }

  let json;
  try {
    json = await r.json();
  } catch {
    debugSteps.openbd = { cached: false, ok: false, reason: "json_parse_error" };
    return { ok: false, reason: "openbd_json_parse_error" };
  }

  const first = Array.isArray(json) ? json[0] : null;

  cache[isbn13] = first ?? null;
  debugSteps.openbd = { cached: false, ok: true, found: !!first };
  return { ok: true, data: first ?? null, found: !!first };
}

function extractFromOpenBd(openbdObj) {
  if (!openbdObj) return { summary: null, pubdate: null, publisher: null };

  const summary = openbdObj?.summary || null;
  const onix = openbdObj?.onix || null;

  const raw =
    summary?.description ||
    summary?.content ||
    onix?.CollateralDetail?.TextContent?.[0]?.Text ||
    null;

  const pubdate = summary?.pubdate || null;
  const publisher = summary?.publisher || null;

  const text = raw ? stripHtml(raw) : null;

  return {
    summary: text && isJaLikeText(text) ? text : null,
    pubdate: pubdate ? String(pubdate).trim() : null,
    publisher: publisher ? String(publisher).trim() : null,
  };
}

/* -----------------------
 * Wikipedia（公式APIのみ、スクレイピングなし）
 * - まず search (MediaWiki API)
 * - 次に REST summary API
 * ----------------------- */
function wikiBadTitle(title) {
  const t = String(title || "");
  if (!t) return true;
  // 一覧/曖昧さ回避/カテゴリ/テンプレ/年号…っぽいのは落とす（安全側）
  if (/一覧|曖昧さ回避|Category:|Template:|Portal:|Help:|年の/.test(t)) return true;
  return false;
}

function scoreWikiHit({ seriesKey, hit }) {
  const s = normLoose(toHalfWidth(seriesKey));
  const t = normLoose(toHalfWidth(hit?.title || ""));
  const snip = normLoose(toHalfWidth(stripHtml(hit?.snippet || "")));

  let score = 0;
  if (t === s) score += 1000;
  if (t.includes(s)) score += 350;
  if (snip.includes(s)) score += 120;

  // 漫画/作品っぽさを少し加点（過学習しない）
  if (/(漫画|コミック|作品|連載)/.test(`${hit?.title || ""} ${hit?.snippet || ""}`)) score += 40;

  // 悪いタイトルは大きく減点
  if (wikiBadTitle(hit?.title)) score -= 1000;

  return score;
}

async function wikiSearchTitle({ seriesKey, debugSteps }) {
  const q = norm(seriesKey);
  if (!q) return { ok: false, reason: "no_seriesKey" };

  // MediaWiki API（CORS用 origin=*、公式）
  const params = new URLSearchParams();
  params.set("action", "query");
  params.set("list", "search");
  params.set("srsearch", q);
  params.set("format", "json");
  params.set("origin", "*");
  params.set("srlimit", "10");

  const url = `https://ja.wikipedia.org/w/api.php?${params.toString()}`;

  let r;
  try {
    r = await fetch(url, { headers: { "user-agent": "tools-labo/book-scout lane2 wiki" } });
  } catch (e) {
    debugSteps.wikiSearch = { ok: false, error: String(e?.message || e) };
    return { ok: false, reason: "wiki_search_fetch_error" };
  }

  if (!r.ok) {
    debugSteps.wikiSearch = { ok: false, status: r.status };
    return { ok: false, reason: `wiki_search_http_${r.status}` };
  }

  let json;
  try {
    json = await r.json();
  } catch {
    debugSteps.wikiSearch = { ok: false, reason: "json_parse_error" };
    return { ok: false, reason: "wiki_search_json_parse_error" };
  }

  const hits = json?.query?.search;
  if (!Array.isArray(hits) || !hits.length) {
    debugSteps.wikiSearch = { ok: true, found: false };
    return { ok: true, found: false, title: null, url };
  }

  const ranked = hits
    .map((h) => ({ h, score: scoreWikiHit({ seriesKey, hit: h }) }))
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

  const best = ranked[0]?.h || null;
  const title = best?.title || null;

  debugSteps.wikiSearch = {
    ok: true,
    found: !!title,
    pickedScore: ranked[0]?.score ?? null,
    title,
    sample: ranked.slice(0, 3).map((x) => ({ title: x.h?.title, score: x.score })),
  };

  if (!title || wikiBadTitle(title)) return { ok: true, found: false, title: null, url };
  return { ok: true, found: true, title, url };
}

async function wikiFetchSummaryByTitle({ title, debugSteps }) {
  const t = norm(title);
  if (!t) return { ok: false, reason: "no_title" };

  const url = `https://ja.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(t)}`;

  let r;
  try {
    r = await fetch(url, { headers: { "user-agent": "tools-labo/book-scout lane2 wiki" } });
  } catch (e) {
    debugSteps.wikiSummary = { ok: false, error: String(e?.message || e) };
    return { ok: false, reason: "wiki_summary_fetch_error" };
  }

  if (!r.ok) {
    debugSteps.wikiSummary = { ok: false, status: r.status };
    return { ok: false, reason: `wiki_summary_http_${r.status}` };
  }

  let json;
  try {
    json = await r.json();
  } catch {
    debugSteps.wikiSummary = { ok: false, reason: "json_parse_error" };
    return { ok: false, reason: "wiki_summary_json_parse_error" };
  }

  // REST summaryの本文は extract
  const extract = norm(json?.extract || "");
  const summary = extract && isJaLikeText(extract) ? extract : null;

  debugSteps.wikiSummary = { ok: true, got: !!summary, title: json?.title || t };

  return {
    ok: true,
    summary,
    pageTitle: json?.title || t,
  };
}

async function fetchWikiBySeriesKey({ seriesKey, cache, debugSteps }) {
  const key = norm(seriesKey);
  if (!key) return { ok: false, reason: "no_seriesKey" };

  if (Object.prototype.hasOwnProperty.call(cache, key)) {
    debugSteps.wiki = { cached: true };
    return { ok: true, data: cache[key], cached: true };
  }

  const step = {};
  const s = await wikiSearchTitle({ seriesKey: key, debugSteps: step });
  if (!s?.ok || !s?.found || !s.title) {
    cache[key] = null;
    debugSteps.wiki = { cached: false, ok: true, found: false, step };
    return { ok: true, found: false, data: null };
  }

  const sum = await wikiFetchSummaryByTitle({ title: s.title, debugSteps: step });
  const out = sum?.ok
    ? { title: sum.pageTitle || s.title, summary: sum.summary || null }
    : null;

  cache[key] = out ?? null;
  debugSteps.wiki = { cached: false, ok: true, found: !!(out && out.summary), step };

  return { ok: true, found: !!(out && out.summary), data: out };
}

/* -----------------------
 * main
 * ----------------------- */
async function main() {
  const series = await loadJson(IN_SERIES, { items: [] });
  const items = Array.isArray(series?.items) ? series.items : [];

  const cacheOpenbd = (await loadJson(CACHE_OPENBD, {})) || {};
  const cacheWiki = (await loadJson(CACHE_WIKI, {})) || {};
  const cachePaapi = (await loadJson(CACHE_PAAPI, {})) || {};

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

    // 0) dp から asin / isbn13 を取得
    const parsed = parseAmazonDpId(amazonDp);
    let asin = parsed.asin;
    const isbn13FromDp = parsed.isbn13FromDp;

    // 0.5) dpがISBN13だったら、SearchItemsでASIN解決（EAN一致）
    if (!asin) {
      const targetIsbn13 = isbn13FromDp || isbn13 || null;
      if (targetIsbn13) {
        const stepResolve = {};
        const rr = await resolveAsinByIsbn13({ isbn13: targetIsbn13, cache: cachePaapi, debugSteps: stepResolve });
        one.steps.resolveAsinByIsbn13 = {
          ok: !!rr.ok,
          reason: rr.ok ? null : rr.reason,
          isbn13: targetIsbn13,
          raw: stepResolve.paapiResolve || null,
          retries: stepResolve.retries || null,
        };
        if (rr.ok) asin = rr.asin;
      }
    }

    if (!asin) {
      one.reason = "no_asin_resolved";
      debug.push(one);
      ng++;
      await sleep(350);
      continue;
    }

    // 1) PA-API GetItems（タイトル正、書影、出版社、発売日など）
    const stepPa = {};
    const got = await getItemSafe({ asin, debugSteps: stepPa });
    one.steps.getItemByAsin = {
      ok: !!got.ok,
      reason: got.ok ? null : got.reason,
      asin,
      raw: got.ok ? { usedResources: got.usedResources } : got.raw,
      retries: stepPa.retries || null,
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
    const paReleaseDate = extractReleaseDate(item) || null;

    const finalTitle = paTitle || lane2Title || seriesKey || null;

    // 2) openBD（説明文の本命）
    const stepOpenbd = {};
    const ob = await fetchOpenBdByIsbn13({
      isbn13: paIsbn13 || isbn13 || isbn13FromDp || null,
      cache: cacheOpenbd,
      debugSteps: stepOpenbd,
    });
    one.steps.openbd = stepOpenbd.openbd || null;
    const obx = ob?.ok ? extractFromOpenBd(ob.data) : { summary: null, pubdate: null, publisher: null };

    // 3) Wikipedia（openBDが無い場合の日本語あらすじ）
    const stepWiki = {};
    const wk = await fetchWikiBySeriesKey({ seriesKey, cache: cacheWiki, debugSteps: stepWiki });
    one.steps.wiki = stepWiki.wiki || null;

    const wikiSummary = wk?.ok && wk?.data?.summary && isJaLikeText(wk.data.summary) ? wk.data.summary : null;

    // ★説明文は openBD → wiki のみ（英語は出さない）
    const openbdSummary = obx.summary || null;
    const finalDescription = openbdSummary || wikiSummary || null;
    const descriptionSource = openbdSummary ? "openbd" : wikiSummary ? "wikipedia" : null;

    // 日付は PA優先、次にopenBD pubdate（※wikiは使わない）
    const finalReleaseDate = paReleaseDate || obx.pubdate || null;

    const out = {
      seriesKey,
      author,
      vol1: {
        title: finalTitle,
        titleLane2: lane2Title,
        isbn13: paIsbn13 || isbn13 || isbn13FromDp || null,
        asin,
        image: extractImage(item) || null,
        amazonDp: `https://www.amazon.co.jp/dp/${asin}`,
        publisher: extractPublisher(item),
        contributors: extractContributors(item),

        releaseDate: finalReleaseDate,

        // ★日本語あらすじのみ
        description: finalDescription,
        descriptionSource,
        openbdSummary: openbdSummary || null,
        wikiSummary: wikiSummary || null,

        // ★英語由来は出さない（辞書翻訳前提のため）
        genres: [],
        tags: [],

        source: "enrich(paapi+openbd+wikipedia)",
      },
    };

    one.ok = true;
    one.output = out;
    debug.push(one);
    enriched.push(out);
    ok++;

    await sleep(1000);
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

  await saveJson(CACHE_OPENBD, cacheOpenbd);
  await saveJson(CACHE_WIKI, cacheWiki);
  await saveJson(CACHE_PAAPI, cachePaapi);

  console.log(`[lane2:enrich] total=${items.length} enriched=${enriched.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
