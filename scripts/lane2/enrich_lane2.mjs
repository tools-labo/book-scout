// scripts/lane2/enrich_lane2.mjs
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const IN_SERIES = "data/lane2/series.json";
const OUT_ENRICHED = "data/lane2/enriched.json";
const OUT_DEBUG = "data/lane2/debug_enrich.json";

// cache
const CACHE_DIR = "data/lane2/cache";
const CACHE_OPENBD = `${CACHE_DIR}/openbd.json`;
const CACHE_ANILIST = `${CACHE_DIR}/anilist.json`;
const CACHE_PAAPI = `${CACHE_DIR}/paapi.json`;
const CACHE_WIKIDATA = `${CACHE_DIR}/wikidata.json`;
const CACHE_WIKIPEDIA = `${CACHE_DIR}/wikipedia.json`;

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
function stripHtml(s) {
  const x = String(s ?? "");
  return x
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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
 * openBD
 * ----------------------- */
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
  if (!openbdObj) return { description: null, pubdate: null, publisher: null };

  const summary = openbdObj?.summary || null;
  const onix = openbdObj?.onix || null;

  const description =
    summary?.description ||
    summary?.content ||
    onix?.CollateralDetail?.TextContent?.[0]?.Text ||
    null;

  const pubdate = summary?.pubdate || null;
  const publisher = summary?.publisher || null;

  return {
    description: description ? stripHtml(description) : null,
    pubdate: pubdate ? String(pubdate).trim() : null,
    publisher: publisher ? String(publisher).trim() : null,
  };
}

/* -----------------------
 * AniList（genres/tags のみ使う：あらすじは使わない）
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
          .slice(0, 24)
          .map((t) => t.name)
      : [];

  return { id: media?.id ?? null, genres, tags };
}

/* -----------------------
 * 辞書翻訳（辞書にないものは非表示）
 * ----------------------- */
const GENRE_JA = {
  Action: "アクション",
  Adventure: "冒険",
  Comedy: "コメディ",
  Drama: "ドラマ",
  Fantasy: "ファンタジー",
  Horror: "ホラー",
  Mystery: "ミステリー",
  Psychological: "心理",
  Romance: "恋愛",
  "Sci-Fi": "SF",
  "Slice of Life": "日常",
  Sports: "スポーツ",
  Supernatural: "超常",
  Thriller: "サスペンス",
};

const TAG_JA = {
  Shounen: "少年",
  Seinen: "青年",
  "Male Protagonist": "男性主人公",
  "Female Protagonist": "女性主人公",
  "Battle Royale": "バトルロイヤル",
  Football: "サッカー",
  Athletics: "競技",
  Magic: "魔法",
  Demons: "悪魔",
  Elf: "エルフ",
  Travel: "旅",
  Tragedy: "悲劇",
  Iyashikei: "癒し",
  Philosophy: "哲学",
  "Time Skip": "時間経過",
  "Primarily Male Cast": "男多め",
  "Primarily Teen Cast": "10代中心",
  "Ensemble Cast": "群像劇",
  "Urban Fantasy": "現代ファンタジー",
  Twins: "双子",
  Youkai: "妖怪",
  Conspiracy: "陰謀",
  Rural: "田舎",
};

function translateByDict(arr, dict, max) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const x of arr) {
    const k = norm(x);
    const ja = dict[k];
    if (ja) out.push(ja);
    if (max && out.length >= max) break;
  }
  return out;
}

/* -----------------------
 * Wikipedia(ja) / Wikidata（連載誌・タグ補完）
 * ----------------------- */

// ja Wikipedia search -> title
async function wikipediaSearchJa({ seriesKey, cache, debugSteps }) {
  const key = norm(seriesKey);
  if (!key) return { ok: false, reason: "no_seriesKey" };

  const c = cache[key];
  if (c && c.title) {
    debugSteps.wikipediaSearch = { cached: true };
    return { ok: true, title: c.title, cached: true };
  }

  const url = `https://ja.wikipedia.org/w/api.php?action=query&format=json&origin=*&list=search&srlimit=5&srsearch=${encodeURIComponent(key + " 漫画")}`;
  let r;
  try {
    r = await fetch(url, { headers: { "user-agent": "tools-labo/book-scout lane2 wikipedia" } });
  } catch (e) {
    debugSteps.wikipediaSearch = { cached: false, ok: false, error: String(e?.message || e) };
    return { ok: false, reason: "wikipedia_fetch_error" };
  }

  if (!r.ok) {
    debugSteps.wikipediaSearch = { cached: false, ok: false, status: r.status };
    return { ok: false, reason: `wikipedia_http_${r.status}` };
  }

  const json = await r.json().catch(() => null);
  const hit = json?.query?.search?.[0]?.title || null;

  cache[key] = cache[key] || {};
  cache[key].title = hit;

  debugSteps.wikipediaSearch = { cached: false, ok: true, found: !!hit, title: hit };
  return { ok: true, title: hit, found: !!hit };
}

// title -> wikibase_item(QID)
async function wikipediaGetWikibaseItem({ title, debugSteps }) {
  if (!title) return { ok: false, reason: "no_title" };

  const url = `https://ja.wikipedia.org/w/api.php?action=query&format=json&origin=*&prop=pageprops&titles=${encodeURIComponent(title)}`;
  let r;
  try {
    r = await fetch(url, { headers: { "user-agent": "tools-labo/book-scout lane2 wikipedia" } });
  } catch (e) {
    debugSteps.wikipediaPageprops = { ok: false, error: String(e?.message || e) };
    return { ok: false, reason: "wikipedia_fetch_error" };
  }
  if (!r.ok) {
    debugSteps.wikipediaPageprops = { ok: false, status: r.status };
    return { ok: false, reason: `wikipedia_http_${r.status}` };
  }

  const json = await r.json().catch(() => null);
  const pages = json?.query?.pages || {};
  const firstKey = Object.keys(pages)[0];
  const qid = pages?.[firstKey]?.pageprops?.wikibase_item || null;

  debugSteps.wikipediaPageprops = { ok: true, qid };
  return { ok: true, qid, found: !!qid };
}

// wikipedia summary（ja）
async function wikipediaSummaryJa({ title, cache, seriesKey, debugSteps }) {
  if (!title) return { ok: false, reason: "no_title" };
  const key = norm(seriesKey);
  if (cache[key]?.summary != null) {
    debugSteps.wikipediaSummary = { cached: true };
    return { ok: true, summary: cache[key].summary, cached: true };
  }

  const url = `https://ja.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
  let r;
  try {
    r = await fetch(url, { headers: { "user-agent": "tools-labo/book-scout lane2 wikipedia" } });
  } catch (e) {
    debugSteps.wikipediaSummary = { cached: false, ok: false, error: String(e?.message || e) };
    return { ok: false, reason: "wikipedia_fetch_error" };
  }
  if (!r.ok) {
    debugSteps.wikipediaSummary = { cached: false, ok: false, status: r.status };
    return { ok: false, reason: `wikipedia_http_${r.status}` };
  }

  const json = await r.json().catch(() => null);
  const extract = norm(json?.extract || "") || null;

  cache[key] = cache[key] || {};
  cache[key].summary = extract;

  debugSteps.wikipediaSummary = { cached: false, ok: true, found: !!extract };
  return { ok: true, summary: extract, found: !!extract };
}

// Wikidata entity fetch
async function wikidataEntity({ qid, cache, debugSteps }) {
  if (!qid) return { ok: false, reason: "no_qid" };
  if (cache[qid]) {
    debugSteps.wikidata = { cached: true };
    return { ok: true, data: cache[qid], cached: true };
  }

  const url = `https://www.wikidata.org/wiki/Special:EntityData/${encodeURIComponent(qid)}.json`;
  let r;
  try {
    r = await fetch(url, { headers: { "user-agent": "tools-labo/book-scout lane2 wikidata" } });
  } catch (e) {
    debugSteps.wikidata = { cached: false, ok: false, error: String(e?.message || e) };
    return { ok: false, reason: "wikidata_fetch_error" };
  }
  if (!r.ok) {
    debugSteps.wikidata = { cached: false, ok: false, status: r.status };
    return { ok: false, reason: `wikidata_http_${r.status}` };
  }

  const json = await r.json().catch(() => null);
  cache[qid] = json ?? null;

  debugSteps.wikidata = { cached: false, ok: true, found: !!json };
  return { ok: true, data: json, found: !!json };
}

// serialize in magazine: claims P1433 (published in) の ja label
function extractMagazineJaFromWikidata(entityJson, qid) {
  const ent = entityJson?.entities?.[qid];
  const claims = ent?.claims || {};
  const p1433 = claims?.P1433;
  if (!Array.isArray(p1433) || !p1433.length) return [];

  const ids = [];
  for (const c of p1433) {
    const id = c?.mainsnak?.datavalue?.value?.id || null;
    if (id) ids.push(id);
  }
  if (!ids.length) return [];

  const out = [];
  for (const id of ids) {
    const e = entityJson?.entities?.[id];
    const ja = e?.labels?.ja?.value || null;
    if (ja) out.push(ja);
  }
  // 重複除去 + 最大2
  return [...new Set(out)].slice(0, 2);
}

// tags fallback: Wikidata P136(genre) ja label を「タグ」として少しだけ補完
function extractGenreJaFromWikidata(entityJson, qid) {
  const ent = entityJson?.entities?.[qid];
  const claims = ent?.claims || {};
  const p136 = claims?.P136;
  if (!Array.isArray(p136) || !p136.length) return [];

  const ids = [];
  for (const c of p136) {
    const id = c?.mainsnak?.datavalue?.value?.id || null;
    if (id) ids.push(id);
  }
  if (!ids.length) return [];

  const out = [];
  for (const id of ids) {
    const e = entityJson?.entities?.[id];
    const ja = e?.labels?.ja?.value || null;
    if (ja) out.push(ja);
  }
  return [...new Set(out)];
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
  const cacheWikidata = (await loadJson(CACHE_WIKIDATA, {})) || {};
  const cacheWikipedia = (await loadJson(CACHE_WIKIPEDIA, {})) || {};

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
      input: { lane2Title, isbn13, amazonDp, source: x?.vol1?.source ?? null },
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

    // 1) PA-API GetItems
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

    // 2) openBD（あらすじ本命）
    const stepOpenbd = {};
    const ob = await fetchOpenBdByIsbn13({
      isbn13: paIsbn13 || isbn13 || isbn13FromDp || null,
      cache: cacheOpenbd,
      debugSteps: stepOpenbd,
    });
    one.steps.openbd = stepOpenbd.openbd || null;
    const obx = ob?.ok ? extractFromOpenBd(ob.data) : { description: null, pubdate: null, publisher: null };

    // 3) Wikipedia(ja) summary（openBD無い時のみ）
    const stepWiki = {};
    let wikiTitle = null;
    let wikiSummary = null;

    const wSearch = await wikipediaSearchJa({ seriesKey, cache: cacheWikipedia, debugSteps: stepWiki });
    if (wSearch?.ok && wSearch.title) {
      wikiTitle = wSearch.title;

      const wSum = await wikipediaSummaryJa({
        title: wikiTitle,
        cache: cacheWikipedia,
        seriesKey,
        debugSteps: stepWiki,
      });
      if (wSum?.ok) wikiSummary = wSum.summary || null;
    }
    one.steps.wikipedia = stepWiki;

    // 4) Wikidata（連載誌）
    const stepWk = {};
    let magazines = [];
    let wikidataQid = null;

    if (wikiTitle) {
      const pp = await wikipediaGetWikibaseItem({ title: wikiTitle, debugSteps: stepWk });
      if (pp?.ok && pp.qid) {
        wikidataQid = pp.qid;
        const wd = await wikidataEntity({ qid: wikidataQid, cache: cacheWikidata, debugSteps: stepWk });
        if (wd?.ok && wd.data) {
          magazines = extractMagazineJaFromWikidata(wd.data, wikidataQid);
        }
      }
    }
    one.steps.wikidata = stepWk;

    // 5) AniList（ジャンル/タグの元）
    const stepAni = {};
    const an = await fetchAniListBySeriesKey({ seriesKey, cache: cacheAniList, debugSteps: stepAni });
    one.steps.anilist = stepAni.anilist || null;
    const anx = an?.ok ? extractFromAniList(an.data) : { id: null, genres: [], tags: [] };

    // 6) ジャンル/タグ：辞書にないものは出さない
    const genresJa = translateByDict(anx.genres, GENRE_JA, 6);
    let tagsJa = translateByDict(anx.tags, TAG_JA, 12);

    // タグが少なすぎるときのみ Wikidata で補完（jaラベルのみ / 最大+6）
    if (tagsJa.length < 4 && wikidataQid) {
      const wd = cacheWikidata[wikidataQid] || null;
      const extra = wd ? extractGenreJaFromWikidata(wd, wikidataQid) : [];
      // extraはすでにjaラベルなので「変な翻訳」は起きにくい。ノイズ削減で最大6。
      for (const t of extra) {
        if (tagsJa.length >= 10) break;
        const v = norm(t);
        if (!v) continue;
        if (tagsJa.includes(v)) continue;
        tagsJa.push(v);
      }
    }

    // 7) あらすじ：openBD → Wikipedia(ja) → null（英語は出さない）
    const finalDescription = obx.description || wikiSummary || null;
    const descriptionSource = obx.description ? "openbd" : wikiSummary ? "wikipedia" : null;

    // 8) 発売日：PA優先、なければopenBD pubdate
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
        description: finalDescription,
        descriptionSource,

        // 連載誌（掲載誌）
        serializedIn: magazines, // ["週刊少年マガジン"] など（取れた時だけ）
        wikidataQid,

        // 表示用（日本語化済みを入れる）
        genresJa,
        tagsJa,

        // 監査用
        anilistId: anx.id,
        source: "enrich(paapi+openbd+wikipedia+wikidata+anilist)",
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
  await saveJson(CACHE_WIKIDATA, cacheWikidata);
  await saveJson(CACHE_WIKIPEDIA, cacheWikipedia);

  console.log(`[lane2:enrich] total=${items.length} enriched=${enriched.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
