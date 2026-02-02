import fs from "node:fs/promises";

const APP = process.env.RAKUTEN_APP_ID;
if (!APP) throw new Error("RAKUTEN_APP_ID is missing");

const j = (u) => fetch(u).then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)));

const GENRE_URL = `https://app.rakuten.co.jp/services/api/BooksGenre/Search/20121128?format=json&formatVersion=2&applicationId=${APP}&booksGenreId=001`;
const SEARCH = (gid, page) =>
  `https://app.rakuten.co.jp/services/api/BooksBook/Search/20170404?format=json&formatVersion=2&applicationId=${APP}&booksGenreId=${gid}&size=9&sort=sales&hits=30&page=${page}&elements=title,author,publisherName,isbn,itemUrl,largeImageUrl,salesDate,reviewCount`;

const genre = await j(GENRE_URL); // docs: BooksGenre/Search  [oai_citation:0‡webservice.rakuten.co.jp](https://webservice.rakuten.co.jp/documentation/books-genre-search)
const children = genre?.children || [];
const manga = children.find(x => (x.booksGenreName || "").includes("漫画"))?.booksGenreId || "001001";

const pages = 3; // まずは少なめ（90件）で取得できるか検証
let items = [];
for (let p = 1; p <= pages; p++) {
  const res = await j(SEARCH(manga, p)); // docs: BooksBook/Search  [oai_citation:1‡webservice.rakuten.co.jp](https://webservice.rakuten.co.jp/documentation/books-book-search)
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
await fs.writeFile("data/manga/candidates.json", JSON.stringify({ genreId: manga, count: out.length, items: out }, null, 2));

console.log(`genreId=${manga} items=${out.length}`);
