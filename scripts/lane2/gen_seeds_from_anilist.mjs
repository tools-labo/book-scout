// scripts/lane2/gen_seeds_from_anilist.mjs
import fs from "node:fs/promises";
import path from "node:path";

const OUT = "data/lane2/seeds.json";

async function saveJson(p, obj) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(obj, null, 2));
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
  const all = [];
  for (let page = 1; page <= 6; page++) { // 50*6=300 から100作る
    all.push(...(await fetchAniListPage(page)));
  }

  const seen = new Set();
  const items = [];

  for (const m of all) {
    if (m?.countryOfOrigin !== "JP") continue;

    const native = norm(m?.title?.native);
    const romaji = norm(m?.title?.romaji);

    // nativeが日本語っぽいものだけ採用（英語化が嫌ならromajiは使わない）
    const key = looksJapanese(native) ? native : null;

    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);

    items.push({ seriesKey: key });
    if (items.length >= 100) break;
  }

  await saveJson(OUT, {
    updatedAt: new Date().toISOString(),
    items,
  });

  console.log(`[seedgen] wrote ${items.length} seeds -> ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
