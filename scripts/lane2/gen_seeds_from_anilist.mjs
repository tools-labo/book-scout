// scripts/lane2/gen_seeds_from_anilist.mjs
import fs from "node:fs/promises";
import path from "node:path";

const OUT = "data/lane2/seeds.json";
const SERIES = "data/lane2/series.json";
const EXCLUDES = "data/lane2/excludes.json";

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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchAniListPage(page) {
  const query = `
    query ($page:Int) {
      Page(page:$page, perPage:50) {
        media(type:MANGA, sort:POPULARITY_DESC) {
          title { native romaji }
          countryOfOrigin
          format
        }
      }
    }
  `;
  const r = await fetch("https://graphql.anilist.co", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "user-agent": "tools-labo/book-scout lane2 seedgen",
    },
    body: JSON.stringify({ query, variables: { page } }),
  });
  if (!r.ok) throw new Error(`AniList HTTP ${r.status}`);
  const json = await r.json();
  return json?.data?.Page?.media || [];
}

function norm(s) {
  return String(s ?? "").trim();
}
function looksJapanese(s) {
  return /[ぁ-んァ-ヶ一-龠]/.test(String(s ?? ""));
}

async function main() {
  // ★今回「新規に足す」最大数
  // LANE2_SEED_ADD を最優先。互換で LANE2_SEED_LIMIT も読む。
  // ★0 を許可（= 追加しない）
  const addRaw = process.env.LANE2_SEED_ADD || process.env.LANE2_SEED_LIMIT || "100";
  const addLimit = Math.max(0, Number(addRaw) || 0);

  // seedgen が掘る最大ページ数
  const maxPages = Number(process.env.LANE2_SEED_MAX_PAGES || 20);

  // 既存seedsを読み、Setに入れておく（上書きしない）
  const prev = await loadJson(OUT, { updatedAt: "", total: 0, addedThisRun: 0, items: [] });
  const prevItems = Array.isArray(prev?.items) ? prev.items : [];

  // ★series を読み、すでに series 済みの作品は seed に「追加しない」
  const series = await loadJson(SERIES, { version: 1, updatedAt: "", total: 0, items: [] });
  const seriesItems = Array.isArray(series?.items) ? series.items : [];
  const done = new Set(seriesItems.map((x) => norm(x?.seriesKey)).filter(Boolean));

  // ★excludes を読み、seed段階では seriesKey で除外
  const ex = await loadJson(EXCLUDES, { version: 1, updatedAt: "", seriesKeys: [], asins: [] });
  const excludeKeys = new Set(
    (Array.isArray(ex?.seriesKeys) ? ex.seriesKeys : [])
      .map((x) => norm(x))
      .filter(Boolean)
  );

  const seen = new Set();
  const items = [];

  // seeds 既存分（+重複排除）を保持。ただし series 済み＆exclude は落とす（ここで掃除もする）
  for (const x of prevItems) {
    const k = norm(x?.seriesKey);
    if (!k) continue;
    if (done.has(k)) continue;
    if (excludeKeys.has(k)) continue;
    if (seen.has(k)) continue;
    seen.add(k);
    items.push({ seriesKey: k });
  }

  // ★追加なし
  if (addLimit === 0) {
    await saveJson(OUT, {
      updatedAt: new Date().toISOString(),
      total: items.length,
      addedThisRun: 0,
      items,
    });
    console.log(`[seedgen] added 0/0 (total ${items.length}) -> ${OUT}`);
    return;
  }

  let added = 0;

  for (let page = 1; page <= maxPages; page++) {
    const list = await fetchAniListPage(page);

    for (const m of list) {
      if (m?.countryOfOrigin !== "JP") continue;
      if (String(m?.format || "").toUpperCase() === "ONE_SHOT") continue;

      const native = norm(m?.title?.native);
      const key = looksJapanese(native) ? native : null;
      if (!key) continue;

      // ★series 済みは seed に入れない
      if (done.has(key)) continue;

      // ★excludes は seed に入れない（0巻対策など）
      if (excludeKeys.has(key)) continue;

      // ★seeds内での重複も入れない
      if (seen.has(key)) continue;

      seen.add(key);
      items.push({ seriesKey: key });
      added++;

      if (added >= addLimit) break;
    }

    if (added >= addLimit) break;
    await sleep(250);
  }

  await saveJson(OUT, {
    updatedAt: new Date().toISOString(),
    total: items.length,
    addedThisRun: added,
    items,
  });

  console.log(`[seedgen] added ${added}/${addLimit} (total ${items.length}) -> ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
