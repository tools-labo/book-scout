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

// "2018-11-16T00:00:01Z" -> "2018-11-16"
function toDateOnly(iso) {
  const s = norm(iso);
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

function clampArray(arr, max) {
  if (!Array.isArray(arr)) return [];
  return arr.slice(0, max).filter((x) => x != null && String(x).trim());
}

async function main() {
  const enriched = await loadJson(IN_ENRICHED, { items: [] });
  const items = Array.isArray(enriched?.items) ? enriched.items : [];

  const works = items.map((x) => {
    const seriesKey = norm(x?.seriesKey);
    const author = norm(x?.author);

    const v = x?.vol1 || {};
    const title = norm(v?.title) || seriesKey || null;

    return {
      seriesKey,
      author: author || null,

      // “表示の核”
      title,
      asin: v?.asin || null,
      isbn13: v?.isbn13 || null,

      // リンク＆画像
      amazonDp: v?.amazonDp || null,
      image: v?.image || null,

      // 出版情報
      publisher: v?.publisher || null,
      contributors: Array.isArray(v?.contributors) ? v.contributors : [],
      releaseDate: toDateOnly(v?.releaseDate),

      // 説明（長文はUI側で折りたたみ）
      description: v?.description || null,
      descriptionSource: v?.descriptionSource || null,

      // ジャンル・タグ（多いので上位だけ使う想定）
      genres: Array.isArray(v?.genres) ? v.genres : [],
      tags: clampArray(v?.tags, 12),

      // 参照元の監査用
      meta: {
        titleLane2: v?.titleLane2 || null,
        anilistId: v?.anilistId || null,
        source: v?.source || null,
      },
    };
  });

  // 並びは一旦 seriesKey で安定化（あとで releaseDate desc とかに変えられる）
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
