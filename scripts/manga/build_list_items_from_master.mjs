// scripts/manga/build_list_items_from_master.mjs（全差し替え版：1巻確定のみ表示 + TODO出力）
//
// 方針
// - 一覧(list_items)は「1巻が確定した作品だけ」出す
// - 1巻確定 = vol1.image と vol1.amazonDp が両方ある
// - 1巻情報は基本 items_master（巻データ）から決める
// - series_master は tags/anilistId/title補強に使う（items_masterだけでも動くが、無い作品は原則除外）
//
// 入力:
// - data/manga/items_master.json（配列）: 各巻の情報
// - data/manga/series_master.json（{meta, items:{[anilistId]:seriesObj}}）
//
// 出力:
// - data/manga/list_items.json（配列）: 一覧用
// - data/manga/vol1_unconfirmed.todo.json（{seriesKey: {...}}）: 1巻確定できず一覧から落ちたもの
//
import fs from "node:fs/promises";

const ITEMS = "data/manga/items_master.json";
const SERIES = "data/manga/series_master.json";
const OUT = "data/manga/list_items.json";
const TODO = "data/manga/vol1_unconfirmed.todo.json";

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

function normKey(s) {
  return String(s || "").trim();
}

function toNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function dpFrom(asinOrUrl) {
  if (!asinOrUrl) return null;
  const s = String(asinOrUrl).trim();

  // already dp
  const m = s.match(
    /^https:\/\/www\.amazon\.co\.jp\/dp\/([A-Z0-9]{10}|[0-9]{9}X|[0-9]{10})(?:[/?].*)?$/i
  );
  if (m) return `https://www.amazon.co.jp/dp/${m[1]}`;

  // ASIN-ish
  const asin = s.toUpperCase().replace(/[^0-9A-Z]/g, "");
  if (/^[A-Z0-9]{10}$/.test(asin)) return `https://www.amazon.co.jp/dp/${asin}`;

  return null;
}

function parseDateJP(s) {
  // "2026年04月16日" -> 20260416 (number)
  const t = String(s || "");
  const m = t.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) return null;
  return y * 10000 + mo * 100 + d;
}

function hasJapanese(text) {
  return /[ぁ-んァ-ン一-龯]/.test(String(text || ""));
}

// 最新刊判定：volumeHint優先、無ければ publishedAt（JP日付を数値化）で比較
function pickLatest(prev, cur) {
  if (!prev) return cur;

  const pv = toNum(prev.volumeHint);
  const cv = toNum(cur.volumeHint);
  if (pv != null && cv != null) return cv > pv ? cur : prev;

  const pa = parseDateJP(prev.publishedAt);
  const ca = parseDateJP(cur.publishedAt);
  if (pa != null && ca != null) return ca > pa ? cur : prev;

  // fallback: string compare
  const ps = String(prev.publishedAt || "");
  const cs = String(cur.publishedAt || "");
  return cs > ps ? cur : prev;
}

// 1巻候補：volumeHint===1 -> 最小volumeHint -> 最古publishedAt -> 先頭
function pickVol1(items) {
  if (!Array.isArray(items) || items.length === 0) return null;

  // 1) volumeHint === 1
  for (const it of items) {
    const v = toNum(it?.volumeHint);
    if (v === 1) return it;
  }

  // 2) min volumeHint
  const withV = items
    .map((it) => ({ it, v: toNum(it?.volumeHint) }))
    .filter((x) => x.v != null)
    .sort((a, b) => a.v - b.v);
  if (withV.length) return withV[0].it;

  // 3) earliest publishedAt
  const withD = items
    .map((it) => ({ it, d: parseDateJP(it?.publishedAt) }))
    .filter((x) => x.d != null)
    .sort((a, b) => a.d - b.d);
  if (withD.length) return withD[0].it;

  return items[0] || null;
}

function buildMasterIndex(seriesMasterRoot) {
  // series_master.json: { meta, items: { [anilistId]: obj } }
  const itemsObj =
    seriesMasterRoot &&
    typeof seriesMasterRoot === "object" &&
    seriesMasterRoot.items &&
    typeof seriesMasterRoot.items === "object" &&
    !Array.isArray(seriesMasterRoot.items)
      ? seriesMasterRoot.items
      : {};

  const bySeriesKey = new Map();

  for (const [id, s] of Object.entries(itemsObj)) {
    const anilistId = toNum(s?.anilistId) ?? toNum(id);
    const seriesKey = normKey(s?.seriesKey);
    const titleNative = normKey(s?.titleNative);
    const titleRomaji = normKey(s?.titleRomaji);

    const put = (k) => {
      const kk = normKey(k);
      if (!kk) return;
      if (!bySeriesKey.has(kk)) bySeriesKey.set(kk, { ...s, anilistId: anilistId ?? null });
    };

    put(seriesKey);
    put(titleNative);
    put(titleRomaji);
  }

  return { bySeriesKey, itemsObj };
}

const main = async () => {
  const itemsRaw = await loadJson(ITEMS, []);
  const items = Array.isArray(itemsRaw) ? itemsRaw : [];

  const seriesRoot = await loadJson(SERIES, {});
  const { bySeriesKey } = buildMasterIndex(seriesRoot);

  // seriesKey -> all items
  const itemsBySeries = new Map();
  for (const it of items) {
    if (!it) continue;
    if (it.seriesType && it.seriesType !== "main") continue; // 一旦 main のみ
    const seriesKey = normKey(it.workKey || it.seriesKey || it.title);
    if (!seriesKey) continue;
    if (!itemsBySeries.has(seriesKey)) itemsBySeries.set(seriesKey, []);
    itemsBySeries.get(seriesKey).push(it);
  }

  const list = [];
  const todo = {};

  let totalSeries = 0;
  let kept = 0;
  let skippedNoMaster = 0;
  let skippedVol1NotConfirmed = 0;

  for (const [seriesKey, arr] of itemsBySeries.entries()) {
    totalSeries++;

    const sm = bySeriesKey.get(seriesKey) || null;
    if (!sm) {
      skippedNoMaster++;
      todo[seriesKey] = {
        reason: "NO_SERIES_MASTER",
        seriesKey,
        hint: { latestTitle: arr?.[0]?.title || null },
      };
      continue;
    }

    const latest = arr.reduce((p, c) => pickLatest(p, c), null);
    const vol1cand = pickVol1(arr);

    const vol1Image = vol1cand?.image || sm?.vol1?.image || null;
    const vol1AmazonDp =
      dpFrom(vol1cand?.asin || vol1cand?.amazonUrl || "") ||
      dpFrom(sm?.vol1?.amazonDp || "") ||
      null;

    const vol1Confirmed = Boolean(vol1Image && vol1AmazonDp);

    if (!vol1Confirmed) {
      skippedVol1NotConfirmed++;
      todo[seriesKey] = {
        reason: "VOL1_NOT_CONFIRMED",
        seriesKey,
        anilistId: sm?.anilistId ?? null,
        vol1: {
          image: vol1Image,
          amazonDp: vol1AmazonDp,
          isbn13: vol1cand?.isbn13 || sm?.vol1?.isbn13 || null,
          volumeHint: toNum(vol1cand?.volumeHint),
          publishedAt: vol1cand?.publishedAt || null,
        },
        latest: {
          volume: toNum(latest?.volumeHint),
          isbn13: latest?.isbn13 || null,
          publishedAt: latest?.publishedAt || null,
        },
      };
      continue;
    }

    // description は “日本語があるものだけ” 採用（英語は出さない）
    const candDesc = String(vol1cand?.description || "").trim();
    const masterDesc = String(sm?.vol1?.description || "").trim();
    const desc =
      (candDesc && hasJapanese(candDesc) ? candDesc : null) ||
      (masterDesc && hasJapanese(masterDesc) ? masterDesc : null) ||
      "（あらすじ準備中）";

    // tags は series_master 優先（無ければ空）
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
        amazonDp: dpFrom(latest?.asin || latest?.amazonUrl || "") || null,
      },

      vol1: {
        description: desc,
        image: vol1Image,
        amazonDp: vol1AmazonDp,
        needsOverride: desc === "（あらすじ準備中）", // 日本語が取れなかったサイン
      },

      tags,
    });

    kept++;
  }

  // 表示順：最新巻発売日 desc（JP日付を数値化して比較、無ければ文字列）
  list.sort((a, b) => {
    const ad = parseDateJP(a?.latest?.publishedAt);
    const bd = parseDateJP(b?.latest?.publishedAt);
    if (ad != null && bd != null) return bd - ad;
    return String(b?.latest?.publishedAt || "").localeCompare(String(a?.latest?.publishedAt || ""));
  });

  await saveJson(OUT, list);
  await saveJson(TODO, todo);

  console.log(
    `[build_list_items_from_master] totalSeries=${totalSeries} kept=${kept} skippedNoMaster=${skippedNoMaster} skippedVol1NotConfirmed=${skippedVol1NotConfirmed}`
  );
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
