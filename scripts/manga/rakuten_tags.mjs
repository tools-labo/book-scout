import fs from "node:fs/promises";

const APP_ID = process.env.RAKUTEN_APP_ID;
if (!APP_ID) throw new Error("missing RAKUTEN_APP_ID secret");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url, tries = 4) {
  for (let i = 0; i < tries; i++) {
    const r = await fetch(url, { headers: { "user-agent": "book-scout/1.0" } });
    const t = await r.text();
    if (r.ok) return JSON.parse(t);
    if (r.status === 429 && i < tries - 1) { await sleep(1200 * (i + 1)); continue; }
    throw new Error(`HTTP ${r.status}\nURL: ${url}\nBODY: ${t.slice(0, 200)}`);
  }
}

const pickItem = (p) => {
  const arr = p?.Items || p?.items || [];
  const x = arr[0];
  return x?.Item || x || null;
};

const splitPath = (s) =>
  String(s || "")
    .split("/")
    .map((x) => x.trim())
    .filter(Boolean);

function buildUrl(isbn13) {
  const u = new URL("https://app.rakuten.co.jp/services/api/BooksBook/Search/20170404");
  u.searchParams.set("format", "json");
  u.searchParams.set("formatVersion", "2");
  u.searchParams.set("applicationId", APP_ID);
  u.searchParams.set("hits", "1");
  u.searchParams.set("isbnjan", String(isbn13));
  return u.toString();
}

const path = "data/manga/items_master.json";
const items = JSON.parse(await fs.readFile(path, "utf8"));

let tagged = 0, miss = 0, updated = 0;
for (const x of items) {
  if (!x?.isbn13) continue;

  const hasIds = (x.rakutenGenreIds || []).length > 0;
  const hasNames = (x.rakutenGenreNames || []).length > 0;

  // idsもnamesも揃ってるならスキップ（＝空namesは埋め直す）
  if (hasIds && hasNames) continue;

  await sleep(220);

  let it = null;
  try {
    const p = await fetchJson(buildUrl(x.isbn13));
    it = pickItem(p);
  } catch {
    miss++;
    continue;
  }
  if (!it) { miss++; continue; }

  const ids = splitPath(it.booksGenreId);
  const names = splitPath(it.booksGenreName);

  if (ids.length || names.length) {
    x.rakutenGenreIds = ids;
    x.rakutenGenreNames = names;
    if (hasIds || hasNames) updated++; else tagged++;
  } else {
    miss++;
  }
}

await fs.writeFile(path, JSON.stringify(items, null, 2));
console.log(`rakuten_tags: tagged=${tagged} updated=${updated} miss=${miss}`);
