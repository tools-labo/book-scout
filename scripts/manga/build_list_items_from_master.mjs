// scripts/manga/build_list_items_from_master.mjs（全差し替え）
// 方針:
// - list_items.json は「表示して良い作品だけ」を出す
// - “1巻が確定”できない作品は list に入れない（見た目統一）
//   確定条件: series_master.items[anilistId].vol1.isbn13 && vol1.image
//
// 入力:
// - data/manga/items_master.json（巻単位の候補）
// - data/manga/series_master.json（作品単位マスタ: { meta, items }）
// 出力:
// - data/manga/list_items.json（表示用）

import fs from "node:fs/promises";

const ITEMS = "data/manga/items_master.json";
const SERIES = "data/manga/series_master.json";
const OUT = "data/manga/list_items.json";

async function loadJson(path, fallback) {
  try {
    return JSON.parse(await fs.readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

async function saveJson(path, obj) {
  await fs.mkdir(path.split("/").slice(0, -1).join("/"), { recursive: true });
  await fs.writeFile(path, JSON.stringify(obj, null, 2));
}

function dpFrom(asinOrUrl) {
  if (!asinOrUrl) return null;
  const s = String(asinOrUrl).trim();
  const m = s.match(
    /^https:\/\/www\.amazon\.co\.jp\/dp\/([A-Z0-9]{10}|[0-9]{9}X|[0-9]{10})(?:[/?].*)?$/i
  );
  if (m) return `https://www.amazon.co.jp/dp/${m[1]}`;
  const asin = s.toUpperCase().replace(/[^0-9A-Z]/g, "");
  if (/^[A-Z0-9]{10}$/.test(asin)) return `https://www.amazon.co.jp/dp/${asin}`;
  return null;
}

function toNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function normKey(s) {
  return String(s || "").trim();
}

function isIsbn13(s) {
  return /^\d{13}$/.test(String(s || "").trim());
}

// 最新刊判定：volumeHint優先、なければ publishedAt 文字列比較（YYYY年MM月DD日想定）
function pickLatest(prev, cur) {
  if (!prev) return cur;

  const pv = toNum(prev.volumeHint);
  const cv = toNum(cur.volumeHint);
  if (pv != null && cv != null) return cv > pv ? cur : prev;

  const pa = String(prev.publishedAt || "");
  const ca = String(cur.publishedAt || "");
  return ca > pa ? cur : prev;
}

const main = async () => {
  const items = await loadJson(ITEMS, []);
  const seriesRoot = await loadJson(SERIES, null);

  const seriesItems =
    seriesRoot &&
    typeof seriesRoot === "object" &&
    seriesRoot.items &&
    typeof seriesRoot.items === "object" &&
    !Array.isArray(seriesRoot.items)
      ? seriesRoot.items
      : {};

  // --- 1) items_master から “シリーズごとの最新巻” を作る ---
  // seriesKey = workKey を最優先（ここがサイトのキー）
  const latestBySeries = new Map();

  for (const it of items) {
    if (!it) continue;
    if (it.seriesType && it.seriesType !== "main") continue;

    const seriesKey = normKey(it.workKey || it.seriesKey || it.title);
    if (!seriesKey) continue;

    const prev = latestBySeries.get(seriesKey);
    latestBySeries.set(seriesKey, pickLatest(prev, it));
  }

  // --- 2) series_master を seriesKey で逆引きできる index にする ---
  // series_master は anilistId をキーに持つ。中の seriesKey が workKey と一致する想定。
  const masterBySeriesKey = new Map();
  for (const s of Object.values(seriesItems)) {
    const k = normKey(s?.seriesKey);
    if (!k) continue;
    if (!masterBySeriesKey.has(k)) masterBySeriesKey.set(k, s);
  }

  // --- 3) list_items を組み立て（1巻確定できないものは除外） ---
  const list = [];

  let total = 0;
  let kept = 0;
  let skippedNoMaster = 0;
  let skippedVol1NotConfirmed = 0;

  for (const [seriesKey, latest] of latestBySeries.entries()) {
    total++;

    const sm = masterBySeriesKey.get(seriesKey) || null;
    if (!sm) {
      skippedNoMaster++;
      continue;
    }

    const vol1 = sm?.vol1 || {};
    const vol1Isbn13 = normKey(vol1?.isbn13);
    const vol1Image = normKey(vol1?.image);

    // “1巻確定” 条件（ここがポリシー）
    const vol1Confirmed = isIsbn13(vol1Isbn13) && !!vol1Image;
    if (!vol1Confirmed) {
      skippedVol1NotConfirmed++;
      continue;
    }

    const tags = {
      genre: Array.isArray(sm?.genre) ? sm.genre : [],
      demo: Array.isArray(sm?.demo) ? sm.demo : [],
      publisher: sm?.publisher ? [sm.publisher] : [],
    };

    list.push({
      seriesKey,
      anilistId: sm?.anilistId ?? null,
      title: sm?.titleNative || sm?.titleRomaji || latest?.title || seriesKey,
      author: latest?.author || null,
      publisher: latest?.publisher || sm?.publisher || null,

      latest: {
        volume: toNum(latest?.volumeHint),
        isbn13: latest?.isbn13 || null,
        publishedAt: latest?.publishedAt || null,
        asin: latest?.asin || null,
        amazonDp: dpFrom(latest?.asin || latest?.amazonUrl) || null,
      },

      vol1: {
        // vol1Confirmed のものだけ出すので、準備中文言は使わない
        description: vol1?.description ?? null,
        isbn13: vol1Isbn13 || null,
        image: vol1Image || null,
        amazonDp: vol1?.amazonDp ?? null,
        needsOverride: vol1?.needsOverride ?? false,
      },

      tags,
    });

    kept++;
  }

  // 表示順：発売日 desc（文字列比較でOK）
  list.sort((a, b) =>
    String(b?.latest?.publishedAt || "").localeCompare(String(a?.latest?.publishedAt || ""))
  );

  await saveJson(OUT, list);

  console.log(
    `[build_list_items_from_master] totalSeries=${total} kept=${kept} skippedNoMaster=${skippedNoMaster} skippedVol1NotConfirmed=${skippedVol1NotConfirmed}`
  );
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
