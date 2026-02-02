import fs from "node:fs/promises";

const cand = JSON.parse(await fs.readFile("data/manga/candidates.json", "utf8"));
const items = (cand.items || []).slice(0, 30);

const j = (u) => fetch(u).then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)));

const pick = (r) => r?.items?.[0]?.volumeInfo || null;
const descOf = (v) => v?.description || "";

async function byIsbn(isbn) {
  const u = `https://www.googleapis.com/books/v1/volumes?q=isbn:${encodeURIComponent(isbn)}&maxResults=1`;
  return pick(await j(u));
}

async function byTitle(title, author) {
  const q = [title, author].filter(Boolean).join(" ");
  const u = `https://www.googleapis.com/books/v1/volumes?q=intitle:${encodeURIComponent(q)}&maxResults=1`;
  return pick(await j(u));
}

let descCount = 0;
const out = [];

for (const x of items) {
  const isbn = x.isbn || null;

  let v = null;
  if (isbn) v = await byIsbn(isbn);
  if (!descOf(v)) v = await byTitle(x.title, x.author);

  const desc = descOf(v);
  if (desc) descCount++;

  out.push({
    title: x.title,
    author: x.author || v?.authors?.[0] || null,
    publisher: x.publisher || v?.publisher || null,
    isbn13: isbn,
    asin: null,
    publishedAt: x.salesDate || v?.publishedDate || null,
    description: desc || null,
    image: x.image || v?.imageLinks?.thumbnail || null,
    source: "rakuten+googlebooks",
  });
}

await fs.writeFile("data/manga/items_master.json", JSON.stringify(out, null, 2));
console.log(`items_master=${out.length} (desc ${descCount})`);
