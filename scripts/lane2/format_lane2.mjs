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

      title,
      asin: v?.asin || null,
      isbn13: v?.isbn13 || null,

      amazonDp: v?.amazonDp || null,
      image: v?.image || null,

      publisher: v?.publisher || null,
      contributors: Array.isArray(v?.contributors) ? v.contributors : [],
      releaseDate: toDateOnly(v?.releaseDate),

      // ★日本語あらすじ（openBDのみ / 無いならnull）
      description: v?.description || null,

      // ★表示したい要素
      magazine: v?.magazine || null,
      genres: Array.isArray(v?.genres) ? v.genres : [],
      tags: clampArray(v?.tags, 12),

      meta: {
        titleLane2: v?.titleLane2 || null,
        source: v?.source || null,
        wikidataQid: v?.meta?.wikidataQid || null,
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
