// scripts/manga/fill_series_synopsis.mjs（全差し替え・TARGET_ONLY=「AniList ID」で照合・overrides構造ゆれ対応）
//
// 目的: series_master の各シリーズに synopsis(=vol1.description) を埋める
// 優先: overrides > 既存vol1.description > Rakuten(itemCaption by ISBN) > Wikipedia(概要)
//
// 環境変数:
// - RAKUTEN_APP_ID: 楽天API
// - TARGET_ONLY=1 : list_items.json の作品だけ処理（AniList IDで照合）
// - WIKI_MAX=30   : Wikipedia取得は最大N件まで（暴走防止）
// - DEBUG_KEYS=1  : キー対応のデバッグ出力
//
// NOTE: workflow 側の検知用マーカー → seriesTitleKeys（文字列として残す）
import fs from "node:fs/promises";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const APP_ID = process.env.RAKUTEN_APP_ID || "";
const TARGET_ONLY = process.env.TARGET_ONLY === "1";
const WIKI_MAX = Number(process.env.WIKI_MAX || "30");
const DEBUG_KEYS = process.env.DEBUG_KEYS === "1";

const UA = { "User-Agent": "book-scout-bot" };
const digits = (s) => String(s || "").replace(/\D/g, "");

const norm = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/[【】\[\]（）()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const SERIES_PATH = "data/manga/series_master.json";
const LIST_ITEMS_PATH = "data/manga/list_items.json";
const ANILIST_BY_WORK_PATH = "data/manga/anilist_by_work.json";

const OVERRIDE_PATH = "data/manga/overrides_synopsis.json";
const TODO_PATH = "data/manga/overrides_synopsis.todo.json";

const isDigits = (s) => /^\d+$/.test(String(s || "").trim());

async function readJson(path, fallback) {
  try {
    return JSON.parse(await fs.readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}
async function writeJson(path, obj) {
  await fs.writeFile(path, JSON.stringify(obj, null, 2));
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

// --- Rakuten itemCaption by ISBN ---
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

// --- Wikipedia (Japanese) ---
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

// --- series_master 構造ゆれ吸収 ---
function unwrapSeriesMaster(root) {
  if (Array.isArray(root)) return { wrapper: null, list: root, kind: "array" };
  if (root && typeof root === "object") {
    if (Array.isArray(root.items)) return { wrapper: root, list: root.items, kind: "wrapper.items.array" };
    if (Array.isArray(root.series)) return { wrapper: root, list: root.series, kind: "wrapper.series.array" };
    if (root.items && typeof root.items === "object" && !Array.isArray(root.items)) {
      return { wrapper: root, list: root.items, kind: "wrapper.items.object" };
    }
    return { wrapper: root, list: root, kind: "object" };
  }
  return { wrapper: null, list: [], kind: "unknown" };
}

function iterSeries(listLike) {
  if (Array.isArray(listLike)) {
    return listLike.map((s, idx) => ({ key: String(s?.anilistId || s?.key || s?.workKey || idx), s }));
  }
  if (listLike && typeof listLike === "object") {
    return Object.entries(listLike)
      .filter(([_, v]) => v && typeof v === "object")
      .map(([key, s]) => ({ key: String(key), s }));
  }
  return [];
}

function getSynopsis(s) {
  const cur = s?.vol1?.description;
  return cur ? String(cur).trim() : "";
}
function setSynopsis(s, synopsis) {
  if (!s.vol1) s.vol1 = {};
  s.vol1.description = synopsis;
}

// --- overrides: string / {synopsis} 両対応 ---
function readOverrideSynopsis(overrides, key) {
  const v = overrides?.[key];
  if (!v) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "object") return String(v.synopsis || "").trim();
  return "";
}

function pickTitle(s) {
  return (
    s?.titleNative ||
    s?.titleRomaji ||
    s?.title ||
    s?.name ||
    s?.seriesKey ||
    s?.anilist?.title?.native ||
    s?.anilist?.title?.romaji ||
    ""
  );
}

function pickVol1Isbn(s) {
  const v = s?.vol1 || s?.volume1 || s?.firstVolume || null;
  return v?.isbn13 || v?.isbn || s?.vol1Isbn13 || null;
}

function pickWorkKeyFromListItem(it) {
  const cands = [it?.workKey, it?.seriesKey, it?.work?.key, it?.work?.workKey, it?.series?.key];
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

// --- TARGET_ONLY 用の targetIds を作る（list_items + anilist_by_work から） ---
async function buildTargetIds() {
  const listRaw = await readJson(LIST_ITEMS_PATH, []);
  const list = Array.isArray(listRaw) ? listRaw : (listRaw?.items || []);
  const anilistByWork = await readJson(ANILIST_BY_WORK_PATH, {});
  const wk2id = buildWorkKeyToAnilistId(anilistByWork);

  const targetWorkKeys = new Set();
  for (const it of list) {
    const wk = pickWorkKeyFromListItem(it);
    if (wk) targetWorkKeys.add(String(wk).trim());
  }

  const targetIds = [];
  const missingWorkKeys = [];
  for (const wk of targetWorkKeys) {
    const id = wk2id.get(wk);
    if (id) targetIds.push(id);
    else missingWorkKeys.push(wk);
  }

  if (DEBUG_KEYS) {
    console.log("[fill_series_synopsis] debug targetWorkKeys(sample)=", Array.from(targetWorkKeys).slice(0, 10));
    console.log("[fill_series_synopsis] debug targetIds(sample)=", targetIds.slice(0, 10));
    console.log("[fill_series_synopsis] debug missingWorkKeys(sample)=", missingWorkKeys.slice(0, 10));
  }

  if (TARGET_ONLY && targetIds.length === 0) {
    console.log("[fill_series_synopsis] ERROR: TARGET_ONLY=1 but targetIds is empty (anilist_by_work resolution failed)");
    process.exit(1);
  }

  return { listItemsCount: list.length, targetWorkKeysCount: targetWorkKeys.size, targetIds: Array.from(new Set(targetIds)) };
}

const root = await readJson(SERIES_PATH, {});
const { list, kind } = unwrapSeriesMaster(root);
const seriesEntries = iterSeries(list);

const overrides = await readJson(OVERRIDE_PATH, {});
const todoExisting = await readJson(TODO_PATH, {});

const { listItemsCount, targetIds } = await buildTargetIds();
const targetIdSet = new Set(targetIds.map((x) => String(x)));

if (DEBUG_KEYS) {
  const seriesTitleKeys = new Set(); // ← marker: seriesTitleKeys（grep対策）
  for (const { _, s } of seriesEntries.map((x) => ({ _: x.key, s: x.s }))) {
    const t = pickTitle(s);
    if (t) seriesTitleKeys.add(norm(t));
  }
  console.log("[fill_series_synopsis] debug seriesTitleKeys(sample)=", Array.from(seriesTitleKeys).slice(0, 10)); // marker
}

let seen = 0;
let had = 0;
let triedRakuten = 0;
let triedWiki = 0;
let wikiUsed = 0;
let updated = 0;
let filled = 0;

const needsOverrideItems = [];

for (const { key, s } of seriesEntries) {
  if (!s || typeof s !== "object") continue;

  const id = String(s?.anilistId ?? key ?? "").trim();
  if (TARGET_ONLY && !targetIdSet.has(id)) continue;

  seen++;

  const cur = getSynopsis(s);

  // overrides があれば優先上書き（既にcurがあっても）
  const ov = readOverrideSynopsis(overrides, id);
  if (ov) {
    if (ov !== cur) {
      setSynopsis(s, ov);
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

  // 1) Rakuten（ISBNがある時だけ）
  const isbn = pickVol1Isbn(s);
  if (APP_ID && isbn) {
    triedRakuten++;
    synopsis = await rakutenCaptionByIsbn(isbn);
    await sleep(180);
  }

  // 2) Wikipedia（概要）
  // TARGET_ONLY のときは WIKI_MAX 件まで
  if (!synopsis) {
    if (!TARGET_ONLY || triedWiki < WIKI_MAX) {
      triedWiki++;
      const t = String(pickTitle(s) || "").trim();
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

        if (synopsis) wikiUsed++;
      }
    }
  }

  if (synopsis) {
    setSynopsis(s, synopsis);
    filled++;
  } else {
    needsOverrideItems.push({
      anilistId: id,
      title: pickTitle(s) || null,
      seriesKey: s?.seriesKey || null,
      vol1Isbn13: isbn || null,
    });
  }
}

// 書き戻し
await writeJson(SERIES_PATH, root);

// todo 生成（既存があればマージ、synopsisは空のまま）
if (needsOverrideItems.length) {
  const nextTodo = (todoExisting && typeof todoExisting === "object") ? { ...todoExisting } : {};
  for (const it of needsOverrideItems) {
    const k = String(it.anilistId);
    if (!nextTodo[k]) {
      nextTodo[k] = { title: it.title, seriesKey: it.seriesKey, vol1Isbn13: it.vol1Isbn13, synopsis: "" };
    } else {
      // 既存があるなら synopsis は保持しつつ、周辺情報だけ補完
      if (!nextTodo[k].title) nextTodo[k].title = it.title;
      if (!nextTodo[k].seriesKey) nextTodo[k].seriesKey = it.seriesKey;
      if (!nextTodo[k].vol1Isbn13) nextTodo[k].vol1Isbn13 = it.vol1Isbn13;
      if (typeof nextTodo[k].synopsis !== "string") nextTodo[k].synopsis = "";
    }
  }
  await writeJson(TODO_PATH, nextTodo);
  console.log("[fill_series_synopsis] needsOverride(items)=", JSON.stringify(needsOverrideItems, null, 2));
  console.log(`[fill_series_synopsis] wrote ${TODO_PATH}`);
}

const needsOverride = needsOverrideItems.length;

console.log(
  `[fill_series_synopsis] seen=${seen} targetOnly=${TARGET_ONLY} had=${had} triedRakuten=${triedRakuten} triedWiki=${triedWiki} wikiUsed=${wikiUsed} updated=${updated} filled=${filled} needsOverride=${needsOverride} listItems=${listItemsCount}`
);
