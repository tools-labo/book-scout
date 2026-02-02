import fs from "node:fs/promises";

const cand = JSON.parse(await fs.readFile("data/manga/candidates.json", "utf8"));
const src = (cand.items || []).slice(0, 30);

const j = (u) => fetch(u).then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)));
const pick = (r) => r?.items?.[0]?.volumeInfo || null;

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

// 固定カテゴリ（増やさない前提）
function classifySeriesType(title) {
  const t = norm(title);
  if (/(color\s*walk|カラー\s*ウォーク|カラーウォーク|画集|イラスト|art\s*book|visual|ビジュアル|原画|設定資料)/i.test(t)) return "art";
  if (/(公式|ガイド|guide|ファンブック|キャラクター|データブック|ムック|解説|大全|book\s*guide)/i.test(t)) return "guide";
  if (/(スピンオフ|spinoff|外伝|番外編|短編集|アンソロジー|公式アンソロジー)/i.test(t)) return "spinoff";
  return "main";
}

async function byIsbn(isbn) {
  const u = `https://www.googleapis.com/books/v1/volumes?q=isbn:${encodeURIComponent(isbn)}&maxResults=1`;
  return pick(await j(u));
}
async function byTitle(title, author) {
  const q = [title, author].filter(Boolean).join(" ");
  const u = `https://www.googleapis.com/books/v1/volumes?q=intitle:${encodeURIComponent(q)}&maxResults=1`;
  return pick(await j(u));
}

// overrides（無ければ空）
let overrides = {};
try { overrides = JSON.parse(await fs.readFile("data/overrides.json", "utf8")); } catch {}
const ovIsbn = overrides.byIsbn || {};
const ovAsin = overrides.byAsin || {};
const ovHide = overrides.hide || {};

// 既存items_masterからASIN/amazonUrlを引き継ぐ（重要）
let prev = [];
try { prev = JSON.parse(await fs.readFile("data/manga/items_master.json", "utf8")); } catch {}
const prevByIsbn = new Map(prev.map(x => [x.isbn13, x]).filter(([k]) => k));

const items = [];
for (const x of src) {
  const isbn = x.isbn || null;
  if (!isbn) continue;

  let v = await byIsbn(isbn);
  if (!v?.description) v = await byTitle(x.title, x.author);

  const prevHit = prevByIsbn.get(isbn) || {};
  const o = ovIsbn[isbn] || {};

  const workKey = o.workKey || baseTitle(x.title);
  const seriesType = o.seriesType || classifySeriesType(x.title);
  if (ovHide[isbn]) continue;

  items.push({
    workKey,
    seriesType,
    title: x.title,
    author: x.author || v?.authors?.[0] || null,
    publisher: x.publisher || v?.publisher || null,
    isbn13: isbn,
    asin: o.asin || prevHit.asin || null,
    amazonUrl: o.amazonUrl || prevHit.amazonUrl || null,
    publishedAt: x.salesDate || v?.publishedDate || null,
    description: v?.description || null,
    image: x.image || v?.imageLinks?.thumbnail || null,
    volumeHint: o.forceVolume ?? volumeHint(x.title),
  });
}

// workKey単位の代表（main優先 → 巻1 → 最古）
function pickRep(arr) {
  const main = arr.filter(x => x.seriesType === "main");
  const pool = main.length ? main : arr;

  const v1 = pool.find(x => x.volumeHint === 1);
  if (v1) return v1;

  const dated = pool.filter(x => x.publishedAt).sort((a,b) => (a.publishedAt > b.publishedAt ? 1 : -1));
  return dated[0] || pool[0];
}

// workKeyごとの集計（Bの保持情報）
const byWork = new Map();
for (const it of items) {
  const o = ovAsin[it.asin] || {};
  if (o.workKey) it.workKey = o.workKey;
  if (o.seriesType) it.seriesType = o.seriesType;
  if (o.forceVolume != null) it.volumeHint = o.forceVolume;
  if (o.asin) it.asin = o.asin;
  if (o.amazonUrl) it.amazonUrl = o.amazonUrl;
  if (ovHide[it.asin]) continue;

  const g = byWork.get(it.workKey) || { items: [], latestVolumeHint: 0, latestPublishedAt: null };
  g.items.push(it);
  g.latestVolumeHint = Math.max(g.latestVolumeHint, it.volumeHint || 0);
  g.latestPublishedAt = [g.latestPublishedAt, it.publishedAt].filter(Boolean).sort().slice(-1)[0] || g.latestPublishedAt;
  byWork.set(it.workKey, g);
}

// 代表のみリスト用に rep=true を付ける（フロント側で親一覧を作りやすく）
for (const [wk, g] of byWork) {
  const rep = pickRep(g.items);
  rep._rep = true;
  for (const it of g.items) {
    it.latestVolumeHint = g.latestVolumeHint || null;
    it.latestPublishedAt = g.latestPublishedAt || null;
  }
}

await fs.writeFile("data/manga/items_master.json", JSON.stringify(items, null, 2));
const repCount = items.filter(x => x._rep).length;
const descCount = items.filter(x => x.description).length;
console.log(`items=${items.length} works=${repCount} desc=${descCount}`);
