import fs from "node:fs/promises";

const cand = JSON.parse(await fs.readFile("data/manga/candidates.json", "utf8"));
const src = (cand.items || []).slice(0, 30);

const j = (u) => fetch(u).then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)));
const pick1 = (r) => r?.items?.[0]?.volumeInfo || null;

const norm = (s) => (s || "")
  .toLowerCase()
  .replace(/[【】\[\]（）()]/g, " ")
  .replace(/\s+/g, " ")
  .trim();

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

// 親（本編の核）を作る：系列語以降を切り落として同じ親に寄せる
function parentWorkKey(title) {
  const b = baseTitle(title);
  const cut = b.split(/\b(episode|spinoff)\b|外伝|番外編|スピンオフ|公式|ガイド|guide|画集|ファンブック|データブック|ムック|カラーウォーク|color walk/i)[0];
  return norm(cut || b);
}

// 固定カテゴリ（増やさない前提）
function classifySeriesType(title) {
  const t = norm(title);
  if (/(color\s*walk|カラー\s*ウォーク|カラーウォーク|画集|イラスト|art\s*book|visual|ビジュアル|原画|設定資料)/i.test(t)) return "art";
  if (/(公式|ガイド|guide|ファンブック|キャラクター|データブック|ムック|解説|大全|book\s*guide)/i.test(t)) return "guide";
  if (/(スピンオフ|spinoff|episode|外伝|番外編|短編集|アンソロジー|公式アンソロジー)/i.test(t)) return "spinoff";
  return "main";
}

async function byIsbn(isbn) {
  const u = `https://www.googleapis.com/books/v1/volumes?q=isbn:${encodeURIComponent(isbn)}&maxResults=1`;
  return pick1(await j(u));
}
async function byTitle(title, author) {
  const q = [title, author].filter(Boolean).join(" ");
  const u = `https://www.googleapis.com/books/v1/volumes?q=intitle:${encodeURIComponent(q)}&maxResults=1`;
  return pick1(await j(u));
}

// overrides（無ければ空）
let overrides = {};
try { overrides = JSON.parse(await fs.readFile("data/overrides.json", "utf8")); } catch {}
const ovIsbn = overrides.byIsbn || {};
const ovAsin = overrides.byAsin || {};
const ovHide = overrides.hide || {};

// 既存items_masterからASIN/amazonUrlを引き継ぐ（消失防止）
let prev = [];
try { prev = JSON.parse(await fs.readFile("data/manga/items_master.json", "utf8")); } catch {}
const prevByIsbn = new Map(prev.map(x => [x.isbn13, x]).filter(([k]) => k));

// items生成（親子分類つき）
const items = [];
for (const x of src) {
  const isbn = x.isbn || null;
  if (!isbn) continue;

  const o = ovIsbn[isbn] || {};
  if (ovHide[isbn]) continue;

  let v = await byIsbn(isbn);
  if (!v?.description) v = await byTitle(x.title, x.author);

  const prevHit = prevByIsbn.get(isbn) || {};

  const rec = {
    workKey: o.workKey || parentWorkKey(x.title),
    seriesType: o.seriesType || classifySeriesType(x.title),
    title: x.title,
    author: x.author || v?.authors?.[0] || null,
    publisher: x.publisher || v?.publisher || null,
    isbn13: isbn,
    asin: o.asin || prevHit.asin || null,
    amazonUrl: o.amazonUrl || prevHit.amazonUrl || null,
    publishedAt: x.salesDate || v?.publishedDate || null,
    description: v?.description || null,
    image: x.image || v?.imageLinks?.thumbnail || null,
    volumeHint: (o.forceVolume ?? volumeHint(x.title)) || null,
  };

  items.push(rec);
}

// ASIN側override（必要なら）
for (const it of items) {
  const o = it.asin ? (ovAsin[it.asin] || {}) : {};
  if (o.workKey) it.workKey = o.workKey;
  if (o.seriesType) it.seriesType = o.seriesType;
  if (o.forceVolume != null) it.volumeHint = o.forceVolume;
  if (o.asin) it.asin = o.asin;
  if (o.amazonUrl) it.amazonUrl = o.amazonUrl;
  if (it.asin && ovHide[it.asin]) it._hide = true;
}
const items2 = items.filter(x => !x._hide);

// 親ごとの代表を _rep=true にする（main優先→巻1→最古）
function pickRep(group) {
  const main = group.filter(x => x.seriesType === "main");
  const pool = main.length ? main : group;

  const v1 = pool.find(x => x.volumeHint === 1);
  if (v1) return v1;

  const dated = pool.filter(x => x.publishedAt).sort((a,b) => (a.publishedAt > b.publishedAt ? 1 : -1));
  return dated[0] || pool[0];
}

const byWork = new Map();
for (const it of items2) {
  const k = it.workKey || it.title;
  const g = byWork.get(k) || [];
  g.push(it);
  byWork.set(k, g);
}

for (const [wk, g] of byWork) {
  const rep = pickRep(g);
  rep._rep = true;
}

await fs.writeFile("data/manga/items_master.json", JSON.stringify(items2, null, 2));

const works = items2.filter(x => x._rep).length;
const desc = items2.filter(x => x.description).length;
const asin = items2.filter(x => x.asin || x.amazonUrl).length;
console.log(`items=${items2.length} works=${works} desc=${desc} amazon=${asin}`);
