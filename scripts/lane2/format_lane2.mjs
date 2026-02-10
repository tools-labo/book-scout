// scripts/lane2/format_lane2.mjs
import fs from "node:fs/promises";
import path from "node:path";

const IN_ENRICHED = "data/lane2/enriched.json";
const OUT_WORKS = "data/lane2/works.json";

function nowIso() {
  return new Date().toISOString();
}
async function loadJson(p, fallback) {
  try {
    return JSON.parse(await fs.readFile(p, "utf8"));
  } catch {
    return fallback;
  }
}
async function saveJson(p, obj) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(obj, null, 2));
}

function norm(s) {
  return String(s ?? "").trim();
}

// "2018-11-16T00:00:01Z" / "20180610" / "2022-06-10" -> "YYYY-MM-DD" or null
function toDateOnly(v) {
  const s = norm(v);
  if (!s) return null;
  const m1 = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m1) return m1[1];
  const m2 = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m2) return `${m2[1]}-${m2[2]}-${m2[3]}`;
  return null;
}

function clampArray(arr, max) {
  if (!Array.isArray(arr)) return [];
  return arr
    .map((x) => norm(x))
    .filter(Boolean)
    .slice(0, max);
}

async function main() {
  const enriched = await loadJson(IN_ENRICHED, { items: [] });
  const items = Array.isArray(enriched?.items) ? enriched.items : [];

  const works = items.map((x) => {
    const seriesKey = norm(x?.seriesKey);
    const author = norm(x?.author);

    const v = x?.vol1 || {};
    const title = norm(v?.title) || seriesKey || null;

    const publisherBrand = norm(v?.publisher?.brand) || null;
    const publisherManufacturer = norm(v?.publisher?.manufacturer) || null;

    return {
      seriesKey,
      author: author || null,

      // 表示の核
      title,
      asin: v?.asin || null,
      isbn13: v?.isbn13 || null,

      // リンク＆画像
      amazonDp: v?.amazonDp || null,
      image: v?.image || null,

      // 出版情報
      publisher: {
        brand: publisherBrand,
        manufacturer: publisherManufacturer,
      },
      releaseDate: toDateOnly(v?.releaseDate),

      // 連載誌（掲載誌）
      serializedIn: clampArray(v?.serializedIn, 2), // 0なら非表示
      wikidataQid: v?.wikidataQid || null,

      // あらすじ（日本語だけ / 無ければnull）
      description: norm(v?.description) || null,
      descriptionSource: v?.descriptionSource || null,

      // 日本語化済み
      genres: clampArray(v?.genresJa, 6),
      tags: clampArray(v?.tagsJa, 12),

      // 監査用
      meta: {
        titleLane2: v?.titleLane2 || null,
        anilistId: v?.anilistId || null,
        source: v?.source || null,
      },
    };
  });

  works.sort((a, b) => String(a.seriesKey).localeCompare(String(b.seriesKey), "ja"));

  await saveJson(OUT_WORKS, {
    updatedAt: nowIso(),
    total: works.length,
    items: works,
  });

  console.log(`[lane2:format] total=${works.length} -> ${OUT_WORKS}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
