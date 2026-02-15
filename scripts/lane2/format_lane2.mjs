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

// null/空 を落としてスリムに
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

async function main() {
  const src = await loadJson(IN_ENRICHED, { items: [] });
  const items = Array.isArray(src?.items) ? src.items : [];

  const outItems = items.map((x) => {
    const v = x?.vol1 || {};
    const meta = {
      anilistId: v?.anilistId ?? null,
      wikiTitle: v?.wikiTitle ?? null,
      source: v?.source ?? null,
    };

    return compact({
      seriesKey: x?.seriesKey ?? null,

      // 表示したい項目
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

      // synopsis（manual）
      synopsis: v?.synopsis ?? null,

      // 連載誌（表示/分類用）
      magazine: v?.magazine ?? null,
      magazines: uniq(v?.magazines),
      audiences: uniq(v?.audiences),
      magazineSource: v?.magazineSource ?? null,

      // AniList（genresだけ残す）
      genres: uniq(v?.genres),

      meta,
    });
  });

  const out = {
    updatedAt: src?.updatedAt ?? new Date().toISOString(),
    total: outItems.length,
    items: outItems,
  };

  await saveJson(OUT_WORKS, out);
  console.log(`[lane2:format] total=${outItems.length} -> ${OUT_WORKS}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
