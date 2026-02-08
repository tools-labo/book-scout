import fs from "node:fs/promises";

const VOL1 = "data/manga/vol1_master.json";
const OUT = "data/manga/list_items.json";

async function loadJson(p, fallback) {
  try {
    return JSON.parse(await fs.readFile(p, "utf8"));
  } catch {
    return fallback;
  }
}

async function saveJson(p, obj) {
  await fs.mkdir(p.split("/").slice(0, -1).join("/"), { recursive: true });
  await fs.writeFile(p, JSON.stringify(obj, null, 2));
}

async function main() {
  const master = await loadJson(VOL1, {});
  const list = [];

  for (const [seriesKey, v] of Object.entries(master)) {
    list.push({
      seriesKey,
      anilistId: null,
      title: v?.title || seriesKey,
      author: v?.author || null,
      publisher: v?.publisher || null,

      // レーン①は後回しなので latest は空でOK（UI側が落ちない形にする）
      latest: {
        volume: null,
        isbn13: null,
        publishedAt: null,
        asin: null,
        amazonDp: null
      },

      vol1: {
        description: v?.description || "（あらすじ準備中）",
        image: v?.image || null,
        amazonDp: v?.amazonDp || null,
        needsOverride: false
      },

      tags: { genre: [], demo: [], publisher: [] }
    });
  }

  // とりあえずタイトル順（好みで変えてOK）
  list.sort((a, b) => String(a.title).localeCompare(String(b.title), "ja"));

  await saveJson(OUT, list);
  console.log(`[build_list_from_vol1] items=${list.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
