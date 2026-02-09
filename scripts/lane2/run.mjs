// scripts/lane2/run.mjs
// build → enrich を順序保証して実行するランナー
await import("./build_lane2.mjs");
await import("./enrich_lane2.mjs");
