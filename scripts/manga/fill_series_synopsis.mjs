// scripts/manga/fill_series_synopsis.mjs （全差し替え・構造ゆれ対応・進捗ログ・対象限定）
//
// 目的: series_master の各シリーズに synopsis(=vol1.description) を埋める
// 優先: overrides > 既存vol1.description > Rakuten(itemCaption by ISBN) > Wikipedia(概要)
//
// 重要: デフォは「現在サイトで使っているシリーズだけ」を対象にする（works.jsonのkey一致）
// 進捗: 50件ごとにログ
//
// ENV:
//   RAKUTEN_APP_ID            : 楽天API
//   SYNOPSIS_TARGET_ONLY=1    : 1なら対象限定（デフォ1）
//   SYNOPSIS_WIKI_MAX=30      : Wikiを叩く最大件数（デフォ30）
//   SYNOPSIS_LOG_EVERY=50     : 進捗ログ間隔（デフォ50）
import fs from "node:fs/promises";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const APP_ID = process.env.RAKUTEN_APP_ID || "";
const UA = { "User-Agent": "book-scout-bot" };

const TARGET_ONLY = (process.env.SYNOPSIS_TARGET_ONLY ?? "1") === "1";
const WIKI_MAX = Number(process.env.SYNOPSIS_WIKI_MAX ?? "30");
const LOG_EVERY = Number(process.env.SYNOPSIS_LOG_EVERY ?? "50");

const digits = (s) => String(s || "").replace(/\D/g, "");
const norm = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/[【】\[\]（）()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

// ---- fetchJson with timeout ----
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
    return listLike.map((s, idx) => ({ key: s?.key || s?.workKey || s?.title || String(idx), s }));
  }
  if (listLike && typeof listLike === "object") {
    return Object.entries(listLike)
      .filter(([, v]) => v && typeof v === "object")
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

function seriesCandidates(key, s) {
  const arr = [
    key,
    s?.title,
    s?.name,
    s?.workKey,
    s?.key,
    s?.anilist?.title?.native,
    s?.anilist?.title?.romaji,
  ]
    .map((x) => norm(x))
    .filter(Boolean);
  // unique
  return Array.from(new Set(arr));
}

// ---- target set (works.json) ----
async function loadTargetKeys() {
  if (!TARGET_ONLY) return null;
  try {
    const works = JSON.parse(await fs.readFile("data/manga/works.json", "utf8"));
    // works.json は辞書っぽい前提：{ "one piece": {...}, ... }
    if (works && typeof works === "object" && !Array.isArray(works)) {
      return new Set(Object.keys(works).map(norm).filter(Boolean));
    }
  } catch {}
  return null;
}

// ---- main ----
const SERIES_PATH = "data/manga/series_master.json";
const OVERRIDE_PATH = "data/manga/overrides_synopsis.json";

const root = JSON.parse(await fs.readFile(SERIES_PATH, "utf8"));
const { list, kind } = unwrapSeriesMaster(root);

let overrides = {};
try {
  const overridesRaw = JSON.parse(await fs.readFile(OVERRIDE_PATH, "utf8"));
  overrides = overridesRaw && typeof overridesRaw === "object" ? overridesRaw : {};
} catch {
  overrides = {};
}

const targetKeys = await loadTargetKeys();

const seriesEntries = iterSeries(list);

let totalSeen = 0;
let totalTarget = 0;

let had = 0;
let triedRakuten = 0;
let triedWiki = 0;

let updated = 0;
let filled = 0;
let needsOverride = 0;

let wikiBudgetLeft = WIKI_MAX;

console.log(
  `[fill_series_synopsis] start kind=${kind} entries=${seriesEntries.length} targetOnly=${TARGET_ONLY} wikiMax=${WIKI_MAX}`
);

for (const { key, s } of seriesEntries) {
  if (!s || typeof s !== "object") continue;
  totalSeen++;

  // 対象限定（works.json の key に一致するシリーズだけ処理）
  if (targetKeys) {
    const cands = seriesCandidates(key, s);
    const hit = cands.some((c) => targetKeys.has(c));
    if (!hit) continue;
  }
  totalTarget++;

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
    if (totalTarget % LOG_EVERY === 0) {
      console.log(
        `[fill_series_synopsis] progress target=${totalTarget} had=${had} filled=${filled} updated=${updated} needsOverride=${needsOverride} triedRakuten=${triedRakuten} triedWiki=${triedWiki} wikiLeft=${wikiBudgetLeft}`
      );
    }
    continue;
  }

  if (cur) {
    had++;
    if (totalTarget % LOG_EVERY === 0) {
      console.log(
        `[fill_series_synopsis] progress target=${totalTarget} had=${had} filled=${filled} updated=${updated} needsOverride=${needsOverride} triedRakuten=${triedRakuten} triedWiki=${triedWiki} wikiLeft=${wikiBudgetLeft}`
      );
    }
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

  // 2) Wikipedia（予算内だけ）
  if (!synopsis && wikiBudgetLeft > 0) {
    triedWiki++;
    wikiBudgetLeft--;

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
  }

  if (synopsis) {
    setSynopsis(s, synopsis);
    filled++;
  } else {
    needsOverride++;
  }

  if (totalTarget % LOG_EVERY === 0) {
    console.log(
      `[fill_series_synopsis] progress target=${totalTarget} had=${had} filled=${filled} updated=${updated} needsOverride=${needsOverride} triedRakuten=${triedRakuten} triedWiki=${triedWiki} wikiLeft=${wikiBudgetLeft}`
    );
  }
}

// 書き戻し（参照更新なのでrootに反映済み）
await fs.writeFile(SERIES_PATH, JSON.stringify(root, null, 2));

console.log(
  `[fill_series_synopsis] done kind=${kind} seen=${totalSeen} target=${totalTarget} had=${had} triedRakuten=${triedRakuten} triedWiki=${triedWiki} updated=${updated} filled=${filled} needsOverride=${needsOverride}`
);
