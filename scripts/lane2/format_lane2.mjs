// scripts/lane2/format_lane2.mjs
import fs from "node:fs/promises";
import path from "node:path";

const IN_ENRICHED = "data/lane2/enriched.json";
const OUT_WORKS = "data/lane2/works.json";

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
function norm(s) { return String(s ?? "").trim(); }
function uniq(arr) {
  const out = [];
  const seen = new Set();
  for (const x of arr || []) {
    const s = norm(x);
    if (!s) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function compact(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (v == null) continue;
    if (typeof v === "string" && !v.trim()) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    if (typeof v === "object" && !Array.isArray(v)) {
      const inner = compact(v);
      if (Object.keys(inner).length === 0) continue;
      out[k] = inner;
      continue;
    }
    out[k] = v;
  }
  return out;
}

// ★フロント必須（スクショの要件に合わせて）
function isFrontRequiredFilled(v) {
  const req = {
    title: norm(v?.title),
    author: norm(v?.author),
    publisher: norm(v?.publisher),
    releaseDate: norm(v?.releaseDate),
    image: norm(v?.image),
    amazonDp: norm(v?.amazonDp),
    amazonUrl: norm(v?.amazonUrl),
    synopsis: norm(v?.synopsis),
    magazine: norm(v?.magazine),
    audiencesOk: Array.isArray(v?.audiences) && v.audiences.length > 0,
  };

  // audiences は最低1（その他でもOK）になってる想定
  return !!(
    req.title &&
    req.author &&
    req.publisher &&
    req.releaseDate &&
    req.image &&
    req.amazonDp &&
    req.amazonUrl &&
    req.synopsis &&
    req.magazine &&
    req.audiencesOk
  );
}

async function main() {
  const src = await loadJson(IN_ENRICHED, { items: [], stats: {} });
  const items = Array.isArray(src?.items) ? src.items : [];

  const kept = [];
  const dropped = [];

  for (const x of items) {
    const v = x?.vol1 || {};
    if (!isFrontRequiredFilled(v)) {
      dropped.push(norm(x?.seriesKey) || "(unknown)");
      continue;
    }

    const meta = {
      anilistId: v?.anilistId ?? null,
      wikiTitle: v?.wikiTitle ?? null,
      source: v?.source ?? null,
    };

    kept.push(
      compact({
        seriesKey: x?.seriesKey ?? null,

        // 表示
        title: v?.title ?? null,
        author: v?.author ?? null,
        publisher: v?.publisher ?? null,
        releaseDate: v?.releaseDate ?? null,
        image: v?.image ?? null,

        // Amazon
        amazonUrl: v?.amazonUrl ?? null,
        amazonDp: v?.amazonDp ?? null,
        isbn13: v?.isbn13 ?? null,
        asin: v?.asin ?? null,

        synopsis: v?.synopsis ?? null,

        // 連載誌（表示と分類に使う）
        magazine: v?.magazine ?? null,
        magazines: uniq(v?.magazines),
        audiences: uniq(v?.audiences),
        magazineSource: v?.magazineSource ?? null,

        // AniList（genresは表示してもいい、タグは日本語を表示）
        genres: uniq(v?.genres),
        tags: uniq(v?.tags).slice(0, 24),

        meta,
      })
    );
  }

  const out = {
    updatedAt: src?.updatedAt ?? new Date().toISOString(),
    total: kept.length,
    droppedTotal: dropped.length,
    droppedSeriesKeys: dropped, // ★差し戻し対象（次回runで復活する想定）
    items: kept,
  };

  await saveJson(OUT_WORKS, out);

  console.log(`[lane2:format] total_in=${items.length} total_out=${kept.length} dropped=${dropped.length} -> ${OUT_WORKS}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
