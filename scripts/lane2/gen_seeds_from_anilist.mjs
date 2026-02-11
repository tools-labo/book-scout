// scripts/lane2/gen_seeds_from_anilist.mjs
import fs from "node:fs/promises";
import path from "node:path";

const OUT = "data/lane2/seeds.json";
const STATE = "data/lane2/seedgen_state.json";

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
  // 1回の「追加件数」
  const addCount = Math.max(1, Number(process.env.LANE2_SEED_ADD || process.env.LANE2_SEED_LIMIT || 100));

  // 1回の実行で掘る最大ページ数（APIに優しく＆時間も守る）
  const maxPages = Math.max(1, Number(process.env.LANE2_SEED_MAX_PAGES || 20));

  // 既存seedsを読み込む（積み上げ）
  const prev = await loadJson(OUT, { updatedAt: "", items: [] });
  const prevItems = Array.isArray(prev?.items) ? prev.items : [];

  // 既存キーをseenに入れる
  const seen = new Set(prevItems.map((x) => norm(x?.seriesKey)).filter(Boolean));

  // state（次の開始ページ）
  const state = await loadJson(STATE, { updatedAt: "", nextPage: 1 });
  let page = Math.max(1, Number(state?.nextPage || 1));

  const added = [];
  const pageStart = page;

  for (let i = 0; i < maxPages; i++, page++) {
    const list = await fetchAniListPage(page);

    for (const m of list) {
      if (m?.countryOfOrigin !== "JP") continue;

      // ONE_SHOT は除外（lane2の1巻判定と混ざりやすい）
      if (String(m?.format || "").toUpperCase() === "ONE_SHOT") continue;

      const native = norm(m?.title?.native);
      const key = looksJapanese(native) ? native : null;
      if (!key) continue;

      if (seen.has(key)) continue;
      seen.add(key);

      added.push({ seriesKey: key });
      if (added.length >= addCount) break;
    }

    if (added.length >= addCount) break;

    // AniListに優しい間隔
    await sleep(250);
  }

  const nextItems = prevItems.concat(added);

  await saveJson(OUT, {
    updatedAt: new Date().toISOString(),
    items: nextItems,
  });

  await saveJson(STATE, {
    updatedAt: new Date().toISOString(),
    nextPage: page, // 次回はここから続き
    lastRun: { added: added.length, addCount, pageStart, pageEnd: page - 1 },
  });

  console.log(`[seedgen] added ${added.length}/${addCount} (total ${nextItems.length}) pages ${pageStart}-${page - 1} -> ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
