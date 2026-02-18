// scripts/lane2/enrich_lane2.mjs
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const IN_SERIES = "data/lane2/series.json";
const IN_MAG_OVERRIDES = "data/lane2/magazine_overrides.json";

const TAG_JA_MAP = "data/lane2/tag_ja_map.json";
const TAG_HIDE = "data/lane2/tag_hide.json";
const TAG_TODO = "data/lane2/tags_todo.json";

const IN_MAG_AUDIENCE = "data/lane2/magazine_audience.json";
const IN_MAG_AUDIENCE_TODO = "data/lane2/magazine_audience_todo.json";

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
  let x = String(s ?? "");

  x = x
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "");

  const decodeHtmlEntities = (t) => {
    let y = String(t ?? "");

    y = y
      .replace(/&amp;#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
      .replace(/&amp;#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)));

    y = y
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
      .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)));

    y = y
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");

    return y;
  };

  const t = x
    .replace(/<\/li>/gi, "\n")
    .replace(/<li[^>]*>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/tr>/gi, "\n")
    .replace(/<\/td>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\u00A0/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();

  return decodeHtmlEntities(t);
}

/* -----------------------
 * CSS/セレクタ系のゴミ判定
 * ----------------------- */
function looksCssGarbage(line) {
  const s = norm(line);
  if (!s) return true;

  if (s.includes("mw-parser-output")) return true;
  if (s.includes("plainlist")) return true;

  if (/[{};]/.test(s)) return true;
  if (/[<>]/.test(s)) return true;
  if (/^[.#]/.test(s)) return true;
  if (/(margin|padding|line-height|list-style|only-child)/i.test(s)) return true;

  if (/^(ul|ol|li)$/i.test(s)) return true;
  if (/^none\b/i.test(s)) return true;

  if (s.length > 80) return true;

  return false;
}

function isPlausibleMagazineName(name) {
  const s = norm(name);
  if (!s) return false;
  if (looksCssGarbage(s)) return false;

  if (!/[ぁ-んァ-ヶ一-龠a-zA-Z0-9]/.test(s)) return false;

  return true;
}

/* -----------------------
 * Tag dict (EN -> JA)
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

/**
 * ★tags_todo 自動消し込み：
 *  - 既に tag_ja_map に入った（翻訳済み）
 *  - 既に tag_hide に入った（非表示扱い）
 * は todo から削除する
 */
function cleanupTagTodoSet({ todoSet, tagMap, hideSet }) {
  if (!(todoSet instanceof Set)) return;
  const hs = hideSet instanceof Set ? hideSet : new Set();
  const tm = tagMap && typeof tagMap === "object" ? tagMap : {};
  for (const k of Array.from(todoSet)) {
    if (!k) {
      todoSet.delete(k);
      continue;
    }
    if (hs.has(k)) {
      todoSet.delete(k);
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(tm, k)) {
      todoSet.delete(k);
      continue;
    }
  }
}

/**
 * tagsEn から:
 *  - hide は除外
 *  - tag_ja_map で日本語化
 *  - 未翻訳は tags_missing_en に残し、todoSet に積む（hide は積まない）
 */
function applyTagDict({ tagsEn, tagMap, hideSet, todoSet }) {
  const outJa = [];
  const missing = [];
  const hs = hideSet instanceof Set ? hideSet : new Set();

  for (const raw of uniq(tagsEn)) {
    const key = normTagKey(raw);
    if (!key) continue;

    // hide は “表示しない＆未翻訳扱いもしない”
    if (hs.has(key)) continue;

    const ja = tagMap[key];
    if (ja) outJa.push(ja);
    else {
      missing.push(raw);
      if (todoSet) todoSet.add(key);
    }
  }
  return { tags: uniq(outJa), tags_missing_en: uniq(missing) };
}

/**
 * ★根本対策：過去の enriched に残っている tags_missing_en から todo を毎回再構築する
 */
function mergeTodoFromPrevMissingTags({ prevEnrichedItems, todoSet, hideSet }) {
  const hs = hideSet instanceof Set ? hideSet : new Set();

  for (const it of prevEnrichedItems || []) {
    const miss = Array.isArray(it?.vol1?.tags_missing_en) ? it.vol1.tags_missing_en : [];
    for (const raw of miss) {
      const key = normTagKey(raw);
      if (!key) continue;
      if (hs.has(key)) continue;
      todoSet.add(key);
    }
  }
}

/* -----------------------
 * “充足判定”
 * ----------------------- */
function hasAniListFilled(prevVol1) {
  return !!(
    prevVol1 &&
    prevVol1.anilistId &&
    Array.isArray(prevVol1.genres) &&
    prevVol1.genres.length > 0 &&
    Array.isArray(prevVol1.tags_en) &&
    prevVol1.tags_en.length > 0
  );
}
function hasMagazineFilled(prevVol1) {
  return !!(prevVol1 && norm(prevVol1.magazine));
}
function hasAmazonFilled(vol1) {
  return !!(
    vol1 &&
    norm(vol1.amazonDp) &&
    norm(vol1.image) &&
    norm(vol1.publisher) &&
    norm(vol1.author) &&
    norm(vol1.releaseDate) &&
    norm(vol1.title)
  );
}

/**
 * ★完璧判定（hide対応）
 */
function isPerfectVol1(prevVol1, hideSet) {
  if (!prevVol1) return false;

  if (!hasAmazonFilled(prevVol1)) return false;
  if (!hasMagazineFilled(prevVol1)) return false;
  if (!hasAniListFilled(prevVol1)) return false;

  if (!Array.isArray(prevVol1.magazines) || prevVol1.magazines.length === 0) return false;
  if (!Array.isArray(prevVol1.audiences) || prevVol1.audiences.length === 0) return false;

  if (!Array.isArray(prevVol1.tags) || prevVol1.tags.length === 0) return false;

  const miss = Array.isArray(prevVol1.tags_missing_en) ? prevVol1.tags_missing_en : [];
  if (miss.length > 0) {
    const hs = hideSet instanceof Set ? hideSet : new Set();
    const remain = miss
      .map((x) => normTagKey(x))
      .filter(Boolean)
      .filter((k) => !hs.has(k));
    if (remain.length > 0) return false;
  }

  return true;
}

/* -----------------------
 * perfect未達理由の集計（debug用）
 * ----------------------- */
function bumpReason(reasons, key) {
  reasons[key] = (reasons[key] || 0) + 1;
}
function pushSample(samples, key, seriesKey, limit = 12) {
  if (!samples[key]) samples[key] = [];
  if (samples[key].length >= limit) return;
  samples[key].push(seriesKey);
}

/* -----------------------
 * AniList
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
  const url = `${base}?${new URLSearchParams({
    format: "json",
    origin: "*",
    ...params,
  }).toString()}`;
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

  const lines = text
    .split("\n")
    .map((x) => norm(x))
    .filter(Boolean)
    .filter((x) => !looksCssGarbage(x))
    .filter((x) => x.length <= 80);

  const joined = lines.join(" / ");
  const cleaned = joined.replace(/\s+/g, " ").trim();

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

function isRetryablePaapiStatus(status) {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function summarizePaapiError(json, text) {
  const code = json?.Errors?.[0]?.Code || json?.Error?.Code || json?.__type || null;
  const msg = json?.Errors?.[0]?.Message || json?.Error?.Message || null;

  const shortText = (() => {
    const t = String(text ?? "");
    if (!t) return null;
    return t.length > 180 ? t.slice(0, 180) + "…" : t;
  })();

  return { code, message: msg, shortText };
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
  const stringToSign = [algorithm, amzDate, credentialScope, sha256Hex(canonicalRequest)].join("\n");

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

  const retryAfter = r.headers?.get?.("retry-after") ?? null;

  const txt = await r.text();
  let json = null;
  try {
    json = JSON.parse(txt);
  } catch {
    json = null;
  }

  if (!r.ok) {
    return { ok: false, status: r.status, json, text: txt, retryAfter };
  }
  return { ok: true, status: r.status, json, retryAfter };
}

function extractPaapiItem(item) {
  if (!item) return null;

  const dp = item?.DetailPageURL ?? null;

  const img =
    item?.Images?.Primary?.Large?.URL ||
    item?.Images?.Primary?.Medium?.URL ||
    item?.Images?.Primary?.Small?.URL ||
    null;

  const title = item?.ItemInfo?.Title?.DisplayValue || item?.ItemInfo?.Title?.Value || null;

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

  const authorFallback = contributors.map((c) => c?.Name).filter(Boolean);

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

/**
 * cacheAmz[asin] の形式:
 *  - { ok:true, data:{...}, at:"..." }
 *  - { ok:false, kind:"temporary"|"permanent", status:number|null, error:{code,message,shortText}, at:"..." }
 */
function readCacheAmzEntry(cacheAmz, asin) {
  const v = cacheAmz?.[asin];
  if (!v) return null;

  if (v === null) return { legacyNull: true, raw: v };
  if (v && typeof v === "object" && "ok" in v) return v;
  if (v && typeof v === "object") {
    return { ok: true, data: v, at: nowIso(), legacyWrapped: true };
  }
  return null;
}

function writeCacheAmzSuccess(cacheAmz, asin, data) {
  cacheAmz[asin] = { ok: true, data: data ?? null, at: nowIso() };
}
function writeCacheAmzError(cacheAmz, asin, { kind, status, error }) {
  cacheAmz[asin] = { ok: false, kind, status: status ?? null, error: error ?? null, at: nowIso() };
}

async function fetchPaapiByAsins({ asins, cache, creds, stats }) {
  const want = [];
  for (const asin of asins) {
    const a = norm(asin);
    if (!a) continue;

    const entry = readCacheAmzEntry(cache, a);

    if (entry && entry.ok) continue;

    if (entry && entry.ok === false && entry.kind === "temporary") {
      want.push(a);
      continue;
    }

    if (entry && entry.ok === false && entry.kind === "permanent") continue;

    want.push(a);
  }

  if (!want.length) return;

  if (!creds?.enabled) {
    for (const asin of want) {
      writeCacheAmzError(cache, asin, {
        kind: "temporary",
        status: null,
        error: { code: "AMZ_CREDS_MISSING", message: "PA-API creds missing", shortText: null },
      });
    }
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

    const payload = JSON.stringify(payloadObj);

    const max = 4;
    let wait = 900;
    let res = null;

    for (let attempt = 1; attempt <= max; attempt++) {
      res = await paapiPost({
        host,
        region,
        accessKey: creds.accessKey,
        secretKey: creds.secretKey,
        target: "com.amazon.paapi5.v1.ProductAdvertisingAPIv1.GetItems",
        path: "/paapi5/getitems",
        payload,
      });

      if (res.ok) break;

      const retryable = isRetryablePaapiStatus(res.status);
      const ra = Number(res.retryAfter);
      const waitMs = Number.isFinite(ra) && ra > 0 ? ra * 1000 : wait;

      const err = summarizePaapiError(res.json, res.text);
      console.log(
        `[lane2:enrich] paapi http_${res.status} attempt=${attempt}/${max} retryable=${retryable} wait=${waitMs}ms chunk=${chunk.join(
          ","
        )} code=${err.code ?? "-"} msg=${(err.message ?? "").slice(0, 120)}`
      );

      if (!retryable || attempt === max) break;

      await sleep(waitMs);
      wait *= 2;
    }

    if (!res || !res.ok) {
      const status = res?.status ?? null;
      const retryable = status != null ? isRetryablePaapiStatus(status) : true;
      const kind = retryable ? "temporary" : "permanent";
      const err = summarizePaapiError(res?.json, res?.text);

      for (const asin of chunk) {
        writeCacheAmzError(cache, asin, { kind, status, error: err });
      }

      if (stats) {
        stats.paapiFailures++;
        if (status === 429) stats.paapi429++;
        if (status === 503) stats.paapi503++;
      }

      await sleep(400);
      continue;
    }

    const items = res.json?.ItemsResult?.Items || [];
    const map = new Map(items.map((it) => [it?.ASIN, it]));

    for (const asin of chunk) {
      const it = map.get(asin) || null;

      if (!it) {
        writeCacheAmzError(cache, asin, {
          kind: "temporary",
          status: 200,
          error: {
            code: "ITEM_NOT_RETURNED",
            message: "GetItems returned no item for this ASIN",
            shortText: null,
          },
        });
        if (stats) stats.paapiMissingItems++;
        continue;
      }

      const extracted = extractPaapiItem(it);
      writeCacheAmzSuccess(cache, asin, extracted);

      if (stats) stats.paapiSuccessItems++;
    }

    if (stats) stats.paapiChunks++;

    await sleep(400);
  }
}

/* -----------------------
 * AniList retry wrapper（429対策）
 * ----------------------- */
async function fetchAniListWithRetry({ seriesKey, cache }) {
  const max = 4;
  let wait = 700;

  for (let i = 1; i <= max; i++) {
    const res = await fetchAniListBySeriesKey({ seriesKey, cache });
    if (res.ok) return res;

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
 * Magazine split + audience
 * ----------------------- */
function splitMagazines(magazineStr) {
  const s = norm(magazineStr);
  if (!s) return [];

  const parts = s
    .split(/[\n\/／・,、]/g)
    .map((x) => norm(x))
    .filter(Boolean);

  const mags = parts.flatMap((p) =>
    p
      .split("→")
      .map((x) => norm(x))
      .filter(Boolean)
  );

  return uniq(mags).filter(isPlausibleMagazineName);
}

function loadMagAudienceMap(json) {
  const items = json?.items && typeof json.items === "object" ? json.items : {};
  const out = new Map();
  for (const [aud, mags] of Object.entries(items)) {
    if (!Array.isArray(mags)) continue;
    for (const m of mags) {
      const k = norm(m);
      if (!k) continue;
      out.set(k, aud);
    }
  }
  return out;
}

function splitByDictOnlyIfAllKnown(raw, magAudienceMap) {
  const s = norm(raw);
  if (!s) return [];
  if (magAudienceMap.has(s)) return [s];
  if (!/\s/.test(s)) return [s];

  const parts = s.split(/\s+/g).map(norm).filter(Boolean);

  if (parts.length >= 2 && parts.every((p) => magAudienceMap.has(p))) {
    return parts;
  }
  return [s];
}

function pickAudiences({ magazines, magAudienceMap, todoSet }) {
  const auds = new Set();

  for (const m0 of magazines) {
    const candidates = splitByDictOnlyIfAllKnown(m0, magAudienceMap);

    for (const m of candidates) {
      const mm = norm(m);
      if (!mm) continue;
      if (!isPlausibleMagazineName(mm)) continue;

      const a = magAudienceMap.get(mm) || null;
      if (a) auds.add(a);
      else todoSet.add(mm);
    }
  }

  if (auds.size === 0) auds.add("その他");
  return Array.from(auds);
}

/* -----------------------
 * perfect未達の理由を判定して集計
 * ----------------------- */
function evalPerfectNotMetReasons({ seriesKey, vol1, hideSet, reasons, samples }) {
  if (!vol1) {
    bumpReason(reasons, "noPrevVol1");
    pushSample(samples, "noPrevVol1", seriesKey);
    return;
  }

  if (!hasAmazonFilled(vol1)) {
    bumpReason(reasons, "amazonMissing");
    pushSample(samples, "amazonMissing", seriesKey);
  }

  const magazine = norm(vol1.magazine);
  if (!magazine) {
    bumpReason(reasons, "magazineEmpty");
    pushSample(samples, "magazineEmpty", seriesKey);
  } else {
    if (looksCssGarbage(magazine)) {
      bumpReason(reasons, "magazineLooksCssGarbage");
      pushSample(samples, "magazineLooksCssGarbage", seriesKey);
    }
    if (!isPlausibleMagazineName(magazine)) {
      bumpReason(reasons, "magazineNotPlausible");
      pushSample(samples, "magazineNotPlausible", seriesKey);
    }
  }

  if (!Array.isArray(vol1.magazines) || vol1.magazines.length === 0) {
    bumpReason(reasons, "magazinesEmpty");
    pushSample(samples, "magazinesEmpty", seriesKey);
  }

  if (!Array.isArray(vol1.audiences) || vol1.audiences.length === 0) {
    bumpReason(reasons, "audiencesEmpty");
    pushSample(samples, "audiencesEmpty", seriesKey);
  } else {
    const onlyOther = vol1.audiences.length === 1 && norm(vol1.audiences[0]) === "その他";
    if (onlyOther) {
      bumpReason(reasons, "audiencesOnlyOther");
      pushSample(samples, "audiencesOnlyOther", seriesKey);
    }
  }

  if (
    !(
      vol1.anilistId &&
      Array.isArray(vol1.genres) &&
      vol1.genres.length > 0 &&
      Array.isArray(vol1.tags_en) &&
      vol1.tags_en.length > 0
    )
  ) {
    bumpReason(reasons, "anilistMissing");
    pushSample(samples, "anilistMissing", seriesKey);
  } else {
    if (!Array.isArray(vol1.genres) || vol1.genres.length === 0) {
      bumpReason(reasons, "genresEmpty");
      pushSample(samples, "genresEmpty", seriesKey);
    }
    if (!Array.isArray(vol1.tags_en) || vol1.tags_en.length === 0) {
      bumpReason(reasons, "tagsEnEmpty");
      pushSample(samples, "tagsEnEmpty", seriesKey);
    }
  }

  if (!Array.isArray(vol1.tags) || vol1.tags.length === 0) {
    bumpReason(reasons, "tagsJaEmpty");
    pushSample(samples, "tagsJaEmpty", seriesKey);
  }

  const miss = Array.isArray(vol1.tags_missing_en) ? vol1.tags_missing_en : [];
  if (miss.length > 0) {
    const hs = hideSet instanceof Set ? hideSet : new Set();
    const remain = miss
      .map((x) => normTagKey(x))
      .filter(Boolean)
      .filter((k) => !hs.has(k));
    if (remain.length > 0) {
      bumpReason(reasons, "tagsMissingNotHidden");
      pushSample(samples, "tagsMissingNotHidden", seriesKey);
    }
  }
}

/* -----------------------
 * main
 * ----------------------- */
async function main() {
  const seriesJson = await loadJsonStrict(IN_SERIES);
  const items = Array.isArray(seriesJson?.items) ? seriesJson.items : null;
  if (!items) {
    throw new Error(
      `[lane2:enrich] invalid series.json: "items" is not an array (${IN_SERIES})`
    );
  }

  const magOvJson = await loadJson(IN_MAG_OVERRIDES, { version: 1, updatedAt: "", items: {} });
  const magOverrides =
    magOvJson?.items && typeof magOvJson.items === "object" ? magOvJson.items : {};

  const prevEnriched = await loadJson(OUT_ENRICHED, { updatedAt: "", total: 0, items: [] });
  const prevItems = Array.isArray(prevEnriched?.items) ? prevEnriched.items : [];
  const prevMap = new Map(prevItems.map((x) => [norm(x?.seriesKey), x]).filter(([k]) => k));

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
  mergeTodoFromPrevMissingTags({ prevEnrichedItems: prevItems, todoSet, hideSet });

  cleanupTagTodoSet({ todoSet, tagMap, hideSet });

  const magTodoPrev = await loadJson(OUT_MAG_TODO, { version: 1, updatedAt: "", items: [] });
  const magTodoSet = new Set((magTodoPrev?.items || []).map((x) => norm(x)).filter(Boolean));

  const magAudienceJson = await loadJsonStrict(IN_MAG_AUDIENCE);
  const magAudienceMap = loadMagAudienceMap(magAudienceJson);

  const magAudTodoSet = new Set();

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

  const asinsNeed = [];
  for (const x of sorted) {
    const seriesKey = norm(x?.seriesKey);
    const v = x?.vol1 || {};
    const asin = norm(v?.asin) || null;
    if (!asin) continue;

    const prev = prevMap.get(seriesKey);
    const prevVol1 = prev?.vol1 || null;

    if (hasAmazonFilled(prevVol1)) continue;

    asinsNeed.push(asin);
  }

  const paapiStats = {
    paapiChunks: 0,
    paapiFailures: 0,
    paapi429: 0,
    paapi503: 0,
    paapiMissingItems: 0,
    paapiSuccessItems: 0,
  };

  await fetchPaapiByAsins({ asins: asinsNeed, cache: cacheAmz, creds, stats: paapiStats });

  const enriched = [];
  let ok = 0;
  let ng = 0;
  let skippedAni = 0;
  let skippedWiki = 0;
  let skippedAmz = 0;
  let skippedPerfect = 0;
  let magAudienceTodoAdded = 0;

  const perfectNotMetReasons = {
    noPrevVol1: 0,
    amazonMissing: 0,
    magazineEmpty: 0,
    magazinesEmpty: 0,
    audiencesEmpty: 0,
    audiencesOnlyOther: 0,
    anilistMissing: 0,
    genresEmpty: 0,
    tagsEnEmpty: 0,
    tagsJaEmpty: 0,
    tagsMissingNotHidden: 0,
    magazineLooksCssGarbage: 0,
    magazineNotPlausible: 0,
  };
  const perfectNotMetSamples = {};
    for (const x of sorted) {
    const seriesKey = norm(x?.seriesKey);
    const v = x?.vol1 || {};

    const prev = prevMap.get(seriesKey);
    const prevVol1 = prev?.vol1 || null;

    const manualMag = norm(magOverrides?.[seriesKey]?.magazine) || null;

    if (!manualMag && isPerfectVol1(prevVol1, hideSet)) {
      magTodoSet.delete(seriesKey);

      const prevClean = { ...prevVol1 };
      const miss = Array.isArray(prevClean.tags_missing_en) ? prevClean.tags_missing_en : [];
      prevClean.tags_missing_en = miss
        .map((raw) => ({ raw, key: normTagKey(raw) }))
        .filter((o) => o.key && !hideSet.has(o.key))
        .map((o) => o.raw);

      enriched.push({ seriesKey, vol1: prevClean, meta: x?.meta || null });
      ok++;
      skippedPerfect++;
      continue;
    }

    const amazonUrl = norm(v?.amazonUrl) || null;
    const isbn13 = norm(v?.isbn13) || null;
    const asin = norm(v?.asin) || null;

    // 連載誌：manual override > 前回値 > wiki
    let magazine = null;
    let magazineSource = null;
    let wikiTitle = null;

    if (manualMag) {
      magazine = manualMag;
      magazineSource = "manual_override";
      wikiTitle = null;
      skippedWiki++;
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

    const magazines = splitMagazines(magazine);

    // 読者層
    const beforeSize = magAudTodoSet.size;
    const audiences = pickAudiences({ magazines, magAudienceMap, todoSet: magAudTodoSet });
    const afterSize = magAudTodoSet.size;
    if (afterSize > beforeSize) magAudienceTodoAdded += afterSize - beforeSize;

    // ★変更点(C)：audiences が「その他」だけなら magazine_todo に積む
    const audiencesOnlyOther =
      Array.isArray(audiences) && audiences.length === 1 && norm(audiences[0]) === "その他";

    // AniList
    let anilistId = prevVol1?.anilistId ?? null;
    let genres = Array.isArray(prevVol1?.genres) ? prevVol1.genres : [];
    let tagsEn = Array.isArray(prevVol1?.tags_en) ? prevVol1.tags_en : [];

    let tagsJa = Array.isArray(prevVol1?.tags) ? prevVol1.tags : [];
    let tagsMissing = Array.isArray(prevVol1?.tags_missing_en) ? prevVol1.tags_missing_en : [];

    if (hasAniListFilled(prevVol1)) {
      const applied = applyTagDict({ tagsEn, tagMap, hideSet, todoSet });
      tagsJa = applied.tags;
      tagsMissing = applied.tags_missing_en;

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
        ng++;
      }
      await sleep(250);
    }

    // Amazon
    const manualTitle = norm(v?.title) || null;

    const prevAmazonDp = norm(prevVol1?.amazonDp) || null;
    const prevImage = norm(prevVol1?.image) || null;
    const prevPublisher = norm(prevVol1?.publisher) || null;
    const prevAuthor = norm(prevVol1?.author) || null;
    const prevReleaseDate = norm(prevVol1?.releaseDate) || null;
    const prevTitle = norm(prevVol1?.title) || null;

    let amzData = null;
    if (asin) {
      const entry = readCacheAmzEntry(cacheAmz, asin);
      if (entry && entry.ok) amzData = entry.data ?? null;
    }

    const amazonDp = prevAmazonDp || norm(amzData?.amazonDp) || null;
    const image = prevImage || norm(amzData?.image) || null;
    const publisher = prevPublisher || norm(amzData?.publisher) || null;
    const author = prevAuthor || norm(amzData?.author) || null;
    const releaseDate = prevReleaseDate || norm(amzData?.releaseDate) || null;
    const title = manualTitle || prevTitle || norm(amzData?.title) || null;

    const synopsis = norm(v?.synopsis) || null;

    /**
     * ★magazine_todo に積む条件（まとめ）
     *  - magazine が空
     *  - split後 magazines が空（ゴミだけ取得→弾かれた）
     *  - audiences が「その他」だけ（= 読者層が実質未判定扱い。話題化したい）
     */
    if (!magazine || magazines.length === 0 || audiencesOnlyOther) magTodoSet.add(seriesKey);
    else magTodoSet.delete(seriesKey);

    if (hasAmazonFilled(prevVol1)) skippedAmz++;

    const outVol1 = {
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
      magazines,
      audiences,

      magazineSource,
      wikiTitle,

      anilistId,
      genres: uniq(genres),

      tags_en: uniq(tagsEn),
      tags: uniq(tagsJa),
      tags_missing_en: uniq(tagsMissing),

      source:
        "enrich(diff+prev+wiki(mag)+anilist(genres)+tagdict+hide+magazine_overrides+paapi+mag_audience)",
    };

    enriched.push({ seriesKey, vol1: outVol1, meta: x?.meta || null });
    ok++;

    evalPerfectNotMetReasons({
      seriesKey,
      vol1: outVol1,
      hideSet,
      reasons: perfectNotMetReasons,
      samples: perfectNotMetSamples,
    });
  }

  cleanupTagTodoSet({ todoSet, tagMap, hideSet });

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

  await saveJson(IN_MAG_AUDIENCE_TODO, {
    version: 1,
    updatedAt: nowIso(),
    total: Array.from(magAudTodoSet).length,
    items: Array.from(magAudTodoSet).sort((a, b) => a.localeCompare(b)),
  });

  await saveJson(OUT_ENRICHED, {
    updatedAt: nowIso(),
    total: sorted.length,
    ok,
    ng,
    stats: {
      skippedPerfect,
      skippedAniList: skippedAni,
      skippedWiki: skippedWiki,
      skippedAmazon: skippedAmz,
      fetchedAmazonAsins: asinsNeed.length,
      magAudienceTodoAdded,
      perfectNotMetReasons,
      perfectNotMetSamples,

      paapi: {
        host: creds.host,
        region: creds.region,
        enabled: creds.enabled,
        chunks: paapiStats.paapiChunks,
        failures: paapiStats.paapiFailures,
        http429: paapiStats.paapi429,
        http503: paapiStats.paapi503,
        missingItems: paapiStats.paapiMissingItems,
        successItems: paapiStats.paapiSuccessItems,
      },
    },
    items: enriched,
  });

  await saveJson(CACHE_ANILIST, cacheAniList);
  await saveJson(CACHE_WIKI, cacheWiki);
  await saveJson(CACHE_AMZ, cacheAmz);

  console.log(
    `[lane2:enrich] total=${sorted.length} ok=${ok} ng=${ng} skipped(perfect=${skippedPerfect}, anilist=${skippedAni}, wiki=${skippedWiki}, amz=${skippedAmz}) fetchedAmazonAsins=${asinsNeed.length} -> ${OUT_ENRICHED}`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
