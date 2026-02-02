import fs from "node:fs/promises";

const cand = JSON.parse(await fs.readFile("data/manga/candidates.json", "utf8"));
const items = (cand.items || []).slice(0, 30);

const j = (u) => fetch(u).then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)));

async function gdesc(isbn) {
  const u = `https://www.googleapis.com/books/v1/volumes?q=isbn:${encodeURIComponent(isbn)}&maxResults=1`;
  const r = await j(u);
  return r?.items?.[0]?.volumeInfo?.description || "";
}

const out = [];
let descCount = 0;

for (const x of items) {
  const isbn = x.isbn;
  let desc = "";

  if (isbn) desc = await gdesc(isbn);
  if (desc) descCount++;

  out.push({
    title: x.title,
    author: x.author || null,
    publisher: x.publisher || null,
    isbn13: isbn || null,
    asin: null,
    publishedAt: x.salesDate || null,
    description: desc || null,
    image: x.image || null,
    source: "rakuten+googlebooks",
  });
}

await fs.writeFile("data/manga/items_master.json", JSON.stringify(out, null, 2));
console.log(`items_master=${out.length} (desc ${descCount})`);
