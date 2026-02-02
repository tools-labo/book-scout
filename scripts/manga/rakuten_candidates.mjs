import fs from "node:fs/promises";

const APP = process.env.RAKUTEN_APP_ID;
if (!APP) throw new Error("RAKUTEN_APP_ID is missing");

async function getJson(url) {
  const r = await fetch(url);
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`HTTP ${r.status}\nURL: ${url}\nBODY: ${t.slice(0, 200)}`);
  }
  return r.json();
}

// まずは固定：マンガ（楽天ブックスのジャンルID）
// ※ここが正しいか切り分けるため、API 1本で検証する
const MANGA_GENRE = "001001";

const url = (page) =>
  `https://app.rakuten.co.jp/services/api/BooksBook/Search/20170404` +
  `?format=json&formatVersion=2&applicationId=${APP}` +
  `&booksGenreId=${MANGA_GENRE}&hits=30&page=${page}` +
  `&sort=sales` +
  `&elements=title,author,publisherName,isbn,itemUrl,largeImageUrl,salesDate,reviewCount`;

const pages = 1; // まず1ページだけ（30件）で疎通確認
let items = [];
for (let p = 1; p <= pages; p++) {
  const res = await getJson(url(p));
  items.push(...(res.Items || []));
}

const out = items
  .map(x => ({
    source: "rakuten-books",
    title: x.title,
    author: x.author,
    publisher: x.publisherName,
    isbn: x.isbn,
    url: x.itemUrl,
    image: x.largeImageUrl,
    salesDate: x.salesDate,
    reviewCount: Number(x.reviewCount || 0),
  }))
  .filter(x => x.title && x.isbn);

await fs.mkdir("data/manga", { recursive: true });
await fs.writeFile(
  "data/manga/candidates.json",
  JSON.stringify({ genreId: MANGA_GENRE, count: out.length, items: out }, null, 2)
);

console.log(`genreId=${MANGA_GENRE} items=${out.length}`);
