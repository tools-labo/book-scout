import fs from "node:fs/promises";

const APP_ID = process.env.RAKUTEN_APP_ID;
if (!APP_ID) throw new Error("missing RAKUTEN_APP_ID secret");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url, tries = 4) {
  for (let i = 0; i < tries; i++) {
    const r = await fetch(url, { headers: { "user-agent": "book-scout/1.0" } });
    const t = await r.text();
    if (r.ok) return JSON.parse(t);
    // 429は待って再試行
    if (r.status === 429 && i < tries - 1) {
      await sleep(1500 * (i + 1));
      continue;
    }
    throw new Error(`HTTP ${r.status}\nURL: ${url}\nBODY: ${t.slice(0, 200)}`);
  }
}

function pickItem(payload) {
  const arr = payload?.Items || payload?.items || [];
  if (!arr.length) return null;
  const x = arr[0];
  return x?.Item || x; // formatVersion差分吸収
}

function splitMaybe(s) {
  const v = (s ?? "").trim();
  if (!v) return [];
  return v.split("/").map((x) => x.trim()).filter(Boolean);
}

function buildUrl(isbn13, useIsbnjan = true) {
  const u = new URL("https://app.rakuten.co.jp/services/api/BooksBook/Search/20170404");
  u.searchParams.set("format", "json");
  u.searchParams.set("formatVersion", "2");
  u.searchParams.set("applicationId", APP_ID);
  u.searchParams.set("hits", "1");
  u.searchParams.set("elements", "title,isbn,booksGenreId,booksGenreName");
  u.searchParams.set(useIsbnjan ? "isbnjan" : "isbn", String(isbn13));
  return u.toString();
}

async function byIsbn(isbn13) {
  // まず isbnjan、ダメなら isbn も試す（環境差の保険）
  try {
    const p = await fetchJson(buildUrl(isbn13, true));
    const it = pickItem(p);
    if (it) return it;
  } catch (_) {}
  const p2 = await fetchJson(buildUrl(isbn13, false));
  return pickItem(p2);
}

const path = "data/manga/items_master.json";
const items = JSON.parse(await fs.readFile(path, "utf8"));

let tagged = 0, miss = 0;
for (const x of items) {
  if (!x?.isbn13) continue;
  if (x.rakutenGenreIds?.length) continue;

  // 連打回避（楽天側も優しめに）
  await sleep(220);

  let it = null;
  try {
    it = await byIsbn(x.isbn13);
  } catch (e) {
    // 失敗してもビルド全体は止めない（後で埋まる）
    miss++;
    continue;
  }

  const ids = splitMaybe(it?.booksGenreId);
  const names = splitMaybe(it?.booksGenreName);

  if (ids.length || names.length) {
    x.rakutenGenreIds = ids;
    x.rakutenGenreNames = names;
    tagged++;
  } else {
    miss++;
  }
}

await fs.writeFile(path, JSON.stringify(items, null, 2));
console.log(`rakuten_tags: tagged=${tagged} miss=${miss}`);
