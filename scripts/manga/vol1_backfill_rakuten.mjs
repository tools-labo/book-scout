import fs from "node:fs/promises";

const APP = process.env.RAKUTEN_APP_ID;
if (!APP) throw new Error("missing RAKUTEN_APP_ID");

const j = (u) =>
  fetch(u).then(async (r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}\n${(await r.text()).slice(0, 200)}`))));

const norm = (s) => (s || "").toLowerCase().replace(/[【】\[\]（）()]/g, " ").replace(/\s+/g, " ").trim();

function volumeHint(title) {
  const t = title || "";
  const m =
    t.match(/[（(]\s*(\d+)\s*[）)]/) ||
    t.match(/第?\s*(\d+)\s*巻/) ||
    t.match(/\b(\d{1,3})\b/);
  return m ? Number(m[1]) : null;
}

function baseTitle(title) {
  return norm(title)
    .replace(/[（(]\s*\d+\s*[）)]/g, "")
    .replace(/第?\s*\d+\s*巻/g, "")
    .replace(/\b\d{1,3}\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parentWorkKey(title) {
  const b = baseTitle(title);
  const cut = b.split(
    /\b(episode|spinoff)\b|外伝|番外編|スピンオフ|公式|ガイド|guide|画集|ファンブック|データブック|ムック|カラーウォーク|color walk|モノクロ|完全版|新装版|愛蔵版|総集編/i
  )[0];
  return norm(cut || b);
}

async function rakutenSearch(keyword, sort) {
  const u =
    "https://app.rakuten.co.jp/services/api/BooksBook/Search/20170404" +
    `?format=json&formatVersion=2&applicationId=${encodeURIComponent(APP)}` +
    `&booksGenreId=001001&hits=30&keyword=${encodeURIComponent(keyword)}` +
    (sort ? `&sort=${encodeURIComponent(sort)}` : "") +
    `&elements=title,author,publisherName,isbn,itemUrl,largeImageUrl,salesDate`;
  const r = await j(u);
  const items = r?.Items || [];
  return items.map((x) => x?.Item || x).filter(Boolean);
}

async function googleDesc(isbn) {
  const u = `https://www.googleapis.com/books/v1/volumes?q=isbn:${encodeURIComponent(isbn)}&maxResults=1`;
  const r = await j(u);
  return r?.items?.[0]?.volumeInfo?.description || null;
}

function pickBest(targetWK, list) {
  const t = norm(targetWK);
  const scored = [];
  for (const it of list) {
    const title = it.title || "";
    const wk = parentWorkKey(title);
    if (!wk) continue;

    // 親キー一致（完全一致 > 部分一致）だけ通す
    const ok = wk === t || wk.includes(t) || t.includes(wk);
    if (!ok) continue;

    const v = volumeHint(title);
    // 巻1を最優先、次に巻が小さいほど良い
    const score = (wk === t ? 1000 : 100) + (v === 1 ? 800 : Number.isFinite(v) ? 400 - v : 0);
    scored.push({ it, v, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored[0] || null;
}

const path = "data/manga/items_master.json";
const items = JSON.parse(await fs.readFile(path, "utf8"));

const byWork = new Map();
for (const x of items) {
  const k = x.workKey || x.title;
  const g = byWork.get(k) || [];
  g.push(x);
  byWork.set(k, g);
}

const byIsbn = new Set(items.map((x) => x.isbn13).filter(Boolean));

let backfilled = 0;
let added = 0;
let promoted = 0;

for (const [wk, group] of byWork) {
  const main = group.filter((x) => x.seriesType === "main");
  if (main.some((x) => x.volumeHint === 1)) continue;

  // 1) 「作品名 + 1」(標準)
  let best = pickBest(wk, await rakutenSearch(`${wk} 1`, "standard"));

  // 2) ダメなら「作品名だけ」を “古い巻が出やすい” 並びで（※楽天のsort仕様に依存）
  if (!best) best = pickBest(wk, await rakutenSearch(wk, "+releaseDate"));

  if (!best) continue;
  backfilled++;

  const it = best.it;
  const isbn = it.isbn || null;
  if (!isbn) continue;

  // 既に同ISBNがあるなら“昇格”して代表を①巻に寄せる
  if (byIsbn.has(isbn)) {
    const ex = items.find((x) => x.isbn13 === isbn);
    if (ex) {
      ex.workKey = wk;
      ex.seriesType = "main";
      if (best.v === 1) ex.volumeHint = 1;
      promoted++;
    }
    continue;
  }

  const desc = await googleDesc(isbn);

  items.push({
    workKey: wk,
    seriesType: "main",
    title: it.title || null,
    author: it.author || null,
    publisher: it.publisherName || null,
    isbn13: isbn,
    asin: null,
    amazonUrl: null,
    publishedAt: it.salesDate || null,
    description: desc,
    image: it.largeImageUrl || null,
    volumeHint: best.v || 1,
  });

  byIsbn.add(isbn);
  added++;
}

// 代表作り直し：main優先→巻数最小→先頭
const byWork2 = new Map();
for (const x of items) {
  x._rep = false;
  const k = x.workKey || x.title;
  const g = byWork2.get(k) || [];
  g.push(x);
  byWork2.set(k, g);
}

function pickRep(group) {
  const main = group.filter((x) => x.seriesType === "main");
  const pool = main.length ? main : group;
  const withVol = pool.filter((x) => Number.isFinite(x.volumeHint)).sort((a, b) => a.volumeHint - b.volumeHint);
  return withVol[0] || pool[0];
}

for (const [wk, g] of byWork2) pickRep(g)._rep = true;

await fs.writeFile(path, JSON.stringify(items, null, 2));

console.log(
  `works=${byWork2.size} items=${items.length} rep=${items.filter((x) => x._rep).length} desc=${items.filter((x) => x.description).length} backfilled=${backfilled} added=${added} promoted=${promoted}`
);
