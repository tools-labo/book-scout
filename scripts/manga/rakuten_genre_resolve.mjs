import fs from "node:fs/promises";

const APP_ID = process.env.RAKUTEN_APP_ID;
if (!APP_ID) throw new Error("missing RAKUTEN_APP_ID");

const src = "data/manga/items_master.json";
const cachePath = "data/manga/rakuten_genre_name_by_id.json";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url, tries = 4) {
  for (let i = 0; i < tries; i++) {
    const r = await fetch(url, { headers: { "user-agent": "book-scout/1.0" } });
    const t = await r.text();
    if (r.ok) return JSON.parse(t);
    if (r.status === 429 && i < tries - 1) { await sleep(1200 * (i + 1)); continue; }
    throw new Error(`HTTP ${r.status}\n${t.slice(0, 200)}`);
  }
}

function urlGenreSearch(id) {
  const u = new URL("https://app.rakuten.co.jp/services/api/BooksGenre/Search/20121128");
  u.searchParams.set("format", "json");
  u.searchParams.set("formatVersion", "2");
  u.searchParams.set("applicationId", APP_ID);
  u.searchParams.set("booksGenreId", String(id));
  u.searchParams.set("genrePath", "1"); // 親階層も含める
  return u.toString();
}

const items = JSON.parse(await fs.readFile(src, "utf8"));

let cache = {};
try { cache = JSON.parse(await fs.readFile(cachePath, "utf8")); } catch {}

const need = new Set();
for (const x of items) {
  const ids = x?.rakutenGenreIds || [];
  if (ids.length) need.add(ids[ids.length - 1]); // 一番深いIDを採用
}

let hitCache = 0, fetched = 0, miss = 0;

for (const id of need) {
  if (cache[id]?.names?.length) { hitCache++; continue; }

  await sleep(220);

  try {
    const p = await fetchJson(urlGenreSearch(id));
    const parents = Array.isArray(p?.parents) ? p.parents : [];
    const cur = p?.current || null;
    const path = [...parents, ...(cur ? [cur] : [])]
      .map((g) => g?.booksGenreName)
      .filter(Boolean);

    cache[id] = { names: path };
    fetched++;
  } catch {
    cache[id] = { names: [] };
    miss++;
  }
}

for (const x of items) {
  const ids = x?.rakutenGenreIds || [];
  const leaf = ids.length ? ids[ids.length - 1] : null;
  x.rakutenGenrePathNames = leaf ? (cache[leaf]?.names || []) : [];
}

await fs.writeFile(src, JSON.stringify(items, null, 2));
await fs.writeFile(cachePath, JSON.stringify(cache, null, 2));
console.log(`rakuten_genre_resolve: ids=${need.size} cache_hit=${hitCache} fetched=${fetched} miss=${miss}`);
