import fs from "node:fs/promises";

const APP_ID = process.env.RAKUTEN_APP_ID;
if (!APP_ID) throw new Error("missing RAKUTEN_APP_ID");

const src = "data/manga/items_master.json";
const cachePath = "data/manga/rakuten_genre_by_isbn.json";

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

const pickItem = (p) => {
  const arr = p?.Items || p?.items || [];
  const x = arr[0];
  return x?.Item || x || null;
};

const splitPath = (s) =>
  String(s || "").split("/").map((x) => x.trim()).filter(Boolean);

// 001001 は「漫画（コミック）」の大分類（booksGenreId）
const isComicIds = (ids) => (ids || []).some((x) => String(x).startsWith("001001"));

function urlBookByIsbn(isbn13) {
  const u = new URL("https://app.rakuten.co.jp/services/api/BooksBook/Search/20170404");
  u.searchParams.set("format", "json");
  u.searchParams.set("formatVersion", "2");
  u.searchParams.set("applicationId", APP_ID);
  u.searchParams.set("hits", "1");
  u.searchParams.set("isbn", String(isbn13)); // ★ここが重要（isbnjan じゃない）
  u.searchParams.set("size", "9"); // ★コミックに絞る（9=Comic）
  return u.toString();
}

const items = JSON.parse(await fs.readFile(src, "utf8"));

let cache = {};
try { cache = JSON.parse(await fs.readFile(cachePath, "utf8")); } catch {}

let hitCache = 0, fetched = 0, miss = 0, refetchBad = 0;

for (const x of items) {
  const isbn = x?.isbn13;
  if (!isbn) continue;

  const c = cache[isbn];
  if (c?.ids?.length) {
    // 既存キャッシュが漫画じゃないなら捨てて取り直す
    if (!isComicIds(c.ids)) {
      refetchBad++;
    } else {
      x.rakutenGenreIds = c.ids;
      hitCache++;
      continue;
    }
  }

  await sleep(220);

  let it = null;
  try {
    const p = await fetchJson(urlBookByIsbn(isbn));
    it = pickItem(p);
  } catch {
    miss++;
    continue;
  }
  if (!it) { miss++; continue; }

  const ids = splitPath(it.booksGenreId);
  x.rakutenGenreIds = ids;
  cache[isbn] = { ids };
  fetched++;
}

await fs.writeFile(src, JSON.stringify(items, null, 2));
await fs.writeFile(cachePath, JSON.stringify(cache, null, 2));
console.log(`rakuten_tags: cache_hit=${hitCache} fetched=${fetched} refetch_bad_cache=${refetchBad} miss=${miss}`);
