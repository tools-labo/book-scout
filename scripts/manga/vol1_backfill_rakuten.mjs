import fs from "node:fs/promises";

const APP = process.env.RAKUTEN_APP_ID;
if (!APP) throw new Error("missing RAKUTEN_APP_ID");

const j = (u) => fetch(u).then(r => r.ok ? r.json() : r.text().then(t => { throw new Error(`HTTP ${r.status}\n${t.slice(0,200)}`); }));

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

async function rakutenSearch(keyword) {
  const u =
    "https://app.rakuten.co.jp/services/api/BooksBook/Search/20170404" +
    `?format=json&formatVersion=2&applicationId=${encodeURIComponent(APP)}` +
    `&booksGenreId=001001&hits=20&keyword=${encodeURIComponent(keyword)}` +
    `&elements=title,author,publisherName,isbn,itemUrl,largeImageUrl,salesDate`;
  const r = await j(u);
  const items = r?.Items || [];
  return items.map(x => x?.Item || x).filter(Boolean);
}

async function googleDesc(isbn) {
  const u = `https://www.googleapis.com/books/v1/volumes?q=isbn:${encodeURIComponent(isbn)}&maxResults=1`;
  const r = await j(u);
  const v = r?.items?.[0]?.volumeInfo;
  return v?.description || null;
}

function pickBest(targetWK, list) {
  const t = norm(targetWK);
  const scored = [];
  for (const it of list) {
    const title = it.title || "";
    const wk = parentWorkKey(title);
    if (!wk) continue;
    // 親キー一致を優先（完全一致＞部分一致）
    if (!(wk === t || wk.includes(t) || t.includes(wk))) continue;

    const v = volumeHint(title);
    const score =
      (wk === t ? 1000 : 100) +
      (v === 1 ? 500 : (Number.isFinite(v) ? (200 - v) : 0));
    scored.push({ it, v, score });
  }
  scored.sort((a,b)=>b.score-a.score);
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

const byIsbn = new Set(items.map(x => x.isbn13).filter(Boolean));

let added = 0;
let backfilled = 0;

for (const [wk, group] of byWork) {
  const main = group.filter(x => x.seriesType === "main");
  if (main.some(x => x.volumeHint === 1)) continue; // 既に①巻あり

  // 1) まず「作品名 + 1」で探す
  let best = pickBest(wk, await rakutenSearch(`${wk} 1`));

  // 2) ダメなら「作品名だけ」で探す（最小巻に寄せる）
  if (!best) best = pickBest(wk, await rakutenSearch(wk));
  if (!best) continue;

  const it = best.it;
  const isbn = it.isbn || null;
  if (!isbn) continue;

  backfilled++;

  // 既に同ISBNが居るなら追加しない（代表選定だけでOK）
  if (byIsbn.has(isbn)) continue;

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
    volumeHint: best.v || 1
  });

  byIsbn.add(isbn);
  added++;
}

// 代表を作り直す：main優先→巻数最小→先頭
const byWork2 = new Map();
for (const x of items) {
  x._rep = false;
  const k = x.workKey || x.title;
  const g = byWork2.get(k) || [];
  g.push(x);
  byWork2.set(k, g);
}

function pickRep(group) {
  const main = group.filter(x => x.seriesType === "main");
  const pool = main.length ? main : group;
  const withVol = pool.filter(x => Number.isFinite(x.volumeHint)).sort((a,b)=>a.volumeHint-b.volumeHint);
  return withVol[0] || pool[0];
}

for (const [wk, g] of byWork2) {
  pickRep(g)._rep = true;
}

await fs.writeFile(path, JSON.stringify(items, null, 2));

const works = [...byWork2.keys()].length;
const desc = items.filter(x => x.description).length;
const rep = items.filter(x => x._rep).length;
console.log(`works=${works} items=${items.length} rep=${rep} desc=${desc} backfilled=${backfilled} added=${added}`);
