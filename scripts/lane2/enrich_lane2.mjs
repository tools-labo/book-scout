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
const CACHE_ANILIST = `${CACHE_DIR}/anilist.json`;
const CACHE_PAAPI = `${CACHE_DIR}/paapi.json`; // ISBN13→ASIN 解決キャッシュ
const CACHE_WIKI = `${CACHE_DIR}/wiki.json`;   // ★追加：Wikipedia（あらすじ/掲載誌）

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

function isInvalidResourceError(rawBody) {
  const s = String(rawBody ?? "");
  return s.includes("InvalidParameterValue") && s.includes("provided in the request for Resources is invalid");
}

async function getItemWithResourceProbe({ asin, debugSteps }) {
  const base = ["ItemInfo.Title", "ItemInfo.ByLineInfo", "ItemInfo.ExternalIds", "Images.Primary.Large"];
  const optionalCandidates = ["ItemInfo.ContentInfo", "ItemInfo.ProductInfo", "EditorialReviews", "EditorialReviews.EditorialReview"];

  let okJson = null;
  let okResources = base.slice();

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

  // base
  {
    const got = await callWithRetry(okResources, "base");
    debugSteps.base = got?.res ?? null;
    if (!got?.ok) {
      return {
        ok: false,
        reason: got?.skipped ? `paapi_skipped(${got.res.reason})` : `paapi_getitems_error(${got?.res?.status ?? "unknown"})`,
        raw: got?.res,
      };
    }
    okJson = got.res.json;
  }

  // optional probe
  debugSteps.probe = [];
  for (const opt of optionalCandidates) {
    const trial = okResources.concat([opt]);
    const got = await callWithRetry(trial, `probe:${opt}`);

    if (got?.ok) {
      okResources = trial;
      okJson = got.res.json;
      debugSteps.probe.push({ resource: opt, adopted: true });
      await sleep(650);
      continue;
    }

    if (got?.res?.error && got.res.status === 400 && isInvalidResourceError(got.res.body)) {
      debugSteps.probe.push({ resource: opt, adopted: false, reason: "invalid_resource" });
      await sleep(650);
      continue;
    }

    debugSteps.probe.push({ resource: opt, adopted: false, reason: `error(${got?.res?.status ?? "unknown"})` });
    await sleep(650);
  }

  const item = okJson?.ItemsResult?.Items?.[0] || null;
  if (!item) return { ok: false, reason: "no_item", raw: okJson };

  return { ok: true, item, usedResources: okResources };
}

// ISBN13→ASIN解決（SearchItemsでEAN一致のASINを拾う）
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
    const hit = items.find((it) => extractIsbn13(it) === key) || null;

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
 * openBD（ISBN→内容紹介）
 * ----------------------- */
function stripHtml(s) {
  const x = String(s ?? "");
  return x
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\u00A0/g, " ")
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
  if (!openbdObj) return { synopsis: null, pubdate: null, publisherText: null };

  const summary = openbdObj?.summary || null;
  const onix = openbdObj?.onix || null;

  const synopsis =
    summary?.description ||
    summary?.content ||
    onix?.CollateralDetail?.TextContent?.[0]?.Text ||
    null;

  const pubdate = summary?.pubdate || null;
  const publisherText = summary?.publisher || null;

  return {
    synopsis: synopsis ? stripHtml(synopsis) : null,
    pubdate: pubdate ? String(pubdate).trim() : null,
    publisherText: publisherText ? String(publisherText).trim() : null,
  };
}

/* -----------------------
 * AniList（ジャンル/タグだけ：説明は使わない）
 * ----------------------- */
async function fetchAniListBySeriesKey({ seriesKey, cache, debugSteps }) {
  const key = norm(seriesKey);
  if (!key) return { ok: false, reason: "no_seriesKey" };

  if (Object.prototype.hasOwnProperty.call(cache, key)) {
    debugSteps.anilist = { cached: true };
    return { ok: true, data: cache[key], cached: true };
  }

  const query = `
    query ($search: String) {
      Page(perPage: 10) {
        media(search: $search, type: MANGA) {
          id
          title { romaji english native }
          synonyms
          format
          genres
          tags { name rank isGeneralSpoiler }
        }
      }
    }
  `;

  let r;
  try {
    r = await fetch("https://graphql.anilist.co", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "accept": "application/json",
        "user-agent": "tools-labo/book-scout lane2 anilist",
      },
      body: JSON.stringify({ query, variables: { search: key } }),
    });
  } catch (e) {
    debugSteps.anilist = { cached: false, ok: false, error: String(e?.message || e) };
    return { ok: false, reason: "anilist_fetch_error" };
  }

  if (!r.ok) {
    const text = await r.text().catch(() => "");
    debugSteps.anilist = { cached: false, ok: false, status: r.status, body: text.slice(0, 300) };
    return { ok: false, reason: `anilist_http_${r.status}` };
  }

  let json;
  try {
    json = await r.json();
  } catch {
    debugSteps.anilist = { cached: false, ok: false, reason: "json_parse_error" };
    return { ok: false, reason: "anilist_json_parse_error" };
  }

  const list = json?.data?.Page?.media;
  if (!Array.isArray(list)) {
    cache[key] = null;
    debugSteps.anilist = { cached: false, ok: true, found: false };
    return { ok: true, data: null, found: false };
  }

  const s0 = normLoose(toHalfWidth(key));
  function scoreMedia(m) {
    let score = 0;
    const titles = [
      m?.title?.native,
      m?.title?.romaji,
      m?.title?.english,
      ...(Array.isArray(m?.synonyms) ? m.synonyms : []),
    ]
      .filter(Boolean)
      .map((t) => normLoose(toHalfWidth(t)));

    if (titles.some((t) => t === s0)) score += 1000;
    if (titles.some((t) => t.includes(s0))) score += 300;

    const fmt = String(m?.format || "");
    if (fmt === "MANGA") score += 40;
    if (fmt === "ONE_SHOT") score += 10;

    if (Array.isArray(m?.genres) && m.genres.length) score += 10;
    if (Array.isArray(m?.tags) && m.tags.length) score += 10;

    return score;
  }

  const withScore = list.map((m) => ({ m, score: scoreMedia(m) }));
  withScore.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const best = withScore[0]?.m || null;

  cache[key] = best ?? null;
  debugSteps.anilist = { cached: false, ok: true, found: !!best, pickedScore: withScore[0]?.score ?? null };
  return { ok: true, data: best, found: !!best };
}

function extractFromAniList(media) {
  if (!media) return { id: null, genres: [], tags: [] };

  const genres = Array.isArray(media?.genres) ? media.genres.filter(Boolean) : [];
  const tags =
    Array.isArray(media?.tags)
      ? media.tags
          .filter((t) => t && t.name && !t.isGeneralSpoiler)
          .sort((a, b) => (b.rank ?? 0) - (a.rank ?? 0))
          .slice(0, 30)
          .map((t) => t.name)
      : [];

  return { id: media?.id ?? null, genres, tags };
}

/* -----------------------
 * Wikipedia（MediaWiki API：あらすじ節 / 掲載誌）
 * ----------------------- */
async function wikiApi(params) {
  const base = "https://ja.wikipedia.org/w/api.php";
  const url = `${base}?${new URLSearchParams({ format: "json", origin: "*", ...params }).toString()}`;
  const r = await fetch(url, { headers: { "user-agent": "tools-labo/book-scout lane2 wiki" } });
  if (!r.ok) throw new Error(`wiki_http_${r.status}`);
  return await r.json();
}

function normalizeWikiText(s) {
  // 参照番号などを軽く掃除（完全じゃなくてOK）
  return String(s ?? "")
    .replace(/\[\d+\]/g, "")
    .replace(/\s+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractMagazineFromInfoboxHtml(html) {
  // action=parse の text（HTML）から infobox の「掲載誌」を拾う（あれば）
  const h = String(html ?? "");
  // 「掲載誌」th の次の td を狙う（多少雑でもOK、取れなければ null）
  const m =
    h.match(/<th[^>]*>\s*掲載誌\s*<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/) ||
    h.match(/<th[^>]*>\s*連載誌\s*<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/);

  if (!m) return null;

  const td = m[1];
  const text = stripHtml(td)
    .replace(/\s*（[^）]*）\s*/g, (x) => x) // そのまま残す（雑誌名の括弧が意味あることが多い）
    .replace(/\s+/g, " ")
    .trim();

  return text || null;
}

async function fetchWikiBySeriesKey({ seriesKey, cache, debugSteps }) {
  const key = norm(seriesKey);
  if (!key) return { ok: false, reason: "no_seriesKey" };

  if (Object.prototype.hasOwnProperty.call(cache, key)) {
    debugSteps.wiki = { cached: true };
    return { ok: true, data: cache[key], cached: true };
  }

  // 1) 検索（ページ特定）
  let search;
  try {
    search = await wikiApi({
      action: "query",
      list: "search",
      srsearch: key,
      srlimit: "5",
      srprop: "",
    });
  } catch (e) {
    debugSteps.wiki = { cached: false, ok: false, error: String(e?.message || e) };
    cache[key] = null;
    return { ok: false, reason: "wiki_search_error" };
  }

  const hit = search?.query?.search?.[0] || null;
  if (!hit?.pageid) {
    debugSteps.wiki = { cached: false, ok: true, found: false };
    cache[key] = null;
    return { ok: true, data: null, found: false };
  }

  const pageid = hit.pageid;
  const title = hit.title || null;

  // 2) sections 取得（あらすじ/ストーリー/物語 を探す）
  let sectionsJson;
  try {
    sectionsJson = await wikiApi({
      action: "parse",
      pageid: String(pageid),
      prop: "sections",
    });
  } catch (e) {
    debugSteps.wiki = { cached: false, ok: false, error: String(e?.message || e) };
    cache[key] = null;
    return { ok: false, reason: "wiki_sections_error" };
  }

  const sections = Array.isArray(sectionsJson?.parse?.sections) ? sectionsJson.parse.sections : [];
  const sec =
    sections.find((s) => /^(あらすじ|ストーリー|物語)$/.test(String(s?.line ?? "").trim())) ||
    sections.find((s) => /(あらすじ|ストーリー|物語)/.test(String(s?.line ?? "").trim())) ||
    null;

  const sectionIndex = sec?.index != null ? String(sec.index) : null;

  // 3) infobox（掲載誌）取り用：ページHTMLを一回取る（あらすじ節が無くても掲載誌は欲しい）
  let pageHtml = null;
  try {
    const p = await wikiApi({
      action: "parse",
      pageid: String(pageid),
      prop: "text",
      redirects: "1",
    });
    pageHtml = p?.parse?.text?.["*"] ?? null;
  } catch {
    pageHtml = null;
  }
  const magazine = extractMagazineFromInfoboxHtml(pageHtml);

  // 4) あらすじ節のHTML → text
  let synopsis = null;
  if (sectionIndex != null) {
    try {
      const secHtml = await wikiApi({
        action: "parse",
        pageid: String(pageid),
        prop: "text",
        section: sectionIndex,
        redirects: "1",
      });
      const html = secHtml?.parse?.text?.["*"] ?? "";
      const text = normalizeWikiText(stripHtml(html));
      synopsis = text || null;
    } catch {
      synopsis = null;
    }
  }

  const out = { pageid, title, synopsis, magazine };
  cache[key] = out;

  debugSteps.wiki = {
    cached: false,
    ok: true,
    found: true,
    pageid,
    title,
    hasSynopsis: !!synopsis,
    hasMagazine: !!magazine,
    sectionIndex,
  };

  return { ok: true, data: out, found: true };
}

/* -----------------------
 * main
 * ----------------------- */
async function main() {
  const series = await loadJson(IN_SERIES, { items: [] });
  const items = Array.isArray(series?.items) ? series.items : [];

  const cacheOpenbd = (await loadJson(CACHE_OPENBD, {})) || {};
  const cacheAniList = (await loadJson(CACHE_ANILIST, {})) || {};
  const cachePaapi = (await loadJson(CACHE_PAAPI, {})) || {};
  const cacheWiki = (await loadJson(CACHE_WIKI, {})) || {};

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
    const got = await getItemWithResourceProbe({ asin, debugSteps: stepPa });
    one.steps.getItemByAsin = {
      ok: !!got.ok,
      reason: got.ok ? null : got.reason,
      asin,
      raw: got.ok ? { usedResources: got.usedResources } : got.raw,
      probe: stepPa.probe || null,
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

    // 2) openBD（あらすじ：最優先）
    const stepOpenbd = {};
    const ob = await fetchOpenBdByIsbn13({
      isbn13: paIsbn13 || isbn13 || isbn13FromDp || null,
      cache: cacheOpenbd,
      debugSteps: stepOpenbd,
    });
    one.steps.openbd = stepOpenbd.openbd || null;

    const obx = ob?.ok ? extractFromOpenBd(ob.data) : { synopsis: null, pubdate: null, publisherText: null };

    // 3) Wiki（あらすじ節/掲載誌：openBDが無い時のあらすじ、掲載誌は常に補助）
    const stepWiki = {};
    const wk = await fetchWikiBySeriesKey({ seriesKey, cache: cacheWiki, debugSteps: stepWiki });
    one.steps.wiki = stepWiki.wiki || null;

    const wikiSynopsis = wk?.ok ? wk?.data?.synopsis ?? null : null;
    const magazine = wk?.ok ? wk?.data?.magazine ?? null : null;
    const wikiTitle = wk?.ok ? wk?.data?.title ?? null : null;

    // 4) AniList（ジャンル/タグのみ）
    const stepAni = {};
    const an = await fetchAniListBySeriesKey({ seriesKey, cache: cacheAniList, debugSteps: stepAni });
    one.steps.anilist = stepAni.anilist || null;

    const anx = an?.ok ? extractFromAniList(an.data) : { id: null, genres: [], tags: [] };

    // --- 最終 “あらすじ” の決定（英語説明は使わない）
    const finalSynopsis = obx.synopsis || wikiSynopsis || null;
    const synopsisSource = obx.synopsis ? "openbd" : wikiSynopsis ? "wiki" : null;

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

        // ★日本語優先の“あらすじ”
        synopsis: finalSynopsis,
        synopsisSource,

        // ★掲載誌（連載誌）
        magazine,         // 例：「週刊少年マガジン」
        wikiTitle,        // 出典用（UIで小さく「Wikipedia: xxx」リンクを出すなら使う）

        // ジャンル/タグ（翻訳はフロントで辞書適用＆辞書外は非表示）
        anilistId: anx.id,
        genres: anx.genres,
        tags: anx.tags,

        source: "enrich(paapi+openbd+wiki+anilist)",
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
  await saveJson(CACHE_ANILIST, cacheAniList);
  await saveJson(CACHE_PAAPI, cachePaapi);
  await saveJson(CACHE_WIKI, cacheWiki);

  console.log(`[lane2:enrich] total=${items.length} enriched=${enriched.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
