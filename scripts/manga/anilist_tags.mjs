// scripts/manga/anilist_tags.mjs
import fs from "node:fs/promises";

const SRC = "data/manga/items_master.json";
const WD = "data/manga/wikidata_by_isbn.json";
const OUT = "data/manga/items_master.json"; // 上書き
const API = "https://graphql.anilist.co";

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function postJson(body, tries = 5) {
  for (let i = 0; i < tries; i++) {
    const r = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify(body),
    });
    if (r.ok) return r.json();
    const t = await r.text();
    if (r.status === 429 || (r.status >= 500 && r.status <= 599)) { await sleep(500 * (i + 1)); continue; }
    throw new Error(`HTTP ${r.status}\n${t.slice(0, 200)}`);
  }
  throw new Error("retry_exceeded");
}

const items = JSON.parse(await fs.readFile(SRC, "utf8"));
let wd = {};
try { wd = JSON.parse(await fs.readFile(WD, "utf8")); } catch {}

const byWork = new Map();
for (const it of items) {
  const k = it.workKey || it.title;
  const arr = byWork.get(k) || [];
  arr.push(it);
  byWork.set(k, arr);
}

const query = `
query ($id: Int) {
  Media(id: $id, type: MANGA) {
    genres
    tags { name rank isMediaSpoiler isGeneralSpoiler }
  }
}
`.trim();

let tagged = 0, miss = 0;

for (const [wk, group] of byWork) {
  // 巻1優先でisbnを選ぶ
  const vol1 = group.find(x => x.volumeHint === 1) || group.find(x => x._rep) || group[0];
  const isbn = vol1?.isbn13 ? String(vol1.isbn13) : null;
  const aid = isbn ? wd?.[isbn]?.anilist : null;
  if (!aid) { miss++; continue; }

  const data = await postJson({ query, variables: { id: aid } });
  const media = data?.data?.Media;
  if (!media) { miss++; continue; }

  const genres = (media.genres || []).filter(Boolean);
  const tags = (media.tags || [])
    .filter(t => t && !t.isMediaSpoiler && !t.isGeneralSpoiler)
    .sort((a,b) => (b.rank||0) - (a.rank||0))
    .slice(0, 12)
    .map(t => t.name);

  for (const it of group) {
    it.anilistId = aid;
    it.anilistGenres = genres;
    it.anilistTags = tags;
  }
  tagged++;

  if (tagged % 10 === 0) await sleep(200);
}

await fs.writeFile(OUT, JSON.stringify(items, null, 2));
console.log(`anilist_tags: works=${byWork.size} tagged=${tagged} miss=${miss}`);
