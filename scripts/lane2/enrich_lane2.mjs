// scripts/lane2/enrich_lane2.mjs
import fs from "node:fs/promises";
import path from "node:path";

const IN_SERIES = "data/lane2/series.json";
const IN_MAG_OVERRIDES = "data/lane2/magazine_overrides.json";

const TAG_JA_MAP = "data/lane2/tag_ja_map.json";
const TAG_HIDE = "data/lane2/tag_hide.json";
const TAG_TODO = "data/lane2/tags_todo.json";

const CACHE_DIR = "data/lane2/cache";
const CACHE_ANILIST = `${CACHE_DIR}/anilist.json`;
const CACHE_WIKI = `${CACHE_DIR}/wiki.json`;

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
async function saveJson(p, obj) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(obj, null, 2));
}

function norm(s) {
  return String(s ?? "").trim();
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

/* -----------------------
 * Tag dict
 * ----------------------- */
function loadTagMap(tagMapJson) {
  const m = tagMapJson?.map && typeof tagMapJson.map === "object" ? tagMapJson.map : {};
  const out = {};
  for (const [k, v] of Object.entries(m)) {
    const kk = norm(k);
    const vv = norm(v);
    if (!kk || !vv) continue;
    out[kk] = vv;
  }
  return out;
}
function loadHideSet(hideJson) {
  const arr = Array.isArray(hideJson?.hide) ? hideJson.hide : [];
  return new Set(arr.map((x) => norm(x)).filter(Boolean));
}
function applyTagDict({ tagsEn, tagMap, hideSet, todoSet }) {
  const outJa = [];
  const missing = [];
  for (const t of uniq(tagsEn)) {
    if (hideSet.has(t)) continue;
    const ja = tagMap[t];
    if (ja) outJa.push(ja);
    else {
      missing.push(t);
      todoSet.add(t);
    }
  }
  return { tags: uniq(outJa), tags_missing_en: uniq(missing) };
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
    cache[key] = null;
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
    if (fmt === "ONE_SHOT") score -= 9999; // 念のため落とす

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
  return stripHtml(m[1]).replace(/\s+/g, " ").trim() || null;
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
    const p = await wikiApi({ action: "parse", pageid: String(bestHit.pageid), prop: "text", redirects: "1" });
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
 * main
 * ----------------------- */
async function main() {
  const seriesJson = await loadJson(IN_SERIES, { version: 1, updatedAt: "", total: 0, items: [] });
  const items = Array.isArray(seriesJson?.items) ? seriesJson.items : [];

  const magOvJson = await loadJson(IN_MAG_OVERRIDES, { version: 1, updatedAt: "", items: {} });
  const magOverrides = magOvJson?.items && typeof magOvJson.items === "object" ? magOvJson.items : {};

  const cacheAniList = (await loadJson(CACHE_ANILIST, {})) || {};
  const cacheWiki = (await loadJson(CACHE_WIKI, {})) || {};

  const tagMapJson = await loadJson(TAG_JA_MAP, { version: 1, updatedAt: "", map: {} });
  const tagMap = loadTagMap(tagMapJson);

  const hideJson = await loadJson(TAG_HIDE, { version: 1, updatedAt: "", hide: [] });
  const hideSet = loadHideSet(hideJson);

  const todoJson = await loadJson(TAG_TODO, { version: 1, updatedAt: "", tags: [] });
  const todoSet = new Set((todoJson?.tags || []).map((x) => norm(x)).filter(Boolean));

  // magazine todo（積み上げ）
  const magTodoPrev = await loadJson(OUT_MAG_TODO, { version: 1, updatedAt: "", items: [] });
  const magTodoSet = new Set((magTodoPrev?.items || []).map((x) => norm(x)).filter(Boolean));

  const enriched = [];
  let ok = 0;
  let ng = 0;

  // series.jsonはあなたが手で積むが、並びの安定のためここで整列（表示＆後続処理のブレ防止）
  const sorted = items
    .map((x) => ({ ...x, seriesKey: norm(x?.seriesKey) }))
    .filter((x) => x.seriesKey)
    .sort((a, b) => a.seriesKey.localeCompare(b.seriesKey));

  for (const x of sorted) {
    const seriesKey = norm(x?.seriesKey);
    const v = x?.vol1 || {};

    const amazonUrl = norm(v?.amazonUrl) || null;
    const isbn13 = norm(v?.isbn13) || null;
    const asin = norm(v?.asin) || null;
    const title = norm(v?.title) || null;
    const synopsis = norm(v?.synopsis) || null;

    // 連載誌：manual override（magazine_overrides） > wiki
    const manualMag = norm(magOverrides?.[seriesKey]?.magazine) || null;

    // wiki
    let wikiMag = null;
    let wikiTitle = null;
    if (!manualMag) {
      const wk = await fetchWikiMagazineBySeriesKey({ seriesKey, cache: cacheWiki });
      wikiMag = wk?.ok ? (wk?.data?.magazine ?? null) : null;
      wikiTitle = wk?.ok ? (wk?.data?.title ?? null) : null;
    }

    const magazine = manualMag || wikiMag || null;

    // anilist
    const an = await fetchAniListBySeriesKey({ seriesKey, cache: cacheAniList });
    const anx = an?.ok ? extractFromAniList(an.data) : { id: null, genres: [], tags: [] };

    const applied = applyTagDict({ tagsEn: anx.tags, tagMap, hideSet, todoSet });

    if (!magazine) magTodoSet.add(seriesKey);
    else magTodoSet.delete(seriesKey);

    enriched.push({
      seriesKey,
      vol1: {
        amazonUrl,
        isbn13,
        asin,
        title,
        synopsis,

        magazine,
        magazineSource: manualMag ? "manual_override" : (wikiMag ? "wikipedia" : null),
        wikiTitle,

        anilistId: anx.id,
        genres: uniq(anx.genres),
        tags_en: uniq(anx.tags),
        tags: applied.tags,
        tags_missing_en: applied.tags_missing_en,

        source: "enrich(wiki(mag)+anilist+tagdict+hide+magazine_overrides)",
      },
      meta: x?.meta || null,
    });

    ok++;
    await sleep(250); // AniList/Wikiの負荷を軽く
  }

  // tags_todo.json 更新（辞書育成）
  await saveJson(TAG_TODO, {
    version: 1,
    updatedAt: nowIso(),
    tags: Array.from(todoSet).sort((a, b) => a.localeCompare(b)),
  });

  // magazine_todo.json 更新
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
    items: enriched,
  });

  await saveJson(CACHE_ANILIST, cacheAniList);
  await saveJson(CACHE_WIKI, cacheWiki);

  console.log(`[lane2:enrich] total=${sorted.length} ok=${ok} ng=${ng} -> ${OUT_ENRICHED}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
