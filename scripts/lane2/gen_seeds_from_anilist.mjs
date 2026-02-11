// scripts/lane2/gen_seeds_from_anilist.mjs
import fs from "node:fs/promises";
import path from "node:path";

const OUT = "data/lane2/seeds.json";

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
  // 今回「新規に足す」最大数（デフォ100）
  const addLimit = Math.max(1, Number(process.env.LANE2_SEED_LIMIT || 100));

  // JP縛りで間引かれるので、少し多めにページを掘れる上限
  const maxPages = Number(process.env.LANE2_SEED_MAX_PAGES || 20);

  // 既存seedsを読み、Setに入れておく（★ここがA案の肝：上書きしない）
  const prev = await loadJson(OUT, { updatedAt: "", items: [] });
  const prevItems = Array.isArray(prev?.items) ? prev.items : [];

  const seen = new Set();
  const items = [];

  for (const x of prevItems) {
    const k = norm(x?.seriesKey);
    if (!k) continue;
    if (seen.has(k)) continue;
    seen.add(k);
    items.push({ seriesKey: k }); // 既存はそのまま保持（author等はここでは触らない）
  }

  let added = 0;

  for (let page = 1; page <= maxPages; page++) {
    const list = await fetchAniListPage(page);

    for (const m of list) {
      if (m?.countryOfOrigin !== "JP") continue;

      // ONE_SHOT は除外（lane2の「1巻」判定と混ざりやすい）
      if (String(m?.format || "").toUpperCase() === "ONE_SHOT") continue;

      const native = norm(m?.title?.native);

      // nativeが日本語っぽいものだけ採用（英語化が嫌ならromajiは使わない）
      const key = looksJapanese(native) ? native : null;

      if (!key) continue;
      if (seen.has(key)) continue;

      seen.add(key);
      items.push({ seriesKey: key });
      added++;

      if (added >= addLimit) break;
    }

    if (added >= addLimit) break;

    // AniListに優しい間隔
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
