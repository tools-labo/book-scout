// scripts/manga/fill_series_synopsis.mjs（全差し替え・needsOverride特定ログ版）
//
// 目的: series_master の各シリーズに synopsis(=vol1.description) を埋める
// 優先: overrides(idキー) > 既存vol1.description > Rakuten(itemCaption by ISBN) > Wikipedia(概要)
//
// 環境変数:
// - RAKUTEN_APP_ID
// - TARGET_ONLY=1 : list_items(29件)のみ
// - WIKI_MAX=30
// - DEBUG_KEYS=1
//
import fs from "node:fs/promises";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const APP_ID = process.env.RAKUTEN_APP_ID || "";
const TARGET_ONLY = process.env.TARGET_ONLY === "1";
const WIKI_MAX = Number(process.env.WIKI_MAX || "30");
const DEBUG_KEYS = process.env.DEBUG_KEYS === "1";

const UA = { "User-Agent": "book-scout-bot" };
const digits = (s) => String(s || "").replace(/\D/g, "");
const isDigits = (s) => /^\d+$/.test(String(s || "").trim());

const SERIES_PATH = "data/manga/series_master.json";
const OVERRIDE_PATH = "data/manga/overrides_synopsis.json";
const LIST_ITEMS_PATH = "data/manga/list_items.json";
const ANILIST_BY_WORK_PATH = "data/manga/anilist_by_work.json";

async function readJson(path, fallback) {
  try {
    return JSON.parse(await fs.readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

async function fetchJson(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), 15000);
    try {
      const r = await fetch(url, { cache: "no-store", signal: ac.signal, headers: UA });
      clearTimeout(to);
      const t = await r.text();
      if (r.ok) return JSON.parse(t);
      if ((r.status === 429 || r.status >= 500) && i < tries - 1) {
        await sleep(800 + i * 600);
        continue;
      }
      return null;
    } catch {
      clearTimeout(to);
      if (i < tries - 1) {
        await sleep(800 + i * 600);
        continue;
      }
      return null;
    }
  }
  return null;
}

// Rakuten itemCaption by ISBN
async function rakutenCaptionByIsbn(isbn13) {
  if (!APP_ID) return null;
  const url =
    "https://app.rakuten.co.jp/services/api/BooksBook/Search/20170404" +
    `?applicationId=${encodeURIComponent(APP_ID)}` +
    `&isbn=${encodeURIComponent(digits(isbn13))}` +
    "&format=json&hits=1&elements=itemCaption";
  const j = await fetchJson(url);
  const cap = (j?.Items?.[0]?.Item?.itemCaption || "").trim();
  return cap || null;
}

// Wikipedia (ja)
async function wikiSearchTitle(q) {
  const url =
    "https://ja.wikipedia.org/w/api.php" +
    `?action=query&list=search&srsearch=${encodeURIComponent(q)}` +
    "&srlimit=5&format=json&origin=*";
  const j = await fetchJson(url);
  return j?.query?.search?.[0]?.title || null;
}
async function wikiExtract(title) {
  if (!title) return null;
  const url =
    "https://ja.wikipedia.org/w/api.php" +
    `?action=query&prop=extracts&explaintext=1&exintro=1&titles=${encodeURIComponent(title)}` +
    "&format=json&origin=*";
  const j = await fetchJson(url);
  const pages = j?.query?.pages || {};
  const firstKey = Object.keys(pages)[0];
  const ex = (pages?.[firstKey]?.extract || "").trim();
  if (!ex) return null;

  const lines = ex.split("\n").map((x) => x.trim()).filter(Boolean);
  const joined = lines.join("\n").trim();
  if (joined.length < 80) return null;
  return joined.length > 900 ? joined.slice(0, 900).trim() + "…" : joined;
}

function pickWorkKeyFromListItem(it) {
  const cands = [
    it?.workKey,
    it?.seriesKey,
    it?.work?.key,
    it?.work?.workKey,
    it?.series?.key,
    it?.series?.workKey,
    it?.series?.seriesKey,
  ];
  for (const v of cands) {
    const s = String(v || "").trim();
    if (s) return s;
  }
  const t = it?.title || it?.latest?.title || it?.series?.title || null;
  return t ? String(t).trim() : null;
}

function buildWorkKeyToAnilistId(anilistByWork) {
  const map = new Map();
  if (anilistByWork && typeof anilistByWork === "object" && !Array.isArray(anilistByWork)) {
    for (const [wk, v] of Object.entries(anilistByWork)) {
      const id = String(v?.anilistId || v?.anilist?.id || v?.id || "").trim();
      if (wk && isDigits(id)) map.set(String(wk).trim(), id);
    }
  }
  return map;
}

function getSynopsis(s) {
  const cur = s?.vol1?.description;
  return cur ? String(cur).trim() : "";
}
function setSynopsis(s, synopsis) {
  if (!s.vol1) s.vol1 = {};
  s.vol1.description = synopsis;
}
function pickVol1Isbn(s) {
  const v = s?.vol1 || null;
  return v?.isbn13 || v?.isbn || null;
}
function pickTitleForWiki(s) {
  return (
    s?.titleNative ||
    s?.titleRomaji ||
    s?.seriesKey ||
    s?.anilist?.title?.native ||
    s?.anilist?.title?.romaji ||
    s?.anilist?.title?.english ||
    null
  );
}

const root = await readJson(SERIES_PATH, { meta: {}, items: {} });
const items = root?.items && typeof root.items === "object" ? root.items : {};

const overridesRaw = await readJson(OVERRIDE_PATH, {});
const overrides = overridesRaw && typeof overridesRaw === "object" ? overridesRaw : {};

let targetIds = null;

if (TARGET_ONLY) {
  const listRaw = await readJson(LIST_ITEMS_PATH, []);
  const list = Array.isArray(listRaw) ? listRaw : (listRaw?.items || []);
  const anilistByWork = await readJson(ANILIST_BY_WORK_PATH, {});
  const wk2id = buildWorkKeyToAnilistId(anilistByWork);

  const workKeys = [];
  for (const it of list) {
    const wk = pickWorkKeyFromListItem(it);
    if (wk) workKeys.push(wk);
  }

  const ids = [];
  const missingWorkKeys = [];
  for (const wk of workKeys) {
    const id = wk2id.get(wk);
    if (id) ids.push(id);
    else missingWorkKeys.push(wk);
  }

  targetIds = Array.from(new Set(ids));

  if (DEBUG_KEYS) {
    console.log("[fill_series_synopsis] debug targetWorkKeys(sample)=", workKeys.slice(0, 10));
    console.log("[fill_series_synopsis] debug targetIds(sample)=", targetIds.slice(0, 10));
    console.log("[fill_series_synopsis] debug missingWorkKeys(sample)=", missingWorkKeys.slice(0, 10));
    console.log("[fill_series_synopsis] debug masterIdSet(sample)=", Object.keys(items).slice(0, 10));
  }

  if (targetIds.length === 0) {
    console.log("[fill_series_synopsis] ERROR: TARGET_ONLY=1 but no target AniList IDs (list_items/anilist_by_work mismatch)");
    process.exit(1);
  }
}

const allIds = Object.keys(items);
const idsToProcess = TARGET_ONLY ? targetIds : allIds;

let seen = 0;
let had = 0;
let triedRakuten = 0;
let triedWiki = 0;
let wikiUsed = 0;
let updated = 0;
let filled = 0;

const needsOverride = []; // ← ここに「埋まらなかったID」を貯める

const wikiBudget = TARGET_ONLY ? Math.max(0, WIKI_MAX) : Infinity;

for (const id of idsToProcess) {
  const sid = String(id).trim();
  const s = items[sid];
  if (!s || typeof s !== "object") continue;

  seen++;

  const cur = getSynopsis(s);

  // overrides（キーは anilistId 文字列）
  const ov = overrides[sid];
  if (ov && String(ov).trim()) {
    const v = String(ov).trim();
    if (v !== cur) {
      setSynopsis(s, v);
      updated++;
    } else {
      had++;
    }
    continue;
  }

  if (cur) {
    had++;
    continue;
  }

  let synopsis = null;

  // 1) Rakuten
  const isbn = pickVol1Isbn(s);
  if (APP_ID && isbn) {
    triedRakuten++;
    synopsis = await rakutenCaptionByIsbn(isbn);
    await sleep(180);
  }

  // 2) Wikipedia（予算あり）
  if (!synopsis && triedWiki < wikiBudget) {
    triedWiki++;
    const t = String(pickTitleForWiki(s) || "").trim();
    if (t) {
      const page1 = await wikiSearchTitle(t + " 漫画");
      await sleep(200);
      synopsis = await wikiExtract(page1);
      await sleep(200);

      if (!synopsis) {
        const page2 = await wikiSearchTitle(t);
        await sleep(200);
        synopsis = await wikiExtract(page2);
        await sleep(200);
      }
    }
    if (synopsis) wikiUsed++;
  }

  if (synopsis) {
    setSynopsis(s, synopsis);
    filled++;
  } else {
    needsOverride.push({
      anilistId: sid,
      title: pickTitleForWiki(s) || s?.seriesKey || null,
      seriesKey: s?.seriesKey || null,
      vol1Isbn13: pickVol1Isbn(s) || null,
    });
  }
}

await fs.writeFile(SERIES_PATH, JSON.stringify(root, null, 2));

console.log(
  `[fill_series_synopsis] seen=${seen} targetOnly=${TARGET_ONLY} had=${had} triedRakuten=${triedRakuten} triedWiki=${triedWiki} wikiUsed=${wikiUsed} updated=${updated} filled=${filled} needsOverride=${needsOverride.length}`
);

// 重要：needsOverride の「特定情報」をログに出す（ここがあなたの疑問点の解消）
if (needsOverride.length) {
  console.log("[fill_series_synopsis] needsOverride(items)=", JSON.stringify(needsOverride, null, 2));
}
