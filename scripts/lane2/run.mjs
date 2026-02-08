import { loadJson, saveJson, nowIso, norm } from "./util.mjs";

const SEEDS = "data/lane2/seeds.json";
const OUT_SERIES = "data/lane2/series.json";
const OUT_TODO = "data/lane2/todo.json";

async function main() {
  const seeds = await loadJson(SEEDS, { items: [] });
  const items = Array.isArray(seeds?.items) ? seeds.items : [];

  // いまは“何もしない”で todo に入れるだけ（パイプライン確認用）
  const todo = items
    .map((s) => ({
      seriesKey: norm(s?.seriesKey),
      author: norm(s?.author) || null,
      reason: "lane2_bootstrap(no_ndl_no_paapi_yet)",
      best: null
    }))
    .filter((x) => x.seriesKey);

  const outSeries = {
    updatedAt: nowIso(),
    total: items.length,
    confirmed: 0,
    todo: todo.length,
    items: []
  };

  const outTodo = {
    updatedAt: nowIso(),
    total: todo.length,
    items: todo
  };

  await saveJson(OUT_SERIES, outSeries);
  await saveJson(OUT_TODO, outTodo);

  console.log(`[lane2] seeds=${items.length} confirmed=0 todo=${todo.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
