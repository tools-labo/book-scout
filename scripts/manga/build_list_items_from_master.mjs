// scripts/manga/build_list_items_from_master.mjs （全差し替え）
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

  // URL -> dp
  const m = s.match(
    /^https:\/\/www\.amazon\.co\.jp\/dp\/([A-Z0-9]{10}|[0-9]{9}X|[0-9]{10})(?:[/?].*)?$/i
  );
  if (m) return `https://www.amazon.co.jp/dp/${m[1]}`;

  // ASIN -> dp
  const asin = s.toUpperCase().replace(/[^0-9A-Z]/g, "");
  if (/^[A-Z0-9]{10}$/.test(asin)) return `https://www.amazon.co.jp/dp/${asin}`;

  return null;
}

function toNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

// 最新刊判定：volumeHint があればそれ優先、なければ publishedAt(文字列)で比較（簡易）
function pickLatest(prev, cur) {
  if (!prev) return cur;

  const pv = toNum(prev.volumeHint);
  const cv = toNum(cur.volumeHint);

  if (pv != null && cv != null) return cv > pv ? cur : prev;

  // fallback: publishedAt (YYYY年MM月DD日 想定だが、文字列比較で簡易)
  const pa = String(prev.publishedAt || "");
  const ca = String(cur.publishedAt || "");
  return ca > pa ? cur : prev;
}

function uniq(arr) {
  return [...new Set((arr || []).filter(Boolean))];
}

async function main() {
  const items = await loadJson(ITEMS, []);
  const seriesMaster = await loadJson(SERIES, {}); // { [anilistId]: {...} } or { [seriesKey]: {...} } どちらでも許容

  // seriesKey -> { latestItem, vol1Item }
  const bySeries = new Map();

  for (const it of items) {
    if (!it) continue;

    const sk = it.seriesKey || it.workKey; // 今のデータは seriesKey を採用、無ければ workKey fallback
    if (!sk) continue;

    if (!bySeries.has(sk)) bySeries.set(sk, { latest: null, vol1: null });

    const slot = bySeries.get(sk);

    // latest: seriesType=main のみ対象（外伝/スピンオフ混入を避けたいならここで絞る）
    if (it.seriesType === "main") {
      slot.latest = pickLatest(slot.latest, it);
    }

    // vol1: volumeHint===1 の main のみ
    if (it.seriesType === "main" && toNum(it.volumeHint) === 1) {
      // 既にあれば先勝ち（同一なら問題ない想定）
      if (!slot.vol1) slot.vol1 = it;
    }
  }

  // series_master を引くための索引を2系統用意
  // 1) anilistId -> master
  const masterByAni = new Map();
  // 2) seriesKey -> master
  const masterBySeriesKey = new Map();

  for (const [k, v] of Object.entries(seriesMaster || {})) {
    if (!v) continue;
    if (v.anilistId != null) masterByAni.set(String(v.anilistId), v);
    if (v.seriesKey) masterBySeriesKey.set(String(v.seriesKey), v);
    // series_masterが「key=anilistId」形式でも、v.seriesKey が入ってれば拾える
    // 「key=seriesKey」形式でも、k が seriesKey の場合は拾える
    if (!v.seriesKey && typeof k === "string") {
      // seriesKeyとしても使えそうなら登録
      masterBySeriesKey.set(String(k), v);
    }
  }

  const out = [];

  for (const [seriesKey, slot] of bySeries.entries()) {
    const latest = slot.latest;
    if (!latest) continue;

    const aniId = latest.anilistId != null ? String(latest.anilistId) : null;
    const master =
      (aniId && masterByAni.get(aniId)) ||
      masterBySeriesKey.get(String(seriesKey)) ||
      null;

    const latestDp = dpFrom(latest.amazonDp || latest.amazonUrl || latest.asin);

    // vol1は master優先（なければ items_master の vol1）
    const masterVol1 = master?.vol1 || null;
    const vol1Item = slot.vol1 || null;

    const vol1Desc = masterVol1?.description ?? null;
    const vol1Img = masterVol1?.image ?? null;

    // vol1のAmazonは masterVol1.amazonDp -> vol1Item -> null
    const vol1Dp =
      dpFrom(masterVol1?.amazonDp) ||
      dpFrom(vol1Item?.amazonDp || vol1Item?.amazonUrl || vol1Item?.asin) ||
      null;

    const genres = uniq(master?.genre || latest?.tags?.genre || []);
    const demos = uniq(master?.demo || latest?.tags?.demo || []);
    const pubs = uniq(master?.publisher ? [master.publisher] : (latest?.tags?.publisher || []));

    out.push({
      seriesKey,
      anilistId: aniId ? Number(aniId) : null,
      title: master?.titleNative || master?.titleRomaji || latest.title || seriesKey,
      author: latest.author || master?.author || null,
      publisher: latest.publisher || master?.publisher || null,

      latest: {
        volume: toNum(latest.volumeHint),
        isbn13: latest.isbn13 || null,
        publishedAt: latest.publishedAt || null,
        asin: latest.asin || null,
        amazonDp: latestDp,
      },

      vol1: {
        description: vol1Desc,
        image: vol1Img,
        amazonDp: vol1Dp,
      },

      tags: {
        genre: genres,
        demo: demos,
        publisher: pubs,
      },
    });
  }

  // ソート：発売日 desc -> title asc
  out.sort((a, b) => {
    const ad = String(a.latest?.publishedAt || "");
    const bd = String(b.latest?.publishedAt || "");
    if (ad !== bd) return ad < bd ? 1 : -1;
    return String(a.title || "").localeCompare(String(b.title || ""), "ja");
  });

  await saveJson(OUT, out);
  console.log(`[build_list_items_from_master] series=${out.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
