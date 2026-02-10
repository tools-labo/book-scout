// scripts/lane2/run.mjs
// lane2 runner: build -> enrich -> format (site-ready)

try {
  // 1) 1巻確定（data/lane2/series.json など生成）
  await import("./build_lane2.mjs");

  // 2) enrich（PA-API + openBD + AniList → data/lane2/enriched.json）
  await import("./enrich_lane2.mjs");

  // 3) 表示用に整形（data/lane2/works.json を生成）
  await import("./format_lane2.mjs");
} catch (e) {
  console.error("[lane2] run failed:", e);
  process.exit(1);
}
