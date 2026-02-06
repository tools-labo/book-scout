// scripts/manga/fill_series_synopsis.mjs （全差し替え・TARGET_ONLY修正版）
//
// 目的: series_master の各シリーズに synopsis(=vol1.description) を埋める
// 優先: overrides > 既存vol1.description > Rakuten(itemCaption by ISBN) > Wikipedia(概要)
//
// env:
// - RAKUTEN_APP_ID: 楽天API (任意)
// - TARGET_ONLY="1": ターゲット(=list_items に出てくる作品)だけ処理
// - WIKI_MAX="30": Wikipedia を使う最大件数（暴走防止）
// - DEBUG_KEYS="1": target/series のキーサンプルを出す
//
// ログ: kind / entries / target / had / triedRakuten / triedWiki / wikiUsed / updated / filled / needsOverride
import fs from "node:fs/promises";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const APP_ID = process.env.RAKUTEN_APP_ID || "";
const TARGET_ONLY = process.env.TARGET_ONLY === "1";
const WIKI_MAX = Number(process.env.WIKI_MAX || "30");
const DEBUG_KEYS = process.env.DEBUG_KEYS === "1";

const UA = { "User-Agent": "book-scout-bot" };
const digits = (s) => String(s || "").replace(/\D/g, "");

// --- normalize ---
const norm = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/[【】\[\]（）()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

// --- fetch helper ---
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

// --- Wikipedia (ja) ---
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

// --- series_master structure ---
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
    return listLike.map((s, idx) => ({ key: s?.key || s?.workKey || s?.title || String(idx), s }));
  }
  if (listLike && typeof listLike === "object") {
    // dict(id -> series)
    return Object.entries(listLike)
      .filter(([k, v]) => v && typeof v === "object")
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

function pickVol1Isbn(s) {
  const v = s?.vol1 || s?.volume1 || s?.firstVolume || null;
  return v?.isbn13 || v?.isbn || s?.vol1Isbn13 || null;
}

// ★ ここが重要：series側の「照合用タイトルキー」を複数作る
function seriesTitleKeys(key, s) {
  const arr = [];
  // 1) key自体（idだったとしても一応入れる）
  if (key) arr.push(String(key));

  // 2) よくありそうなフィールド
  if (s?.title) arr.push(s.title);
  if (s?.name) arr.push(s.name);
  if (s?.workKey) arr.push(s.workKey);

  // 3) AniList由来
  const a = s?.anilist || {};
  const t = a?.title || {};
  if (t?.native) arr.push(t.native);
  if (t?.romaji) arr.push(t.romaji);
  if (t?.english) arr.push(t.english);

  // 4) その他候補（ありがち）
  if (s?.titles && Array.isArray(s.titles)) arr.push(...s.titles);

  // normalizeしてユニーク化
  const out = [];
  const seen = new Set();
  for (const x of arr) {
    const n = norm(x);
    if (!n) continue;
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

// --- load files ---
const SERIES_PATH = "data/manga/series_master.json";
const OVERRIDE_PATH = "data/manga/overrides_synopsis.json";
const LIST_PATH = "data/manga/list_items.json";

const root = JSON.parse(await fs.readFile(SERIES_PATH, "utf8"));
const { list, kind } = unwrapSeriesMaster(root);
const seriesEntries = iterSeries(list);

let overrides = {};
try {
  const overridesRaw = JSON.parse(await fs.readFile(OVERRIDE_PATH, "utf8"));
  overrides = overridesRaw && typeof overridesRaw === "object" ? overridesRaw : {};
} catch {}

// --- build target title keys from list_items ---
let listRaw = {};
try {
  listRaw = JSON.parse(await fs.readFile(LIST_PATH, "utf8"));
} catch {}
const listItems = Array.isArray(listRaw) ? listRaw : (listRaw.items || []);
const targetTitleKeySet = new Set();
const targetKeySet = new Set(); // 作品キーっぽいのも一応持つ

for (const it of listItems) {
  const latest = it?.latest || {};
  const title = latest.title || it?.title || it?.seriesTitle || it?.name || "";
  const wk = it?.seriesKey || it?.workKey || "";
  if (title) targetTitleKeySet.add(norm(title));
  if (wk) targetKeySet.add(norm(wk));
}

if (DEBUG_KEYS) {
  console.log(`[fill_series_synopsis] debug targetKeys(sample)=`, Array.from(targetKeySet).slice(0, 5));
  console.log(`[fill_series_synopsis] debug targetTitleKeys(sample)=`, Array.from(targetTitleKeySet).slice(0, 5));
  console.log(`[fill_series_synopsis] debug seriesKeys(sample)=`, seriesEntries.slice(0, 5).map((x) => x.key));
}

console.log(
  `[fill_series_synopsis] start kind=${kind} entries=${seriesEntries.length} targetOnly=${TARGET_ONLY} wikiMax=${WIKI_MAX} targetKeys=${targetKeySet.size} targetTitleKeys=${targetTitleKeySet.size}`
);

// --- main loop ---
let seen = 0;
let target = 0;
let had = 0;
let triedRakuten = 0;
let triedWiki = 0;
let wikiUsed = 0;
let updated = 0;
let filled = 0;
let needsOverride = 0;

let wikiBudget = WIKI_MAX;

for (const { key, s } of seriesEntries) {
  if (!s || typeof s !== "object") continue;
  seen++;

  // TARGET_ONLY の判定：キー一致ではなく「タイトル一致」を優先
  if (TARGET_ONLY) {
    const keys = seriesTitleKeys(key, s);
    const hitTitle = keys.some((k) => targetTitleKeySet.has(k));
    const hitWorkKey = keys.some((k) => targetKeySet.has(k));
    if (!hitTitle && !hitWorkKey) continue;
  }

  target++;

  const cur = getSynopsis(s);

  // overrides優先
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

  // 2) Wikipedia（予算制）
  if (!synopsis && wikiBudget > 0) {
    triedWiki++;
    wikiBudget--;

    // 検索クエリは「タイトル候補の先頭（もっとも妥当そうなやつ）」を使う
    const titleKeys = seriesTitleKeys(key, s);
    const q = titleKeys[0] || "";
    if (q) {
      // "漫画" 付き優先
      const page1 = await wikiSearchTitle(q + " 漫画");
      await sleep(200);
      synopsis = await wikiExtract(page1);
      await sleep(200);

      if (!synopsis) {
        const page2 = await wikiSearchTitle(q);
        await sleep(200);
        synopsis = await wikiExtract(page2);
        await sleep(200);
      }
      if (synopsis) wikiUsed++;
    }
  }

  if (synopsis) {
    setSynopsis(s, synopsis);
    filled++;
  } else {
    needsOverride++;
  }
}

// write back
await fs.writeFile(SERIES_PATH, JSON.stringify(root, null, 2));

console.log(
  `[fill_series_synopsis] done kind=${kind} seen=${seen} target=${target} had=${had} triedRakuten=${triedRakuten} triedWiki=${triedWiki} wikiUsed=${wikiUsed} updated=${updated} filled=${filled} needsOverride=${needsOverride}`
);
