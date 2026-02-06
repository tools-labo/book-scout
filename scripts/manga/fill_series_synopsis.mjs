// scripts/manga/fill_series_synopsis.mjs （全差し替え・TARGET_ONLY修正版）
//
// 目的: series_master の各シリーズに synopsis(=vol1.description) を埋める
// 優先: overrides > 既存vol1.description > Rakuten(itemCaption by ISBN) > Wikipedia(概要)
//
// 環境変数:
// - RAKUTEN_APP_ID: 楽天API
// - TARGET_ONLY=1 : list_items.json に載ってる「今の29件」だけ処理
// - WIKI_MAX=30   : Wikipedia取得は最大N件まで（TARGET_ONLY時の暴走防止）
// - DEBUG_KEYS=1  : キー対応のデバッグ出力
//
// ログ: kind / entries / targetOnly / target / had / triedRakuten / triedWiki / wikiUsed / filled / updated / needsOverride
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
    return listLike.map((s, idx) => ({ key: String(s?.key || s?.workKey || s?.title || idx), s }));
  }
  if (listLike && typeof listLike === "object") {
    return Object.entries(listLike)
      .filter(([k, v]) => v && typeof v === "object")
      .filter(([k]) => k !== "meta" && k !== "items" && k !== "series")
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

function pickTitleCandidates(key, s) {
  const out = [];
  out.push(s?.title, s?.name, s?.workKey, s?.key);
  out.push(s?.anilist?.title?.native, s?.anilist?.title?.romaji, s?.anilist?.title?.english);
  out.push(key);
  return out.filter(Boolean).map((x) => String(x).trim()).filter(Boolean);
}

function pickVol1Isbn(s) {
  const v = s?.vol1 || s?.volume1 || s?.firstVolume || null;
  return v?.isbn13 || v?.isbn || s?.vol1Isbn13 || null;
}

// --- TARGET_ONLY 用：list_items.json からターゲット集合を作る ---
async function buildTargetSets() {
  const p = "data/manga/list_items.json";
  let raw = null;
  try {
    raw = JSON.parse(await fs.readFile(p, "utf8"));
  } catch {
    return { seriesKeySet: new Set(), titleSet: new Set(), rawCount: 0 };
  }

  const list = Array.isArray(raw) ? raw : raw?.items || [];
  const seriesKeySet = new Set();
  const titleSet = new Set();

  for (const c of list) {
    const seriesKey = c?.seriesKey || c?.workKey || c?.key || null;
    const t =
      c?.seriesTitle ||
      c?.title ||
      c?.latest?.seriesTitle ||
      c?.latest?.title ||
      null;

    if (seriesKey) seriesKeySet.add(String(seriesKey).trim());
    if (t) titleSet.add(norm(t));
  }

  return { seriesKeySet, titleSet, rawCount: list.length };
}

// ---- main ----
const SERIES_PATH = "data/manga/series_master.json";
const OVERRIDE_PATH = "data/manga/overrides_synopsis.json";

const root = JSON.parse(await fs.readFile(SERIES_PATH, "utf8"));
const { list, kind } = unwrapSeriesMaster(root);

const overridesRaw = JSON.parse(await fs.readFile(OVERRIDE_PATH, "utf8"));
const overrides = overridesRaw && typeof overridesRaw === "object" ? overridesRaw : {};

const seriesEntries = iterSeries(list);

const { seriesKeySet, titleSet, rawCount } = await buildTargetSets();

if (DEBUG_KEYS) {
  console.log("[fill_series_synopsis] debug targetSeriesKeys(sample)=", Array.from(seriesKeySet).slice(0, 10));
  console.log("[fill_series_synopsis] debug targetTitleKeys(sample)=", Array.from(titleSet).slice(0, 10));
  console.log("[fill_series_synopsis] debug seriesKeys(sample)=", seriesEntries.slice(0, 10).map((x) => x.key));
}

console.log(
  `[fill_series_synopsis] start kind=${kind} entries=${seriesEntries.length} targetOnly=${TARGET_ONLY} wikiMax=${WIKI_MAX} targetSeriesKeys=${seriesKeySet.size} targetTitleKeys=${titleSet.size} listItems=${rawCount}`
);

let seen = 0;
let target = 0;
let had = 0;
let triedRakuten = 0;
let triedWiki = 0;
let wikiUsed = 0;
let updated = 0;
let filled = 0;
let needsOverride = 0;

let wikiBudget = TARGET_ONLY ? WIKI_MAX : Number.POSITIVE_INFINITY;

for (const { key, s } of seriesEntries) {
  if (!s || typeof s !== "object") continue;
  seen++;

  // --- TARGET_ONLY 判定（キー or タイトル候補が一致したら対象）---
  let isTarget = true;
  if (TARGET_ONLY) {
    const keyHit = seriesKeySet.has(String(key));
    const titleHits = pickTitleCandidates(key, s)
      .map((t) => norm(t))
      .some((t) => titleSet.has(t));
    isTarget = keyHit || titleHits;
  }

  if (!isTarget) continue;
  target++;

  const cur = getSynopsis(s);

  // overrides 優先上書き
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

  // 2) Wikipedia（概要） ※wikiBudgetが残ってる範囲だけ
  if (!synopsis && wikiBudget > 0) {
    triedWiki++;
    wikiBudget--;

    // 検索語は「一番それっぽいタイトル」
    const cand = pickTitleCandidates(key, s)[0] || key;

    const q1 = String(cand).trim() + " 漫画";
    const page1 = await wikiSearchTitle(q1);
    await sleep(200);
    synopsis = await wikiExtract(page1);
    await sleep(200);

    if (!synopsis) {
      const page2 = await wikiSearchTitle(String(cand).trim());
      await sleep(200);
      synopsis = await wikiExtract(page2);
      await sleep(200);
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

// 書き戻し（参照なのでrootに反映済み）
await fs.writeFile(SERIES_PATH, JSON.stringify(root, null, 2));

console.log(
  `[fill_series_synopsis] done kind=${kind} seen=${seen} target=${target} had=${had} triedRakuten=${triedRakuten} triedWiki=${triedWiki} wikiUsed=${wikiUsed} updated=${updated} filled=${filled} needsOverride=${needsOverride}`
);
