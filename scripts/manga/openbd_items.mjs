import fs from "node:fs/promises";

const cand = JSON.parse(await fs.readFile("data/manga/candidates.json", "utf8"));
const items = cand.items || [];

const isbns = [...new Set(items.map(x => x.isbn).filter(Boolean))].slice(0, 30);
if (isbns.length === 0) throw new Error("no isbn");

const url = "https://api.openbd.jp/v1/get?isbn=" + encodeURIComponent(isbns.join(","));
const res = await fetch(url).then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)));

const byIsbn = new Map();
isbns.forEach((isbn, i) => byIsbn.set(isbn, res[i] || null));

const out = items
  .filter(x => x.isbn)
  .slice(0, 30)
  .map(x => {
    const ob = byIsbn.get(x.isbn);
    const summary =
      ob?.summary?.description ||
      ob?.onix?.CollateralDetail?.TextContent?.find(t => t.TextType === "03")?.Text ||
      "";
    const pub =
      x.publisher ||
      ob?.summary?.publisher ||
      "";
    const author =
      x.author ||
      ob?.summary?.author ||
      "";
    return {
      title: x.title,
      author,
      publisher: pub,
      isbn13: x.isbn,
      asin: null,
      publishedAt: x.salesDate || null,
      description: summary || null,
      image: x.image || null,
      source: "rakuten+openbd",
    };
  });

await fs.writeFile("data/manga/items_master.json", JSON.stringify(out, null, 2));
console.log(`items_master=${out.length} (desc ${out.filter(x => x.description).length})`);
