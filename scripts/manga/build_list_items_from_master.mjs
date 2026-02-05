// scripts/manga/build_list_items_from_master.mjs
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

function normKey(s) {
  return String(s || "").trim();
}

const main = async () => {
  const items = await loadJson(ITEMS, []);
  const seriesMaster = await loadJson(SERIES, {});

  // seriesKey -> latest item
  const latestBySeries = new Map();

  for (const it of items) {
    if (!it) continue;
    if (it.seriesType && it.seriesType !== "main") continue; // 一旦 main のみ
    const seriesKey = normKey(it.workKey || it.seriesKey || it.title);
    if (!seriesKey) continue;
    const prev = latestBySeries.get(seriesKey);
    latestBySeries.set(seriesKey, pickLatest(prev, it));
  }

  // series_master を anilistIdで持ってるので、逆引き index 作る
  const masterBySeriesKey = new Map();
  for (const s of Object.values(seriesMaster)) {
    const k = normKey(s?.seriesKey || s?.titleRomaji || s?.titleNative);
    if (!k) continue;
    if (!masterBySeriesKey.has(k)) masterBySeriesKey.set(k, s);
  }

  const list = [];

  for (const [seriesKey, latest] of latestBySeries.entries()) {
    const sm = masterBySeriesKey.get(seriesKey) || null;

    const vol1 = sm?.vol1 || {};
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
        description: vol1?.description ?? "（あらすじ準備中）",
        image: vol1?.image ?? null,
        amazonDp: vol1?.amazonDp ?? null,
        needsOverride: vol1?.needsOverride ?? false,
      },

      tags,
    });
  }

  // 表示順：発売日 desc（文字列比較でOK）
  list.sort((a, b) => String(b?.latest?.publishedAt || "").localeCompare(String(a?.latest?.publishedAt || "")));

  await saveJson(OUT, list);
  console.log(`[build_list_items_from_master] series=${list.length}`);
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
