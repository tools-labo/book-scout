// scripts/manga/fill_series_synopsis.mjs （全差し替え）
//
// 目的: data/manga/series_master.json の各 series に synopsis を埋める
// 優先: overrides_synopsis.json > 既存 synopsis > Rakuten itemCaption > Wikipedia 概要
//
// 出力: series_master.json を更新
// ログ: updated / filled / needsOverride
import fs from "node:fs/promises";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const APP_ID = process.env.RAKUTEN_APP_ID || "";
const UA = { "User-Agent": "book-scout-bot" };

const digits = (s) => String(s || "").replace(/\D/g, "");
const norm = (s) =>
  (s || "")
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
    } catch (e) {
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
// 1) search title -> best page title
async function wikiSearchTitle(q) {
  const url =
    "https://ja.wikipedia.org/w/api.php" +
    `?action=query&list=search&srsearch=${encodeURIComponent(q)}` +
    "&srlimit=5&format=json&origin=*";
  const j = await fetchJson(url);
  const hit = j?.query?.search?.[0];
  return hit?.title || null;
}

// 2) get extract
async function wikiExtract(title) {
  if (!title) return null;
  const url =
    "https://ja.wikipedia.org/w/api.php" +
    `?action=query&prop=extracts&explaintext=1&exintro=1&titles=${encodeURIComponent(title)}` +
    "&format=json&origin=*";
  const j = await fetchJson(url);
  const pages = j?.query?.pages || {};
  const firstKey = Object.keys(pages)[0];
  const ex = pages?.[firstKey]?.extract;
  const text = (ex || "").trim();
  if (!text) return null;

  // 先頭の空行/短すぎるものを軽く除外
  const lines = text.split("\n").map((x) => x.trim()).filter(Boolean);
  const joined = lines.join("\n").trim();
  if (joined.length < 80) return null;

  // 長すぎる場合は丸め（サイト表示用・概要可）
  return joined.length > 900 ? joined.slice(0, 900).trim() + "…" : joined;
}

function pickSeriesTitle(series) {
  // series_master の中身がどうであれ、ありがちなキーを順番に探す
  return (
    series?.title ||
    series?.name ||
    series?.workKey ||
    series?.key ||
    series?.romanji ||
    series?.anilist?.title?.romaji ||
    series?.anilist?.title?.native ||
    null
  );
}

function pickVol1Isbn(series) {
  // ありがちな場所（無ければnull）
  const v = series?.vol1 || series?.volume1 || series?.firstVolume || null;
  return v?.isbn13 || v?.isbn || series?.vol1Isbn13 || null;
}

function setSynopsis(series, synopsis) {
  // 保存場所は vol1.description に寄せる（既存構造を壊さない）
  if (!series.vol1) series.vol1 = {};
  series.vol1.description = synopsis;
}

const SERIES_PATH = "data/manga/series_master.json";
const OVERRIDE_PATH = "data/manga/overrides_synopsis.json";

const seriesMaster = JSON.parse(await fs.readFile(SERIES_PATH, "utf8"));
const overridesRaw = JSON.parse(await fs.readFile(OVERRIDE_PATH, "utf8"));
const overrides = overridesRaw && typeof overridesRaw === "object" ? overridesRaw : {};

let updated = 0;
let filled = 0;
let needsOverride = 0;

for (const [key, s] of Object.entries(seriesMaster || {})) {
  const cur = s?.vol1?.description ? String(s.vol1.description).trim() : "";
  if (cur) {
    // すでにあるなら overrides があれば上書き、それ以外は維持
    const ov = overrides[key];
    if (ov && String(ov).trim() && String(ov).trim() !== cur) {
      setSynopsis(s, String(ov).trim());
      updated++;
    }
    continue;
  }

  // overrides 優先
  const ov = overrides[key];
  if (ov && String(ov).trim()) {
    setSynopsis(s, String(ov).trim());
    filled++;
    continue;
  }

  let synopsis = null;

  // 1) Rakuten by ISBN（あるなら強い）
  const isbn = pickVol1Isbn(s);
  if (isbn) {
    synopsis = await rakutenCaptionByIsbn(isbn);
    await sleep(180);
  }

  // 2) Wikipedia（概要）
  if (!synopsis) {
    const title = pickSeriesTitle(s) || key;
    const q = String(title || "").trim();
    if (q) {
      const pageTitle = await wikiSearchTitle(q + " 漫画");
      await sleep(200);
      synopsis = await wikiExtract(pageTitle);
      await sleep(200);

      // 「漫画」付けがダメなら素のタイトルでもう1回だけ
      if (!synopsis) {
        const pageTitle2 = await wikiSearchTitle(q);
        await sleep(200);
        synopsis = await wikiExtract(pageTitle2);
        await sleep(200);
      }
    }
  }

  if (synopsis) {
    setSynopsis(s, synopsis);
    filled++;
  } else {
    // 最終的にダメなら override 対象
    needsOverride++;
  }
}

await fs.writeFile(SERIES_PATH, JSON.stringify(seriesMaster, null, 2));
console.log(`[fill_series_synopsis] updated=${updated} filled=${filled} needsOverride=${needsOverride}`);
