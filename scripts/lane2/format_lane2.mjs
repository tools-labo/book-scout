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

    const pub = v?.publisher || null;
    const publisherText =
      pub?.brand || pub?.manufacturer || null;

    return {
      seriesKey,
      author: author || null,

      title,
      asin: v?.asin || null,

      amazonDp: v?.amazonDp || null,
      image: v?.image || null,

      releaseDate: toDateOnly(v?.releaseDate),
      publisher: publisherText,

      // ★連載誌
      magazine: v?.magazine || null,

      // ★日本語優先の“あらすじ”
      synopsis: v?.synopsis || null,
      synopsisSource: v?.synopsisSource || null,

      genres: Array.isArray(v?.genres) ? v.genres : [],
      tags: clampArray(v?.tags, 20),

      meta: {
        titleLane2: v?.titleLane2 || null,
        anilistId: v?.anilistId || null,
        wikiTitle: v?.wikiTitle || null,
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
