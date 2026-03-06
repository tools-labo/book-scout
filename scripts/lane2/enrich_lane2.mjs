// scripts/lane2/enrich_lane2.mjs
// FULL REPLACE
// 1/3
// - sharded enriched を維持
// - 書誌メタ取得層を中立化（provider は現状 Rakuten）
// - vol1 出力キーは downstream 互換を優先して維持
// - amazonDp は manual amazonUrl / prev を使って埋める
// - title / image / publisher / author / releaseDate は Rakuten で補完
// - synopsis は引き続き series.json 手動値を優先
//
// 【分割ルール】
// - 1/3 はこの END マーカーで必ず終わる
// - 2/3 は START マーカーから必ず始める
// - 3/3 は START マーカーから必ず始める
// token: R7K2

import fs from "node:fs/promises";
import path from "node:path";

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
const CACHE_BOOK_META = `${CACHE_DIR}/book_meta.json`;

// ★旧（互換読み取り用：書き出しはしない）
const LEGACY_ENRICHED = "data/lane2/enriched.json";

// ★新：sharded enriched
const OUT_ENRICH_DIR = "data/lane2/enriched";
const OUT_ENRICH_INDEX = `${OUT_ENRICH_DIR}/index.json`;
const OUT_ENRICH_PREFIX = "enriched_";
const ENRICH_SHARD_SIZE = 200;

const OUT_MAG_TODO = "data/lane2/magazine_todo.json";

// Rakuten Books Total Search
const RAKUTEN_BOOKS_TOTAL_URL =
  "https://openapi.rakuten.co.jp/services/api/BooksTotal/Search/20170404";

function nowIso() { return new Date().toISOString(); }

async function loadJson(p, fallback) {
  try { return JSON.parse(await fs.readFile(p, "utf8")); }
  catch { return fallback; }
}

async function loadJsonStrict(p) {
  const txt = await fs.readFile(p, "utf8");
  try { return JSON.parse(txt); }
  catch (e) {
    const msg = e?.message ? String(e.message) : String(e);
    throw new Error(`[lane2:enrich] JSON parse failed: ${p} (${msg})`);
  }
}

async function saveJson(p, obj) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(obj, null, 2));
}

async function fileExists(p) {
  try { await fs.stat(p); return true; } catch { return false; }
}

function norm(s) { return String(s ?? "").trim(); }

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

function normMagazineKey(s) {
  return String(s ?? "")
    .replace(/\u00A0/g, " ")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/[　]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .normalize("NFKC");
}

function toHalfWidth(s) {
  return String(s ?? "")
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[（]/g, "(")
    .replace(/[）]/g, ")")
    .replace(/[　]/g, " ");
}
function normLoose(s) { return norm(s).replace(/\s+/g, ""); }

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

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function assertNonEmptySeries(sorted) {
  if (!Array.isArray(sorted)) throw new Error("[lane2:enrich] series items is not an array");
  if (sorted.length === 0) {
    throw new Error("[lane2:enrich] series has 0 items after normalization. Refusing to overwrite outputs.");
  }
}

/* -----------------------
 * Sharded IO helpers (enriched)
 * ----------------------- */
function shardFileName(prefix, i) {
  return `${prefix}${String(i).padStart(3, "0")}.json`;
}

async function loadEnrichedSharded() {
  const idxExists = await fileExists(OUT_ENRICH_INDEX);
  if (!idxExists) return null;

  const idx = await loadJsonStrict(OUT_ENRICH_INDEX);
  const shards = Array.isArray(idx?.shards) ? idx.shards : [];
  if (!shards.length) return { updatedAt: idx?.updatedAt ?? "", total: 0, items: [] };

  const all = [];
  for (const sh of shards) {
    const file = norm(sh?.file);
    if (!file) continue;
    const p = path.join(OUT_ENRICH_DIR, file);
    const j = await loadJson(p, { items: [] });
    const items = Array.isArray(j?.items) ? j.items : [];
    all.push(...items);
  }

  return {
    updatedAt: idx?.updatedAt ?? "",
    total: Number(idx?.total || all.length),
    items: all,
  };
}

async function loadPrevEnrichedCompat() {
  try {
    const sh = await loadEnrichedSharded();
    if (sh) return sh;
  } catch (e) {
    console.log(`[lane2:enrich] warn: failed to read sharded enriched: ${String(e?.message || e)}`);
  }

  const legacy = await loadJson(LEGACY_ENRICHED, { updatedAt: "", total: 0, items: [] });
  const items = Array.isArray(legacy?.items) ? legacy.items : [];
  return {
    updatedAt: legacy?.updatedAt ?? "",
    total: Number(legacy?.total || items.length),
    items,
  };
}

async function writeEnrichedSharded({ items, updatedAt, stats }) {
  await fs.mkdir(OUT_ENRICH_DIR, { recursive: true });

  const shards = [];
  const lookup = {};
  const total = items.length;

  const nShards = Math.max(1, Math.ceil(total / ENRICH_SHARD_SIZE));

  for (let i = 0; i < nShards; i++) {
    const slice = items.slice(i * ENRICH_SHARD_SIZE, (i + 1) * ENRICH_SHARD_SIZE);
    const file = shardFileName(OUT_ENRICH_PREFIX, i);

    shards.push({ file, count: slice.length });

    for (const it of slice) {
      const sk = norm(it?.seriesKey);
      if (!sk) continue;
      lookup[sk] = i;
    }

    await saveJson(path.join(OUT_ENRICH_DIR, file), {
      version: 1,
      shard: i,
      count: slice.length,
      items: slice,
    });
  }

  await saveJson(OUT_ENRICH_INDEX, {
    version: 1,
    updatedAt: updatedAt || nowIso(),
    total,
    shardSize: ENRICH_SHARD_SIZE,
    shards,
    lookup,
    stats: stats || {},
  });
}

/* -----------------------
 * HTML strip / decode
 * ----------------------- */
function stripHtml(s) {
  let x = String(s ?? "");
  x = x.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "");

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
function cleanupTagTodoSet({ todoSet, tagMap, hideSet }) {
  if (!(todoSet instanceof Set)) return;
  const hs = hideSet instanceof Set ? hideSet : new Set();
  const tm = tagMap && typeof tagMap === "object" ? tagMap : {};
  for (const k of Array.from(todoSet)) {
    if (!k) { todoSet.delete(k); continue; }
    if (hs.has(k)) { todoSet.delete(k); continue; }
    if (Object.prototype.hasOwnProperty.call(tm, k)) { todoSet.delete(k); continue; }
  }
}
function applyTagDict({ tagsEn, tagMap, hideSet, todoSet }) {
  const outJa = [];
  const missing = [];
  const hs = hideSet instanceof Set ? hideSet : new Set();

  for (const raw of uniq(tagsEn)) {
    const key = normTagKey(raw);
    if (!key) continue;
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
 * Completeness checks
 * ----------------------- */
function hasBookMetaFilled(vol1) {
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

function hasMagazineMetaFilled(vol1) {
  return !!(
    vol1 &&
    norm(vol1.magazine) &&
    Array.isArray(vol1.magazines) &&
    vol1.magazines.length > 0 &&
    Array.isArray(vol1.audiences) &&
    vol1.audiences.length > 0
  );
}

function hasAniListMetaFilled(vol1) {
  return !!(
    vol1 &&
    vol1.anilistId &&
    Array.isArray(vol1.genres) &&
    vol1.genres.length > 0 &&
    Array.isArray(vol1.tags_en) &&
    vol1.tags_en.length > 0
  );
}

function hasJaTagsFilled(vol1, hideSet) {
  if (!vol1) return false;
  if (!Array.isArray(vol1.tags) || vol1.tags.length === 0) return false;

  const miss = Array.isArray(vol1.tags_missing_en) ? vol1.tags_missing_en : [];
  if (miss.length === 0) return true;

  const hs = hideSet instanceof Set ? hideSet : new Set();
  const remain = miss
    .map((x) => normTagKey(x))
    .filter(Boolean)
    .filter((k) => !hs.has(k));

  return remain.length === 0;
}

function isPerfectVol1(vol1, hideSet) {
  if (!vol1) return false;
  if (!hasBookMetaFilled(vol1)) return false;
  if (!hasMagazineMetaFilled(vol1)) return false;
  if (!hasAniListMetaFilled(vol1)) return false;
  if (!hasJaTagsFilled(vol1, hideSet)) return false;
  return true;
}

function explainPerfectFail(vol1, hideSet) {
  const reasons = [];
  if (!vol1) return ["noVol1"];

  if (!hasBookMetaFilled(vol1)) {
    const miss = [];
    if (!norm(vol1.amazonDp)) miss.push("amazonDp");
    if (!norm(vol1.image)) miss.push("image");
    if (!norm(vol1.publisher)) miss.push("publisher");
    if (!norm(vol1.author)) miss.push("author");
    if (!norm(vol1.releaseDate)) miss.push("releaseDate");
    if (!norm(vol1.title)) miss.push("title");
    reasons.push(`bookMeta(${miss.join("|") || "unknown"})`);
  }

  if (!hasMagazineMetaFilled(vol1)) {
    if (!norm(vol1.magazine)) reasons.push("magazine");
    if (!Array.isArray(vol1.magazines) || vol1.magazines.length === 0) reasons.push("magazines[]");
    if (!Array.isArray(vol1.audiences) || vol1.audiences.length === 0) reasons.push("audiences[]");
  }

  if (!hasAniListMetaFilled(vol1)) {
    const miss = [];
    if (!vol1.anilistId) miss.push("anilistId");
    if (!Array.isArray(vol1.genres) || vol1.genres.length === 0) miss.push("genres[]");
    if (!Array.isArray(vol1.tags_en) || vol1.tags_en.length === 0) miss.push("tags_en[]");
    reasons.push(`anilist(${miss.join("|") || "unknown"})`);
  }

  if (!Array.isArray(vol1.tags) || vol1.tags.length === 0) reasons.push("tagsJa[]");

  const miss = Array.isArray(vol1.tags_missing_en) ? vol1.tags_missing_en : [];
  if (miss.length > 0) {
    const hs = hideSet instanceof Set ? hideSet : new Set();
    const remain = miss
      .map((x) => normTagKey(x))
      .filter(Boolean)
      .filter((k) => !hs.has(k));
    if (remain.length > 0) reasons.push(`tags_missing_en(remain=${remain.length})`);
  }

  return reasons;
}

/* -----------------------
 * perfect未達理由の集計（debug用）
 * ----------------------- */
function bumpReason(reasons, key) { reasons[key] = (reasons[key] || 0) + 1; }
function pushSampleLine(samples, key, line, limit = 12) {
  if (!samples[key]) samples[key] = [];
  if (samples[key].length >= limit) return;
  samples[key].push(line);
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

  if (!r.ok) return { ok: false, reason: `anilist_http_${r.status}` };

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
    ].filter(Boolean).map((t) => normLoose(toHalfWidth(t)));

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

/* END PART 1/3 - token: R7K2 */

/* START PART 2/3 - token: R7K2 */

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
  const r = await fetch(url, {
    headers: { "user-agent": "tools-labo/book-scout lane2 wiki" },
  });
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

  const bestHit = results.find((x) => wikiTitleLooksOk({ wikiTitle: x?.title, seriesKey: key })) || null;
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
  const out = {
    pageid: bestHit.pageid,
    title: bestHit.title || null,
    magazine: magazine || null,
  };
  cache[key] = out;
  return { ok: true, data: out, found: true };
}

/* -----------------------
 * Rakuten Books Total Search
 * ----------------------- */
function summarizeRakutenError({ status, json, text }) {
  const code =
    json?.errors?.errorCode ??
    json?.errorCode ??
    status ??
    null;

  const message =
    json?.errors?.errorMessage ??
    json?.errorMessage ??
    null;

  const shortText = (() => {
    const t = String(text ?? "");
    if (!t) return null;
    return t.length > 180 ? t.slice(0, 180) + "…" : t;
  })();

  return { code, message, shortText };
}

function extractRakutenItem(item) {
  if (!item || typeof item !== "object") return null;

  const large = norm(item?.largeImageUrl);
  const medium = norm(item?.mediumImageUrl);
  const small = norm(item?.smallImageUrl);

  return {
    title: norm(item?.title) || null,
    author: norm(item?.author) || null,
    publisher: norm(item?.publisherName) || null,
    releaseDate: norm(item?.salesDate) || null,
    image: large || medium || small || null,
    rakutenUrl: norm(item?.itemUrl) || null,
    rakutenAffiliateUrl: norm(item?.affiliateUrl) || null,
  };
}

function readCacheBookMetaEntry(cacheBookMeta, isbn13) {
  const v = cacheBookMeta?.[isbn13];
  if (!v) return null;

  if (v && typeof v === "object" && "ok" in v) return v;
  if (v && typeof v === "object") {
    return { ok: true, data: v, at: nowIso(), legacyWrapped: true };
  }
  return null;
}

function writeCacheBookMetaSuccess(cacheBookMeta, isbn13, data) {
  cacheBookMeta[isbn13] = { ok: true, data: data ?? null, at: nowIso() };
}

function writeCacheBookMetaError(cacheBookMeta, isbn13, { kind, status, error }) {
  cacheBookMeta[isbn13] = {
    ok: false,
    kind,
    status: status ?? null,
    error: error ?? null,
    at: nowIso(),
  };
}

async function fetchRakutenByIsbn13({ isbn13, creds }) {
  const url = new URL(RAKUTEN_BOOKS_TOTAL_URL);
  url.searchParams.set("applicationId", creds.appId);
  url.searchParams.set("accessKey", creds.accessKey);
  url.searchParams.set("format", "json");
  url.searchParams.set("formatVersion", "2");
  url.searchParams.set("isbnjan", isbn13);
  url.searchParams.set("outOfStockFlag", "1");
  if (creds.affiliateId) url.searchParams.set("affiliateId", creds.affiliateId);

  const headers = {
    "User-Agent": "tools-labo/book-scout lane2 rakuten",
  };
  if (creds.referer) headers.Referer = creds.referer;
  if (creds.origin) headers.Origin = creds.origin;

  const r = await fetch(url.toString(), {
    method: "GET",
    headers,
  });

  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }

  if (!r.ok) return { ok: false, status: r.status, json, text };

  const items = Array.isArray(json?.Items) ? json.Items : [];
  const first = items[0] || null;
  if (!first) {
    return { ok: true, status: r.status, json, item: null, found: false };
  }

  return { ok: true, status: r.status, json, item: first, found: true };
}

async function fetchRakutenByIsbn13s({ isbn13s, cacheBookMeta, creds, stats }) {
  const want = [];

  for (const raw of isbn13s) {
    const isbn13 = norm(raw);
    if (!isbn13) continue;

    const entry = readCacheBookMetaEntry(cacheBookMeta, isbn13);
    if (entry && entry.ok) continue;

    if (entry && entry.ok === false && entry.kind === "temporary") {
      want.push(isbn13);
      continue;
    }
    if (entry && entry.ok === false && entry.kind === "permanent") {
      continue;
    }
    want.push(isbn13);
  }

  if (!want.length) return;

  if (!creds?.enabled) {
    for (const isbn13 of want) {
      writeCacheBookMetaError(cacheBookMeta, isbn13, {
        kind: "temporary",
        status: null,
        error: {
          code: "RAKUTEN_CREDS_MISSING",
          message: "Rakuten creds missing",
          shortText: null,
        },
      });
    }
    return;
  }

  for (const isbn13 of want) {
    if (stats) stats.requests++;

    let res = null;
    const max = 3;
    let wait = 700;

    for (let attempt = 1; attempt <= max; attempt++) {
      res = await fetchRakutenByIsbn13({ isbn13, creds });

      if (res.ok) break;

      const retryable = [403, 429, 500, 502, 503, 504].includes(res.status);
      const err = summarizeRakutenError({ status: res.status, json: res.json, text: res.text });

      console.log(
        `[lane2:enrich] rakuten http_${res.status} attempt=${attempt}/${max} retryable=${retryable} wait=${wait}ms isbn13=${isbn13} code=${err.code ?? "-"} msg=${(err.message ?? "").slice(0, 120)}`
      );

      if (!retryable || attempt === max) break;
      await sleep(wait);
      wait *= 2;
    }

    if (!res || !res.ok) {
      const status = res?.status ?? null;

      // 403 は設定修正後に再取得させたいので permanent にしない
      const retryableOrRecoverable =
        status != null ? [403, 429, 500, 502, 503, 504].includes(status) : true;

      const kind = retryableOrRecoverable ? "temporary" : "permanent";
      const err = summarizeRakutenError({ status, json: res?.json, text: res?.text });

      writeCacheBookMetaError(cacheBookMeta, isbn13, {
        kind,
        status,
        error: err,
      });

      if (stats) {
        stats.failures++;
        if (status === 403) stats.http403++;
        if (status === 429) stats.http429++;
      }

      await sleep(250);
      continue;
    }

    if (!res.item) {
      writeCacheBookMetaError(cacheBookMeta, isbn13, {
        kind: "temporary",
        status: 200,
        error: {
          code: "ITEM_NOT_FOUND",
          message: "Rakuten returned no item for this isbn13",
          shortText: null,
        },
      });
      if (stats) stats.missingItems++;
      await sleep(150);
      continue;
    }

    const extracted = extractRakutenItem(res.item);
    writeCacheBookMetaSuccess(cacheBookMeta, isbn13, extracted);
    if (stats) stats.successItems++;

    await sleep(150);
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
      console.log(`[lane2:enrich] anilist http_429 seriesKey="${seriesKey}" attempt=${i}/${max} wait=${wait}ms`);
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
    p.split("→").map((x) => norm(x)).filter(Boolean)
  );

  return uniq(mags.map(normMagazineKey)).filter(isPlausibleMagazineName);
}

function loadMagAudienceMap(json) {
  const items = json?.items && typeof json.items === "object" ? json.items : {};
  const out = new Map();
  for (const [aud, mags] of Object.entries(items)) {
    if (!Array.isArray(mags)) continue;
    for (const m of mags) {
      const k = normMagazineKey(m);
      if (!k) continue;
      out.set(k, aud);
    }
  }
  return out;
}

function splitByDictOnlyIfAllKnown(raw, magAudienceMap) {
  const s = normMagazineKey(raw);
  if (!s) return [];
  if (magAudienceMap.has(s)) return [s];
  if (!/\s/.test(s)) return [s];

  const parts = s.split(/\s+/g).map(normMagazineKey).filter(Boolean);
  if (parts.length >= 2 && parts.every((p) => magAudienceMap.has(p))) return parts;
  return [s];
}

function pickAudiences({ magazines, magAudienceMap, todoSet }) {
  const auds = new Set();

  for (const m0 of magazines) {
    const candidates = splitByDictOnlyIfAllKnown(m0, magAudienceMap);
    for (const m of candidates) {
      const mm = normMagazineKey(m);
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
 * notPerfect summary helpers
 * ----------------------- */
function pushCap(arr, v, cap) {
  if (!v) return;
  if (arr.length >= cap) return;
  arr.push(v);
}

function parseFailLine(line) {
  const s = String(line ?? "");
  const parts = s.split("::");
  const seriesKey = norm(parts[0] ?? "");
  const rest = norm(parts.slice(1).join("::"));
  const reasons = rest
    ? rest.split(",").map((x) => norm(x)).filter(Boolean)
    : [];
  return { seriesKey, reasons };
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

  const prevEnriched = await loadPrevEnrichedCompat();
  const prevItems = Array.isArray(prevEnriched?.items) ? prevEnriched.items : [];
  const prevMap = new Map(prevItems.map((x) => [norm(x?.seriesKey), x]).filter(([k]) => k));

  await fs.mkdir(CACHE_DIR, { recursive: true });

  const cacheAniList = (await loadJson(CACHE_ANILIST, {})) || {};
  const cacheWiki = (await loadJson(CACHE_WIKI, {})) || {};
  const cacheBookMeta = (await loadJson(CACHE_BOOK_META, {})) || {};

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

  const rakutenCreds = {
    appId: norm(process.env.RAKUTEN_APP_ID),
    accessKey: norm(process.env.RAKUTEN_ACCESS_KEY),
    affiliateId: norm(process.env.RAKUTEN_AFFILIATE_ID),
    referer: norm(process.env.RAKUTEN_TEST_REFERER) || "https://book-scout.tools-labo.com/",
    origin: norm(process.env.RAKUTEN_TEST_ORIGIN) || "https://book-scout.tools-labo.com",
  };
  rakutenCreds.enabled = !!(rakutenCreds.appId && rakutenCreds.accessKey);

  const sorted = items
    .map((x) => ({ ...x, seriesKey: norm(x?.seriesKey) }))
    .filter((x) => x.seriesKey)
    .sort((a, b) => a.seriesKey.localeCompare(b.seriesKey));

  assertNonEmptySeries(sorted);

  // 差分取得対象は isbn13 ベース
  const isbn13Need = [];
  for (const x of sorted) {
    const seriesKey = norm(x?.seriesKey);
    const v = x?.vol1 || {};
    const isbn13 = norm(v?.isbn13) || null;
    if (!isbn13) continue;

    const prev = prevMap.get(seriesKey);
    const prevVol1 = prev?.vol1 || null;

    if (hasBookMetaFilled(prevVol1)) continue;
    isbn13Need.push(isbn13);
  }

  const bookMetaStats = {
    provider: "rakuten",
    enabled: rakutenCreds.enabled,
    requests: 0,
    failures: 0,
    http403: 0,
    http429: 0,
    missingItems: 0,
    successItems: 0,
  };

  await fetchRakutenByIsbn13s({
    isbn13s: isbn13Need,
    cacheBookMeta,
    creds: rakutenCreds,
    stats: bookMetaStats,
  });

  const enriched = [];
  let ok = 0;
  let ng = 0;
  let skippedAniList = 0;
  let skippedWiki = 0;
  let skippedBookMeta = 0;
  let skippedPerfect = 0;
  let magAudienceTodoAdded = 0;

  const perfectNotMetReasons = { prevNotPerfect: 0, outNotPerfect: 0 };
  const perfectNotMetSamples = {};

  // notPerfectSummary は sample ではなく全件集計する
  const allOutNotPerfectLines = [];

  for (const x of sorted) {
    const seriesKey = norm(x?.seriesKey);
    const v = x?.vol1 || {};

    const prev = prevMap.get(seriesKey);
    const prevVol1 = prev?.vol1 || null;

    const manualMag = norm(magOverrides?.[seriesKey]?.magazine) || null;
    const manualMagSameAsPrev =
      !!manualMag &&
      !!norm(prevVol1?.magazine) &&
      norm(prevVol1?.magazine) === manualMag;

    if (!isPerfectVol1(prevVol1, hideSet)) {
      bumpReason(perfectNotMetReasons, "prevNotPerfect");
      const fails = explainPerfectFail(prevVol1, hideSet);
      pushSampleLine(
        perfectNotMetSamples,
        "prevNotPerfect",
        `${seriesKey} :: ${fails.join(",") || "unknown"}`
      );
    }

    if ((manualMagSameAsPrev || !manualMag) && isPerfectVol1(prevVol1, hideSet)) {
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

    // 連載誌: manual override > prev > wiki
    let magazine = null;
    let magazineSource = null;
    let wikiTitle = null;

    if (manualMag) {
      magazine = manualMag;
      magazineSource = "manual_override";
      wikiTitle = null;
      skippedWiki++;
    } else if (prevVol1 && norm(prevVol1.magazine)) {
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

    const beforeSize = magAudTodoSet.size;
    const audiences = pickAudiences({ magazines, magAudienceMap, todoSet: magAudTodoSet });
    const afterSize = magAudTodoSet.size;
    if (afterSize > beforeSize) magAudienceTodoAdded += afterSize - beforeSize;

    const audiencesOnlyOther =
      Array.isArray(audiences) &&
      audiences.length === 1 &&
      norm(audiences[0]) === "その他";

    // AniList
    let anilistId = prevVol1?.anilistId ?? null;
    let genres = Array.isArray(prevVol1?.genres) ? prevVol1.genres : [];
    let tagsEn = Array.isArray(prevVol1?.tags_en) ? prevVol1.tags_en : [];

    let tagsJa = Array.isArray(prevVol1?.tags) ? prevVol1.tags : [];
    let tagsMissing = Array.isArray(prevVol1?.tags_missing_en) ? prevVol1.tags_missing_en : [];

    if (hasAniListMetaFilled(prevVol1)) {
      const applied = applyTagDict({ tagsEn, tagMap, hideSet, todoSet });
      tagsJa = applied.tags;
      tagsMissing = applied.tags_missing_en;
      skippedAniList++;
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

    // Book meta（provider: Rakuten）
    const manualTitle = norm(v?.title) || null;

    const prevAmazonDp = norm(prevVol1?.amazonDp) || null;
    const prevImage = norm(prevVol1?.image) || null;
    const prevPublisher = norm(prevVol1?.publisher) || null;
    const prevAuthor = norm(prevVol1?.author) || null;
    const prevReleaseDate = norm(prevVol1?.releaseDate) || null;
    const prevTitle = norm(prevVol1?.title) || null;
    const prevRakutenUrl = norm(prevVol1?.rakutenUrl) || null;
    const prevRakutenAffiliateUrl = norm(prevVol1?.rakutenAffiliateUrl) || null;

    let bookMetaData = null;
    if (isbn13) {
      const entry = readCacheBookMetaEntry(cacheBookMeta, isbn13);
      if (entry && entry.ok) bookMetaData = entry.data ?? null;
    }

    const usedRakuten = !!bookMetaData;

    const amazonDp = prevAmazonDp || amazonUrl || null;
    const image = prevImage || norm(bookMetaData?.image) || null;
    const publisher = prevPublisher || norm(bookMetaData?.publisher) || null;
    const author = prevAuthor || norm(bookMetaData?.author) || null;
    const releaseDate = prevReleaseDate || norm(bookMetaData?.releaseDate) || null;
    const title = manualTitle || prevTitle || norm(bookMetaData?.title) || null;

    const rakutenUrl = prevRakutenUrl || norm(bookMetaData?.rakutenUrl) || null;
    const rakutenAffiliateUrl =
      prevRakutenAffiliateUrl || norm(bookMetaData?.rakutenAffiliateUrl) || null;

    const bookMetaSource =
      usedRakuten ? "rakuten" :
      hasBookMetaFilled(prevVol1) ? "prev" :
      (manualTitle || amazonUrl) ? "manual" :
      null;

    const synopsis = norm(v?.synopsis) || null;

    const needMagTodo = (() => {
      if (manualMag) return false;
      if (!magazine) return true;
      if (magazines.length === 0) return true;
      if (audiencesOnlyOther) return true;
      return false;
    })();

    if (needMagTodo) magTodoSet.add(seriesKey);
    else magTodoSet.delete(seriesKey);

    if (hasBookMetaFilled(prevVol1)) skippedBookMeta++;

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

      rakutenUrl,
      rakutenAffiliateUrl,
      bookMetaSource,

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

      source: "enrich(sharded+prev+wiki+anilist+tagdict+hide+magazine_overrides+book_meta(rakuten)+mag_audience)",
    };

    enriched.push({ seriesKey, vol1: outVol1, meta: x?.meta || null });
    ok++;

    if (!isPerfectVol1(outVol1, hideSet)) {
      bumpReason(perfectNotMetReasons, "outNotPerfect");
      const fails = explainPerfectFail(outVol1, hideSet);
      const line = `${seriesKey} :: ${fails.join(",") || "unknown"}`;
      pushSampleLine(perfectNotMetSamples, "outNotPerfect", line);
      allOutNotPerfectLines.push(line);
    }
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

  const NOT_PERFECT_KEYS_LIMIT = 80;
  const NOT_PERFECT_TOP_REASONS = 12;
  const NOT_PERFECT_REASON_SAMPLES = 8;

  const outLines = allOutNotPerfectLines;

  const notPerfectSeriesKeys = [];
  const seenSk = new Set();

  const reasonCounts = {};
  const reasonSamples = {};

  for (const line of outLines) {
    const { seriesKey, reasons } = parseFailLine(line);
    if (seriesKey && !seenSk.has(seriesKey)) {
      seenSk.add(seriesKey);
      pushCap(notPerfectSeriesKeys, seriesKey, NOT_PERFECT_KEYS_LIMIT);
    }

    for (const r of reasons) {
      if (!r) continue;
      reasonCounts[r] = (reasonCounts[r] || 0) + 1;
      if (!reasonSamples[r]) reasonSamples[r] = [];
      if (seriesKey && reasonSamples[r].length < NOT_PERFECT_REASON_SAMPLES) {
        if (!reasonSamples[r].includes(seriesKey)) reasonSamples[r].push(seriesKey);
      }
    }
  }

  const notPerfectTopReasons = Object.entries(reasonCounts)
    .map(([reason, n]) => ({
      reason,
      n,
      samples: reasonSamples[reason] || [],
    }))
    .sort((a, b) => (b.n ?? 0) - (a.n ?? 0))
    .slice(0, NOT_PERFECT_TOP_REASONS);

  const notPerfectSummary = {
    notPerfectTotal: seenSk.size,
    seriesKeys: notPerfectSeriesKeys,
    topReasons: notPerfectTopReasons,
    note: "outNotPerfect 全件から再集計（unique seriesKey + 理由TOP）。",
  };

/* END PART 2/3 - token: R7K2 */


/* START PART 3/3 - token: R7K2 */

  await writeEnrichedSharded({
    items: enriched,
    updatedAt: nowIso(),
    stats: {
      total: sorted.length,
      ok,
      ng,
      skippedPerfect,
      skippedAniList,
      skippedWiki,
      skippedBookMeta,
      fetchedBookMetaIsbn13s: isbn13Need.length,
      magAudienceTodoAdded,
      perfectNotMetReasons,
      perfectNotMetSamples,
      notPerfectSummary,
      bookMeta: {
        provider: bookMetaStats.provider,
        enabled: bookMetaStats.enabled,
        requests: bookMetaStats.requests,
        failures: bookMetaStats.failures,
        http403: bookMetaStats.http403,
        http429: bookMetaStats.http429,
        missingItems: bookMetaStats.missingItems,
        successItems: bookMetaStats.successItems,
      },
    },
  });

  await saveJson(CACHE_ANILIST, cacheAniList);
  await saveJson(CACHE_WIKI, cacheWiki);
  await saveJson(CACHE_BOOK_META, cacheBookMeta);

  console.log(
    `[lane2:enrich] total=${sorted.length} ok=${ok} ng=${ng} skipped(perfect=${skippedPerfect}, anilist=${skippedAniList}, wiki=${skippedWiki}, bookMeta=${skippedBookMeta}) fetchedBookMetaIsbn13s=${isbn13Need.length} -> ${OUT_ENRICH_INDEX}`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

/* END PART 3/3 - token: R7K2 */
