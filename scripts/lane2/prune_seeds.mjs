// scripts/lane2/prune_seeds.mjs
import fs from "node:fs/promises";
import path from "node:path";

const SEEDS = "data/lane2/seeds.json";
const SERIES = "data/lane2/series.json";

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

async function main() {
  const seeds = await loadJson(SEEDS, { updatedAt: "", total: 0, addedThisRun: 0, items: [] });
  const series = await loadJson(SERIES, { version: 1, updatedAt: "", total: 0, items: [] });

  const seedItems = Array.isArray(seeds?.items) ? seeds.items : [];
  const seriesItems = Array.isArray(series?.items) ? series.items : [];

  const done = new Set(seriesItems.map((x) => norm(x?.seriesKey)).filter(Boolean));

  const before = seedItems.length;

  // seeds から series 済みを落とす
  const kept = [];
  const seen = new Set(); // seeds内の重複も潰す
  for (const x of seedItems) {
    const k = norm(x?.seriesKey);
    if (!k) continue;
    if (done.has(k)) continue;
    if (seen.has(k)) continue;
    seen.add(k);
    kept.push({ seriesKey: k });
  }

  const after = kept.length;
  const removed = before - after;

  await saveJson(SEEDS, {
    updatedAt: new Date().toISOString(),
    total: kept.length,
    addedThisRun: Number(seeds?.addedThisRun ?? 0), // 既存を維持（不要なら消してOK）
    removedThisRun: removed,
    items: kept,
  });

  // series の total も自動で正す（手編集不要化）
  await saveJson(SERIES, {
    ...series,
    updatedAt: series?.updatedAt || new Date().toISOString(),
    total: seriesItems.length,
    items: seriesItems,
  });

  console.log(`[prune_seeds] seeds: ${before} -> ${after} (removed ${removed})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
