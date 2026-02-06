// scripts/manga/fill_series_synopsis.mjs （全差し替え・target=0原因可視化＋構造ゆれ対応）
//
// 目的: series_master の各シリーズに synopsis(=vol1.description) を埋める
// 優先: overrides > 既存vol1.description > Rakuten(itemCaption by ISBN) > Wikipedia(概要)
//
// 重要:
// - series_master は { meta, items: { [key]: seriesObj } } の辞書型が主
// - 最新29件(list_items)とseries_master.itemsのキーがズレると target=0 になる
//   → ここをログで可視化し、titleベースの照合も行う
//
// env:
// - RAKUTEN_APP_ID: 楽天API
// - TARGET_ONLY: "1" なら最新29件に関連するシリーズだけ処理（デフォルト1）
// - WIKI_MAX: Wikipedia フェッチ上限（デフォルト30）
// - DEBUG_KEYS: "1" ならキー照合ログを濃く出す（普段0でOK）
import fs from "node:fs/promises";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const APP_ID = process.env.RAKUTEN_APP_ID || "";
const UA = { "User-Agent": "book-scout-bot" };

const TARGET_ONLY = (process.env.TARGET_ONLY ?? "1") !== "0";
const WIKI_MAX = Number(process.env.WIKI_MAX ?? "30");
const DEBUG_KEYS = process.env.DEBUG_KEYS === "1";

const digits = (s) => String(s || "").replace(/\D/g, "");

const norm = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/[【】\[\]（）()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

// --- fetch helpers ---
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
  if (Array.isArray(root)) return { root, itemsObj: null, listLike: root, kind: "array" };
  if (root && typeof root === "object") {
    if (Array.isArray(root.items)) return { root, itemsObj: null, listLike: root.items, kind: "wrapper.items.array" };
    if (root.items && typeof root.items === "object" && !Array.isArray(root.items)) {
      return { root, itemsObj: root.items, listLike: root.items, kind: "wrapper.items.object" };
    }
    if (Array.isArray(root.series)) return { root, itemsObj: null, listLike: root.series, kind: "wrapper.series.array" };
    return { root, itemsObj: root, listLike: root, kind: "object" };
  }
  return { root, itemsObj: null, listLike: [], kind: "unknown" };
}

function iterSeries(listLike) {
  if (Array.isArray(listLike)) {
    return listLike.map((s, idx) => ({ key: s?.key || s?.workKey || s?.title || String(idx), s }));
  }
  if (listLike && typeof listLike === "object") {
    return Object.entries(listLike)
      .filter(([k, v]) => v && typeof v === "object")
      .filter(([k]) => k !== "meta" && k !== "items" && k !== "series")
      .map(([key, s]) => ({ key, s }));
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

function pickTitleForQuery(key, s) {
  return (
    s?.title ||
    s?.name ||
    s?.workKey ||
    s?.key ||
    s?.anilist?.title?.native ||
    s?.anilist?.title?.romaji ||
    key
  );
}

function pickVol1Isbn(s) {
  const v = s?.vol1 || s?.volume1 || s?.firstVolume || null;
  return v?.isbn13 || v?.isbn || s?.vol1Isbn13 || null;
}

// --- target keys from list_items.json ---
async function loadTargetKeysFromListItems() {
  let raw;
  try {
    raw = JSON.parse(await fs.readFile("data/manga/list_items.json", "utf8"));
  } catch {
    return { keys: new Set(), titleKeys: new Set() };
  }
  const arr = Array.isArray(raw) ? raw : raw?.items || [];
  const keys = new Set();
  const titleKeys = new Set();

  for (const it of arr) {
    const k = it?.seriesKey || it?.workKey || it?.key || null;
    if (k) keys.add(norm(k));

    // タイトルでも当てにいく（seriesKeyが無い/ズレてる場合の救済）
    const t =
      it?.latest?.title ||
      it?.title ||
      it?.latest?.seriesTitle ||
      it?.seriesTitle ||
      null;
    if (t) titleKeys.add(norm(t));
  }
  return { keys, titleKeys };
}

// ---- main ----
const SERIES_PATH = "data/manga/series_master.json";
const OVERRIDE_PATH = "data/manga/overrides_synopsis.json";

const root = JSON.parse(await fs.readFile(SERIES_PATH, "utf8"));
const { listLike, kind } = unwrapSeriesMaster(root);

let overrides = {};
try {
  const overridesRaw = JSON.parse(await fs.readFile(OVERRIDE_PATH, "utf8"));
  overrides = overridesRaw && typeof overridesRaw === "object" ? overridesRaw : {};
} catch {
  overrides = {};
}

const seriesEntries = iterSeries(listLike);

const { keys: targetKeys, titleKeys: targetTitleKeys } = await loadTargetKeysFromListItems();

if (DEBUG_KEYS) {
  console.log(`[fill_series_synopsis] debug targetKeys(sample)=`, Array.from(targetKeys).slice(0, 5));
  console.log(`[fill_series_synopsis] debug targetTitleKeys(sample)=`, Array.from(targetTitleKeys).slice(0, 5));
  console.log(`[fill_series_synopsis] debug seriesKeys(sample)=`, seriesEntries.slice(0, 5).map(e => norm(e.key)));
}

console.log(
  `[fill_series_synopsis] start kind=${kind} entries=${seriesEntries.length} targetOnly=${TARGET_ONLY} wikiMax=${WIKI_MAX} targetKeys=${targetKeys.size} targetTitleKeys=${targetTitleKeys.size}`
);

let seen = 0;
let target = 0;
let had = 0;
let triedRakuten = 0;
let triedWiki = 0;
let updated = 0;
let filled = 0;
let needsOverride = 0;
let wikiUsed = 0;

for (const { key, s } of seriesEntries) {
  if (!s || typeof s !== "object") continue;
  seen++;

  const keyN = norm(key);

  // targetOnly: list_itemsのseriesKey/workKeyに一致 or title一致のどちらかで対象にする
  if (TARGET_ONLY) {
    const titleN = norm(pickTitleForQuery(key, s) || "");
    const ok = targetKeys.has(keyN) || (titleN && targetTitleKeys.has(titleN));
    if (!ok) continue;
  }
  target++;

  const cur = getSynopsis(s);

  // overrides があれば優先上書き（既にcurがあっても）
  const ov = overrides[key];
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

  // 2) Wikipedia（上限あり）
  if (!synopsis && wikiUsed < WIKI_MAX) {
    triedWiki++;
    const t = String(pickTitleForQuery(key, s) || "").trim();
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
    needsOverride++;
  }
}

// 書き戻し
await fs.writeFile(SERIES_PATH, JSON.stringify(root, null, 2));

console.log(
  `[fill_series_synopsis] done kind=${kind} seen=${seen} target=${target} had=${had} triedRakuten=${triedRakuten} triedWiki=${triedWiki} wikiUsed=${wikiUsed} updated=${updated} filled=${filled} needsOverride=${needsOverride}`
);
