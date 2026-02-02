import fs from "node:fs/promises";

const APP = process.env.RAKUTEN_APP_ID;
if (!APP) throw new Error("missing RAKUTEN_APP_ID");

const j = (u) =>
  fetch(u).then(async (r) =>
    r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}\n${(await r.text()).slice(0, 200)}`))
  );

const norm = (s) =>
  (s || "")
    .toLowerCase()
    .replace(/[【】\[\]（）()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

function volumeHintFromTitle(title) {
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

async function rakutenSearch({ title, keyword, sort, page }) {
  const base =
    "https://app.rakuten.co.jp/services/api/BooksBook/Search/20170404" +
    `?format=json&formatVersion=2&applicationId=${encodeURIComponent(APP)}` +
    `&booksGenreId=001001&hits=30&page=${page || 1}` +
    (sort ? `&sort=${encodeURIComponent(sort)}` : "") +
    `&elements=title,author,publisherName,isbn,itemUrl,largeImageUrl,salesDate`;

  const url =
    base +
    (title ? `&title=${encodeURIComponent(title)}` : "") +
    (keyword ? `&keyword=${encodeURIComponent(keyword)}` : "");

  const r = await j(url);
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
  let best = null;

  for (const it of list) {
    const title = it.title || "";
    const wk = parentWorkKey(title);
    if (!wk) continue;

    // 親キー一致（完全一致 > 部分一致）
    const ok = wk === t || wk.includes(t) || t.includes(wk);
    if (!ok) continue;

    const v = volumeHintFromTitle(title);
    const score = (wk === t ? 1000 : 100) + (v === 1 ? 800 : Number.isFinite(v) ? 400 - v : 0);

    if (!best || score > best.score) best = { it, v, score };
  }
  return best;
}

async function findVol1Candidate(wk) {
  const titleKey = wk; // workKeyは既に正規化されてる想定
  const tries = [
    // ① titleで「wk 1」優先
    { title: `${titleKey} 1`, sort: "standard", page: 1 },
    { title: `${titleKey} 1`, sort: "standard", page: 2 },

    // ② titleで wk（古い巻が上に来やすい並び）
    { title: titleKey, sort: "+releaseDate", page: 1 },
    { title: titleKey, sort: "+releaseDate", page: 2 },

    // ③ keywordにフォールバック（保険）
    { keyword: `${titleKey} 1`, sort: "standard", page: 1 },
    { keyword: `${titleKey} 1`, sort: "standard", page: 2 },
    { keyword: titleKey, sort: "+releaseDate", page: 1 },
    { keyword: titleKey, sort: "+releaseDate", page: 2 },
  ];

  for (const q of tries) {
    const list = await rakutenSearch(q);
    const best = pickBest(wk, list);
    if (best) return best;
  }
  return null;
}

const path = "data/manga/items_master.json";
const items = JSON.parse(await fs.readFile(path, "utf8"));

// 既存アイテムにvolumeHintが無ければ補完（rep選定の精度を上げる）
for (const x of items) {
  if (!Number.isFinite(x.volumeHint)) {
    const v = volumeHintFromTitle(x.title);
    if (Number.isFinite(v)) x.volumeHint = v;
  }
}

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

  const best = await findVol1Candidate(wk);
  if (!best) continue;
  backfilled++;

  const it = best.it;
  const isbn = it.isbn || null;
  if (!isbn) continue;

  // 既に同ISBNがあるなら昇格（main/vol1扱い）
  if (byIsbn.has(isbn)) {
    const ex = items.find((x) => x.isbn13 === isbn);
    if (ex) {
      ex.workKey = wk;
      ex.seriesType = "main";
      ex.volumeHint = 1; // ①巻候補として扱う（repを確実に寄せる）
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

// 代表付け替え：main&vol1があれば必ずそれを_repにする
const byWork2 = new Map();
for (const x of items) {
  x._rep = false;
  const k = x.workKey || x.title;
  const g = byWork2.get(k) || [];
  g.push(x);
  byWork2.set(k, g);
}

function pickRep(group) {
  // 1) mainの①巻があれば最優先
  const v1 = group.find((x) => x.seriesType === "main" && x.volumeHint === 1);
  if (v1) return v1;

  // 2) mainの最小巻
  const main = group.filter((x) => x.seriesType === "main");
  const pool = main.length ? main : group;

  const withVol = pool
    .filter((x) => Number.isFinite(x.volumeHint))
    .sort((a, b) => a.volumeHint - b.volumeHint);

  return withVol[0] || pool[0];
}

for (const [, g] of byWork2) pickRep(g)._rep = true;

await fs.writeFile(path, JSON.stringify(items, null, 2));

console.log(
  `works=${byWork2.size} items=${items.length} rep=${items.filter((x) => x._rep).length} desc=${items.filter((x) => x.description).length} backfilled=${backfilled} added=${added} promoted=${promoted}`
);
