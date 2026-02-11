// scripts/lane2/format_lane2.mjs
// ★変更なし（enriched は confirmed だけから作られる前提。review は build 側で隔離され、ここには来ない）
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
      titleLane2: v?.titleLane2 ?? null,
      anilistId: v?.anilistId ?? null,
      wikiTitle: v?.wikiTitle ?? null,
      source: v?.source ?? null,
    };

    const tags = uniq(v?.tags).slice(0, 24);

    return compact({
      seriesKey: x?.seriesKey ?? null,
      author: x?.author ?? null,
      title: v?.title ?? null,
      asin: v?.asin ?? null,
      amazonDp: v?.amazonDp ?? null,
      image: v?.image ?? null,
      releaseDate: v?.releaseDate ?? null,
      publisher: v?.publisher ?? null,
      magazine: v?.magazine ?? null,
      synopsis: v?.synopsis ?? null,
      synopsisSource: v?.synopsisSource ?? null,
      genres: uniq(v?.genres),
      tags,
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
