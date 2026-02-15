// scripts/lane2/enrich_lane2.mjs
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const IN_SERIES = "data/lane2/series.json";
const IN_MAG_OVERRIDES = "data/lane2/magazine_overrides.json";

const TAG_JA_MAP = "data/lane2/tag_ja_map.json";
const TAG_HIDE = "data/lane2/tag_hide.json";
const TAG_TODO = "data/lane2/tags_todo.json";

const CACHE_DIR = "data/lane2/cache";
const CACHE_ANILIST = `${CACHE_DIR}/anilist.json`;
const CACHE_WIKI = `${CACHE_DIR}/wiki.json`;
const CACHE_AMZ = `${CACHE_DIR}/amazon.json`;

const OUT_ENRICHED = "data/lane2/enriched.json";
const OUT_MAG_TODO = "data/lane2/magazine_todo.json";

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

// ★必須JSONは fallback 禁止（壊れたら落とす）
async function loadJsonStrict(p) {
  const txt = await fs.readFile(p, "utf8");
  try {
    return JSON.parse(txt);
  } catch (e) {
    const msg = e?.message ? String(e.message) : String(e);
    throw new Error(`[lane2:enrich] JSON parse failed: ${p} (${msg})`);
  }
}

async function saveJson(p, obj) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(obj, null, 2));
}

function norm(s) {
  return String(s ?? "").trim();
}

// ★タグ照合用の正規化（揺れ吸収）
function normTagKey(s) {
  return String(s ?? "")
    .trim()
    .replace(/\u00A0/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[’´`]/g, "'")
    .replace(/[‐-‒–—−]/g, "-")
    .replace(/[“”]/g, '"')
    .replace(/[（]/g, "(")
    .replace(/[）]/g, ")")
    .normalize("NFKC");
}

function toHalfWidth(s) {
  return String(s ?? "")
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[（]/g, "(")
    .replace(/[）]/g, ")")
    .replace(/[　]/g, " ");
}
function normLoose(s) {
  return norm(s).replace(/\s+/g, "");
}
function uniq(arr) {
  const out = [];
  const seen = new Set();
  for (const x of arr || []) {
    const s = norm(x);
    if (!s) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ★0件ガード（ここで落ちれば「書き込み」まで到達しない）
function assertNonEmptySeries(sorted) {
  if (!Array.isArray(sorted)) {
    throw new Error("[lane2:enrich] series items is not an array");
  }
  if (sorted.length === 0) {
    throw new Error(
      "[lane2:enrich] series has 0 items after normalization. Refusing to overwrite outputs."
    );
  }
}

/* -----------------------
 * HTML strip / decode
 * ----------------------- */
function stripHtml(s) {
  const x = String(s ?? "");

  const decodeHtmlEntities = (t) => {
    let y = String(t ?? "");

    // &amp;#91; / &amp;#x5B; を先に処理（重要）
    y = y
      .replace(/&amp;#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
      .replace(/&amp;#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)));

    // 通常の数値参照
    y = y
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
      .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)));

    // 代表的な named entity
    y = y
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");

    return y;
  };

  const t = x
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\u00A0/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return decodeHtmlEntities(t);
}

/* -----------------------
 * Tag dict
 * ----------------------- */
function loadTagMap(tagMapJson) {
  const m = tagMapJson?.map && typeof tagMapJson.map === "object" ? tagMapJson.map : {};
  const out = {};
  for (const [k, v] of Object.entries(m)) {
    const kk = normTagKey(k);
    const vv = norm(v);
    if (!kk || !vv) continue;
    out[kk] = vv;
  }
  return out;
}
function loadHideSet(hideJson) {
  const arr = Array.isArray(hideJson?.hide) ? hideJson.hide : [];
  return new Set(arr.map((x) => normTagKey(x)).filter(Boolean));
}
function applyTagDict({ tagsEn, tagMap, hideSet, todoSet }) {
  const outJa = [];
  const missing = [];
  for (const raw of uniq(tagsEn)) {
    const key = normTagKey(raw);
    if (!key) continue;

    if (hideSet.has(key)) continue;

    const ja = tagMap[key];
    if (ja) outJa.push(ja);
    else {
      missing.push(raw);
      todoSet.add(key);
    }
  }
  return { tags: uniq(outJa), tags_missing_en: uniq(missing) };
}

/* -----------------------
 * “充足判定” = ここが差分エンリッチの核
 * ----------------------- */
function hasAniListFilled(prevVol1) {
  return !!(
    prevVol1 &&
    prevVol1.anilistId &&
    Array.isArray(prevVol1.genres) && prevVol1.genres.length > 0 &&
    Array.isArray(prevVol1.tags_en) && prevVol1.tags_en.length > 0
  );
}
function hasMagazineFilled(prevVol1) {
  return !!(prevVol1 && norm(prevVol1.magazine));
}
function hasAmazonFilled(prevVol1) {
  return !!(
    prevVol1 &&
    norm(prevVol1.amazonDp) &&
    norm(prevVol1.image) &&
    norm(prevVol1.publisher) &&
    norm(prevVol1.author) &&
    norm(prevVol1.releaseDate)
  );
}

/* -----------------------
 * AniList (genres/tags)
 * ----------------------- */
async function fetchAniListBySeriesKey({ seriesKey, cache }) {
  const key = norm(seriesKey);
  if (!key) return { ok: false, reason: "no_seriesKey" };

  if (Object.prototype.hasOwnProperty.call(cache, key)) {
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

  const r = await fetch("https://graphql.anilist.co", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "user-agent": "tools-labo/book-scout lane2 anilist",
    },
    body: JSON.stringify({ query, variables: { search: key } }),
  });

  if (!r.ok) {
    // 429は上位で扱う（ここではcacheにnullを確定しない）
    return { ok: false, reason: `anilist_http_${r.status}` };
  }

  const json = await r.json();
  const list = json?.data?.Page?.media;
  if (!Array.isArray(list) || !list.length) {
    cache[key] = null;
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
    if (fmt === "ONE_SHOT") score -= 9999;

    if (Array.isArray(m?.genres) && m.genres.length) score += 10;
    if (Array.isArray(m?.tags) && m.tags.length) score += 10;
    return score;
  }

  const withScore = list.map((m) => ({ m, score: scoreMedia(m) }));
  withScore.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const best = withScore[0]?.m || null;

  cache[key] = best ?? null;
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
 * Wikipedia (magazine only)
 * ----------------------- */
async function wikiApi(params) {
  const base = "https://ja.wikipedia.org/w/api.php";
  const url = `${base}?${new URLSearchParams({ format: "json", origin: "*", ...params }).toString()}`;
  const r = await fetch(url, { headers: { "user-agent": "tools-labo/book-scout lane2 wiki" } });
  if (!r.ok) throw new Error(`wiki_http_${r.status}`);
  return await r.json();
}
function extractMagazineFromInfoboxHtml(html) {
  const h = String(html ?? "");
  const m =
    h.match(/<th[^>]*>\s*掲載誌\s*<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/) ||
    h.match(/<th[^>]*>\s*連載誌\s*<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/);
  if (!m) return null;

  const text = stripHtml(m[1]);

  // Wikipedia脚注っぽい [1], [注1], [注 1], [注釈1], [a] を除去（連載誌だけを綺麗にする）
  const cleaned = text
    .replace(/\[\s*(?:\d+|[a-zA-Z]|注\s*\d+|注釈\s*\d+)\s*\]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  return cleaned || null;
}

function wikiTitleLooksOk({ wikiTitle, seriesKey }) {
  const t = normLoose(toHalfWidth(wikiTitle ?? ""));
  const k = normLoose(toHalfWidth(seriesKey ?? ""));
  if (!t || !k) return false;
  return t === k || t.includes(k) || k.includes(t);
}

async function fetchWikiMagazineBySeriesKey({ seriesKey, cache }) {
  const key = norm(seriesKey);
  if (!key) return { ok: false, reason: "no_seriesKey" };

  if (Object.prototype.hasOwnProperty.call(cache, key)) {
    const c = cache[key];
    if (c && wikiTitleLooksOk({ wikiTitle: c?.title, seriesKey: key })) {
      return { ok: true, data: c, cached: true };
    }
  }

  let search;
  try {
    search = await wikiApi({
      action: "query",
      list: "search",
      srsearch: key,
      srlimit: "5",
      srprop: "snippet",
    });
  } catch {
    cache[key] = null;
    return { ok: false, reason: "wiki_search_error" };
  }

  const results = Array.isArray(search?.query?.search) ? search.query.search : [];
  if (!results.length) {
    cache[key] = null;
    return { ok: true, data: null, found: false };
  }

  const bestHit =
    results.find((x) => wikiTitleLooksOk({ wikiTitle: x?.title, seriesKey: key })) || null;

  if (!bestHit?.pageid) {
    cache[key] = null;
    return { ok: true, data: null, found: false };
  }

  let pageHtml = null;
  try {
    const p = await wikiApi({
      action: "parse",
      pageid: String(bestHit.pageid),
      prop: "text",
      redirects: "1",
    });
    pageHtml = p?.parse?.text?.["*"] ?? null;
  } catch {
    pageHtml = null;
  }

  const magazine = extractMagazineFromInfoboxHtml(pageHtml);
  const out = { pageid: bestHit.pageid, title: bestHit.title || null, magazine: magazine || null };
  cache[key] = out;

  return { ok: true, data: out, found: true };
}

/* -----------------------
 * Amazon PA-API (GetItems)
 * ----------------------- */
function hmac(key, data, enc = null) {
  return crypto.createHmac("sha256", key).update(data, "utf8").digest(enc || undefined);
}
function sha256Hex(s) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}
function toAmzDate(d = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  const yyyy = d.getUTCFullYear();
  const mm = pad(d.getUTCMonth() + 1);
  const dd = pad(d.getUTCDate());
  const hh = pad(d.getUTCHours());
  const mi = pad(d.getUTCMinutes());
  const ss = pad(d.getUTCSeconds());
  return {
    amzDate: `${yyyy}${mm}${dd}T${hh}${mi}${ss}Z`,
    dateStamp: `${yyyy}${mm}${dd}`,
  };
}
function signKey(secretKey, dateStamp, region, service) {
  const kDate = hmac("AWS4" + secretKey, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}

async function paapiPost({ host, region, accessKey, secretKey, target, path: apiPath, payload }) {
  const service = "ProductAdvertisingAPI";
  const endpoint = `https://${host}${apiPath}`;

  const { amzDate, dateStamp } = toAmzDate(new Date());
  const contentType = "application/json; charset=utf-8";

  const canonicalUri = apiPath;
  const canonicalQuery = "";
  const canonicalHeaders =
    `content-encoding:amz-1.0\n` +
    `content-type:${contentType}\n` +
    `host:${host}\n` +
    `x-amz-date:${amzDate}\n` +
    `x-amz-target:${target}\n`;
  const signedHeaders = "content-encoding;content-type;host;x-amz-date;x-amz-target";
  const payloadHash = sha256Hex(payload);

  const canonicalRequest = [
    "POST",
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const algorithm = "AWS4-HMAC-SHA256";
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    algorithm,
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const signingKey = signKey(secretKey, dateStamp, region, service);
  const signature = hmac(signingKey, stringToSign, "hex");

  const authorization =
    `${algorithm} ` +
    `Credential=${accessKey}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, ` +
    `Signature=${signature}`;

  const r = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-encoding": "amz-1.0",
      "content-type": contentType,
      host,
      "x-amz-date": amzDate,
      "x-amz-target": target,
      Authorization: authorization,
    },
    body: payload,
  });

  const txt = await r.text();
  let json = null;
  try { json = JSON.parse(txt); } catch { json = null; }

  if (!r.ok) {
    return { ok: false, status: r.status, json, text: txt };
  }
  return { ok: true, status: r.status, json };
}

// ★出版社の扱い修正版（ByLineInfoのManufacturerを出版社扱い）
function extractPaapiItem(item) {
  if (!item) return null;

  const dp = item?.DetailPageURL ?? null;

  const img =
    item?.Images?.Primary?.Large?.URL ||
    item?.Images?.Primary?.Medium?.URL ||
    item?.Images?.Primary?.Small?.URL ||
    null;

  const title =
    item?.ItemInfo?.Title?.DisplayValue ||
    item?.ItemInfo?.Title?.Value ||
    null;

  const manufacturer =
    item?.ItemInfo?.ByLineInfo?.Manufacturer?.DisplayValue ||
    item?.ItemInfo?.ByLineInfo?.Manufacturer?.Value ||
    null;

  const publisher = manufacturer || null;

  const contributors = Array.isArray(item?.ItemInfo?.ByLineInfo?.Contributors)
    ? item.ItemInfo.ByLineInfo.Contributors
    : [];

  const authorList = contributors
    .filter((c) => String(c?.RoleType || "").toLowerCase() === "author")
    .map((c) => c?.Name)
    .filter(Boolean);

  const authorFallback = contributors
    .map((c) => c?.Name)
    .filter(Boolean);

  const author = (authorList.length ? authorList : authorFallback).join(" / ") || null;

  const releaseDate =
    item?.ItemInfo?.ContentInfo?.PublicationDate?.DisplayValue ||
    item?.ItemInfo?.ContentInfo?.PublicationDate?.Value ||
    null;

  return {
    amazonDp: dp,
    image: img,
    title,
    publisher,
    author,
    releaseDate,
  };
}

async function fetchPaapiByAsins({ asins, cache, creds }) {
  const want = [];
  for (const asin of asins) {
    if (!asin) continue;
    if (Object.prototype.hasOwnProperty.call(cache, asin)) continue;
    want.push(asin);
  }
  if (!want.length) return;

  if (!creds?.enabled) {
    for (const asin of want) cache[asin] = null;
    return;
  }

  const host = creds.host;
  const region = creds.region;

  for (let i = 0; i < want.length; i += 10) {
    const chunk = want.slice(i, i + 10);

    const payloadObj = {
      ItemIds: chunk,
      PartnerTag: creds.partnerTag,
      PartnerType: "Associates",
      Marketplace: "www.amazon.co.jp",
      Resources: [
        "Images.Primary.Large",
        "Images.Primary.Medium",
        "Images.Primary.Small",
        "ItemInfo.Title",
        "ItemInfo.ByLineInfo",
        "ItemInfo.ContentInfo",
      ],
    };

    const res = await paapiPost({
      host,
      region,
      accessKey: creds.accessKey,
      secretKey: creds.secretKey,
      target: "com.amazon.paapi5.v1.ProductAdvertisingAPIv1.GetItems",
      path: "/paapi5/getitems",
      payload: JSON.stringify(payloadObj),
    });

    if (!res.ok) {
      for (const asin of chunk) cache[asin] = null;
    } else {
      const items = res.json?.ItemsResult?.Items || [];
      const map = new Map(items.map((it) => [it?.ASIN, it]));
      for (const asin of chunk) {
        const it = map.get(asin) || null;
        cache[asin] = it ? extractPaapiItem(it) : null;
      }
    }

    await sleep(350);
  }
}

/* -----------------------
 * AniList retry wrapper（429対策）
 * - 429が続くときは「それ以上叩かない」ことが重要
 * ----------------------- */
async function fetchAniListWithRetry({ seriesKey, cache }) {
  const max = 4;
  let wait = 700;

  for (let i = 1; i <= max; i++) {
    const res = await fetchAniListBySeriesKey({ seriesKey, cache });

    if (res.ok) return res;

    // 429は待って再試行（ただし最後までダメなら諦め）
    if (res.reason === "anilist_http_429") {
      console.log(
        `[lane2:enrich] anilist http_429 seriesKey="${seriesKey}" attempt=${i}/${max} wait=${wait}ms`
      );
      await sleep(wait);
      wait *= 2;
      continue;
    }

    return res;
  }

  return { ok: false, reason: "anilist_http_429_exhausted" };
}

/* -----------------------
 * main
 * ----------------------- */
async function main() {
  const seriesJson = await loadJsonStrict(IN_SERIES);
  const items = Array.isArray(seriesJson?.items) ? seriesJson.items : null;
  if (!items) {
    throw new Error(`[lane2:enrich] invalid series.json: "items" is not an array (${IN_SERIES})`);
  }

  const magOvJson = await loadJson(IN_MAG_OVERRIDES, { version: 1, updatedAt: "", items: {} });
  const magOverrides = magOvJson?.items && typeof magOvJson.items === "object" ? magOvJson.items : {};

  // 前回の enriched を“成果キャッシュ”として読む
  const prevEnriched = await loadJson(OUT_ENRICHED, { updatedAt: "", total: 0, items: [] });
  const prevMap = new Map(
    (Array.isArray(prevEnriched?.items) ? prevEnriched.items : [])
      .map((x) => [norm(x?.seriesKey), x])
      .filter(([k]) => k)
  );

  await fs.mkdir(CACHE_DIR, { recursive: true });

  const cacheAniList = (await loadJson(CACHE_ANILIST, {})) || {};
  const cacheWiki = (await loadJson(CACHE_WIKI, {})) || {};
  const cacheAmz = (await loadJson(CACHE_AMZ, {})) || {};

  const tagMapJson = await loadJson(TAG_JA_MAP, { version: 1, updatedAt: "", map: {} });
  const tagMap = loadTagMap(tagMapJson);

  const hideJson = await loadJson(TAG_HIDE, { version: 1, updatedAt: "", hide: [] });
  const hideSet = loadHideSet(hideJson);

  const todoJson = await loadJson(TAG_TODO, { version: 1, updatedAt: "", tags: [] });
  const todoSet = new Set((todoJson?.tags || []).map((x) => normTagKey(x)).filter(Boolean));

  const magTodoPrev = await loadJson(OUT_MAG_TODO, { version: 1, updatedAt: "", items: [] });
  const magTodoSet = new Set((magTodoPrev?.items || []).map((x) => norm(x)).filter(Boolean));

  // PA-API creds
  const accessKey = norm(process.env.AMZ_ACCESS_KEY);
  const secretKey = norm(process.env.AMZ_SECRET_KEY);
  const partnerTag = norm(process.env.AMZ_PARTNER_TAG);

  const creds = {
    enabled: !!(accessKey && secretKey && partnerTag),
    accessKey,
    secretKey,
    partnerTag,
    host: norm(process.env.AMZ_HOST) || "webservices.amazon.co.jp",
    region: norm(process.env.AMZ_REGION) || "us-west-2",
  };

  const sorted = items
    .map((x) => ({ ...x, seriesKey: norm(x?.seriesKey) }))
    .filter((x) => x.seriesKey)
    .sort((a, b) => a.seriesKey.localeCompare(b.seriesKey));

  assertNonEmptySeries(sorted);

  // --- 差分PA-API: 既にAmazon情報が揃ってる作品は呼ばない
  const asinsNeed = [];
  for (const x of sorted) {
    const seriesKey = norm(x?.seriesKey);
    const v = x?.vol1 || {};
    const asin = norm(v?.asin) || null;

    const prev = prevMap.get(seriesKey);
    const prevVol1 = prev?.vol1 || null;

    // 前回が埋まってるならPA-API不要（ただしcacheAmzには保存されないこともあるので、前回値を後で流用する）
    if (!asin) continue;
    if (hasAmazonFilled(prevVol1)) continue;

    // まだcacheに無いなら取得候補
    if (!Object.prototype.hasOwnProperty.call(cacheAmz, asin)) {
      asinsNeed.push(asin);
    }
  }

  await fetchPaapiByAsins({ asins: asinsNeed, cache: cacheAmz, creds });

  const enriched = [];
  let ok = 0;
  let ng = 0;
  let skippedAni = 0;
  let skippedWiki = 0;
  let skippedAmz = 0;

  for (const x of sorted) {
    const seriesKey = norm(x?.seriesKey);
    const v = x?.vol1 || {};

    const prev = prevMap.get(seriesKey);
    const prevVol1 = prev?.vol1 || null;

    const amazonUrl = norm(v?.amazonUrl) || null;
    const isbn13 = norm(v?.isbn13) || null;
    const asin = norm(v?.asin) || null;

    // 連載誌：manual override > 前回値 > wiki
    const manualMag = norm(magOverrides?.[seriesKey]?.magazine) || null;

    let magazine = null;
    let magazineSource = null;
    let wikiTitle = null;

    if (manualMag) {
      magazine = manualMag;
      magazineSource = "manual_override";
      wikiTitle = null;
    } else if (hasMagazineFilled(prevVol1)) {
      magazine = norm(prevVol1.magazine) || null;
      magazineSource = norm(prevVol1.magazineSource) || null;
      wikiTitle = prevVol1.wikiTitle ?? null;
      skippedWiki++;
    } else {
      const wk = await fetchWikiMagazineBySeriesKey({ seriesKey, cache: cacheWiki });
      const wikiMag = wk?.ok ? (wk?.data?.magazine ?? null) : null;
      wikiTitle = wk?.ok ? (wk?.data?.title ?? null) : null;
      magazine = norm(wikiMag) || null;
      magazineSource = magazine ? "wikipedia" : null;
      await sleep(150);
    }

    // AniList：前回埋まってるなら再取得しない
    let anilistId = prevVol1?.anilistId ?? null;
    let genres = Array.isArray(prevVol1?.genres) ? prevVol1.genres : [];
    let tagsEn = Array.isArray(prevVol1?.tags_en) ? prevVol1.tags_en : [];

    let tagsJa = Array.isArray(prevVol1?.tags) ? prevVol1.tags : [];
    let tagsMissing = Array.isArray(prevVol1?.tags_missing_en) ? prevVol1.tags_missing_en : [];

    if (hasAniListFilled(prevVol1)) {
      skippedAni++;
    } else {
      const an = await fetchAniListWithRetry({ seriesKey, cache: cacheAniList });
      if (an?.ok) {
        const anx = extractFromAniList(an.data);
        anilistId = anx.id;
        genres = uniq(anx.genres);
        tagsEn = uniq(anx.tags);

        const applied = applyTagDict({ tagsEn, tagMap, hideSet, todoSet });
        tagsJa = applied.tags;
        tagsMissing = applied.tags_missing_en;
      } else {
        // 429などで失敗した場合は「空のまま」= 次回差分で再挑戦対象になる
        ng++;
      }
      await sleep(250);
    }

    // Amazon：manual title優先。Amazon情報は「前回値」→「cache(PA-API)」の順で埋める
    const manualTitle = norm(v?.title) || null;

    const prevAmazonDp = norm(prevVol1?.amazonDp) || null;
    const prevImage = norm(prevVol1?.image) || null;
    const prevPublisher = norm(prevVol1?.publisher) || null;
    const prevAuthor = norm(prevVol1?.author) || null;
    const prevReleaseDate = norm(prevVol1?.releaseDate) || null;

    const amz = asin ? (cacheAmz?.[asin] ?? null) : null;

    const amazonDp = prevAmazonDp || norm(amz?.amazonDp) || null;
    const image = prevImage || norm(amz?.image) || null;
    const publisher = prevPublisher || norm(amz?.publisher) || null;
    const author = prevAuthor || norm(amz?.author) || null;
    const releaseDate = prevReleaseDate || norm(amz?.releaseDate) || null;

    // title は manual を尊重。無ければ「前回」→「PA-API」
    const title = manualTitle || norm(prevVol1?.title) || norm(amz?.title) || null;

    // synopsis は manual のみ（前回もmanual由来のはずだが、series.jsonが正なのでそちら優先）
    const synopsis = norm(v?.synopsis) || null;

    // todo
    if (!magazine) magTodoSet.add(seriesKey);
    else magTodoSet.delete(seriesKey);

    // “Amazon情報が前回で埋まってた”判定ログ用
    if (hasAmazonFilled(prevVol1)) skippedAmz++;

    enriched.push({
      seriesKey,
      vol1: {
        amazonUrl,
        amazonDp,
        isbn13,
        asin,

        title,
        synopsis,

        image,
        publisher,
        author,
        releaseDate,

        magazine,
        magazineSource,
        wikiTitle,

        anilistId,
        genres: uniq(genres),
        tags_en: uniq(tagsEn),
        tags: uniq(tagsJa),
        tags_missing_en: uniq(tagsMissing),

        source: "enrich(diff+prev+wiki(mag)+anilist+tagdict+hide+magazine_overrides+paapi)",
      },
      meta: x?.meta || null,
    });

    ok++;
  }

  await saveJson(TAG_TODO, {
    version: 1,
    updatedAt: nowIso(),
    tags: Array.from(todoSet).sort((a, b) => a.localeCompare(b)),
  });

  await saveJson(OUT_MAG_TODO, {
    version: 1,
    updatedAt: nowIso(),
    total: Array.from(magTodoSet).length,
    items: Array.from(magTodoSet).sort((a, b) => a.localeCompare(b)),
  });

  await saveJson(OUT_ENRICHED, {
    updatedAt: nowIso(),
    total: sorted.length,
    ok,
    ng,
    stats: {
      skippedAniList: skippedAni,
      skippedWiki: skippedWiki,
      skippedAmazon: skippedAmz,
      fetchedAmazonAsins: asinsNeed.length,
    },
    items: enriched,
  });

  await saveJson(CACHE_ANILIST, cacheAniList);
  await saveJson(CACHE_WIKI, cacheWiki);
  await saveJson(CACHE_AMZ, cacheAmz);

  console.log(
    `[lane2:enrich] total=${sorted.length} ok=${ok} ng=${ng} skipped(anilist=${skippedAni}, wiki=${skippedWiki}, amz=${skippedAmz}) -> ${OUT_ENRICHED}`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
