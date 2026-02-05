// scripts/manga/build_list_items.mjs
import fs from "node:fs/promises";

const CAT = process.env.CAT || "manga";

const ITEMS_PATH = `data/${CAT}/items_master.json`;
const SERIES_PATH = `data/${CAT}/series_master.json`;
const OUT_PATH = `data/${CAT}/list_items.json`;

const digits = (s) => String(s || "").replace(/\D/g, "");
const toInt = (v) => (v == null ? null : Number(v));

const normalizeDpUrl = (asinOrUrl) => {
  if (!asinOrUrl) return null;
  const s = String(asinOrUrl).trim();

  // URLからASIN抜く（/dp/ASIN 形式）
  const m = s.match(/^https:\/\/www\.amazon\.co\.jp\/dp\/([A-Z0-9]{10}|[0-9]{9}X|[0-9]{10})(?:[/?].*)?$/i);
  if (m) return `https://www.amazon.co.jp/dp/${m[1]}`;

  // ASIN単体
  const asin = s.toUpperCase().replace(/[^0-9A-Z]/g, "");
  if (/^[A-Z0-9]{10}$/.test(asin)) return `https://www.amazon.co.jp/dp/${asin}`;

  return null;
};

const pickSeriesTitle = (s, fallbackWorkKey) => {
  // AniList seed: titleNative/titleRomaji を想定
  const t =
    s?.titleNative ||
    s?.title_native ||
    s?.title?.native ||
    s?.titleRomaji ||
    s?.title_romaji ||
    s?.title?.romaji ||
    s?.title ||
    null;

  return (t && String(t).trim()) || fallbackWorkKey;
};

const main = async () => {
  const items = JSON.parse(await fs.readFile(ITEMS_PATH, "utf8"));
  let series = {};
  try {
    series = JSON.parse(await fs.readFile(SERIES_PATH, "utf8"));
  } catch {
    series = {};
  }

  // 1) 最新巻をシリーズごとに決める（seriesType=main のみ）
  const latestByWork = new Map(); // workKey -> item(latest)
  for (const it of items) {
    if (!it || it.seriesType !== "main") continue;
    const wk = it.workKey;
    if (!wk) continue;

    const cur = latestByWork.get(wk);
    const v = toInt(it.volumeHint) ?? -1;
    const cv = toInt(cur?.volumeHint) ?? -1;

    // volumeHint 大きい方を最新とみなす（同数なら publishedAt で比較してもOK）
    if (!cur || v > cv) latestByWork.set(wk, it);
  }

  // 2) series_master を引けるように index を作る
  // series_master は anilistId キー想定（"30013": {...}）
  // workKey だけのやつもあるかもしれないので両対応
  const seriesByAni = new Map();
  const seriesByWorkKey = new Map();

  for (const [k, s] of Object.entries(series || {})) {
    const ani = s?.anilistId ?? s?.anilist_id ?? null;
    if (ani != null) seriesByAni.set(String(ani), s);

    const wk = s?.seriesKey ?? s?.workKey ?? null;
    if (wk) seriesByWorkKey.set(String(wk), s);

    // もしキー自体が workKey で入ってる可能性にも対応
    if (!seriesByWorkKey.has(k) && !/^\d+$/.test(k)) {
      seriesByWorkKey.set(k, s);
    }
  }

  // 3) list_items を生成
  const out = [];
  for (const [wk, latest] of latestByWork.entries()) {
    const aniId = latest?.anilistId != null ? String(latest.anilistId) : null;

    const s =
      (aniId && seriesByAni.get(aniId)) ||
      seriesByWorkKey.get(wk) ||
      null;

    const title = pickSeriesTitle(s, wk);

    const latestAmazonDp = normalizeDpUrl(latest?.asin || latest?.amazonUrl);
    const vol1 = s?.vol1 || null;

    const vol1Desc = (vol1?.description && String(vol1.description)) || null;
    const vol1Img = vol1?.image || null;
    const vol1AmazonDp = normalizeDpUrl(vol1?.amazonDp || vol1?.amazonUrl || vol1?.asin);

    out.push({
      seriesKey: wk,
      anilistId: aniId ? Number(aniId) : null,

      title,
      author: latest?.author || s?.author || null,
      publisher: latest?.publisher || s?.publisher || null,

      latest: {
        volume: toInt(latest?.volumeHint) ?? null,
        isbn13: latest?.isbn13 || null,
        publishedAt: latest?.publishedAt || null,
        asin: latest?.asin || null,
        amazonDp: latestAmazonDp,
      },

      vol1: {
        description: vol1Desc,
        image: vol1Img,
        amazonDp: vol1AmazonDp,
      },

      tags: {
        genre: s?.genre || s?.tags?.genre || latest?.tags?.genre || [],
        demo: s?.demo || s?.tags?.demo || latest?.tags?.demo || [],
        publisher: s?.tags?.publisher || latest?.tags?.publisher || [],
      },
    });
  }

  // 4) 安定ソート（表示が毎回ガタつかない）
  out.sort((a, b) => String(a.title).localeCompare(String(b.title), "ja"));

  await fs.writeFile(OUT_PATH, JSON.stringify(out, null, 2));
  console.log(`[build_list_items] cat=${CAT} series=${out.length} -> ${OUT_PATH}`);
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
