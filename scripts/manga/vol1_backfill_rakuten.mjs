import fs from "node:fs/promises";

const APP = process.env.RAKUTEN_APP_ID;
if (!APP) throw new Error("missing RAKUTEN_APP_ID");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), 15000);
    try {
      const r = await fetch(url, { cache: "no-store", signal: ac.signal });
      clearTimeout(to);
      if (r.ok) return await r.json();
      if ((r.status === 429 || r.status >= 500) && i < tries - 1) {
        await sleep(800 + i * 600);
        continue;
      }
      const t = await r.text().catch(() => "");
      throw new Error(`HTTP ${r.status}\n${t.slice(0, 200)}`);
    } catch (e) {
      clearTimeout(to);
      if (i < tries - 1) {
        await sleep(800 + i * 600);
        continue;
      }
      throw e;
    }
  }
  return null;
}

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
    `&elements=title,author,publisherName,isbn,itemUrl,largeImageUrl,salesDate,itemCaption`;

  const url =
    base +
    (title ? `&title=${encodeURIComponent(title)}` : "") +
    (keyword ? `&keyword=${encodeURIComponent(keyword)}` : "");

  const r = await fetchJson(url);
  const items = r?.Items || [];
  return items.map((x) => x?.Item || x).filter(Boolean);
}

function pickBest(targetWK, list) {
  const t = norm(targetWK);
  let best = null;

  for (const it of list) {
    const title = it.title || "";
    const wk = parentWorkKey(title);
    if (!wk) continue;

    const ok = wk === t || wk.includes(t) || t.includes(wk);
    if (!ok) continue;

    const v = volumeHintFromTitle(title);
    const score = (wk === t ? 1000 : 100) + (v === 1 ? 800 : Number.isFinite(v) ? 400 - v : 0);

    if (!best || score > best.score) best = { it, v, score };
  }
  return best;
}

async function findVol1Candidate(wk) {
  const titleKey = wk;
  const tries = [
    { title: `${titleKey} 1`, sort: "standard", page: 1 },
    { title: `${titleKey} 1`, sort: "standard", page: 2 },
    { title: titleKey, sort: "+releaseDate", page: 1 },
    { title: titleKey, sort: "+releaseDate", page: 2 },
    { keyword: `${titleKey} 1`, sort: "standard", page: 1 },
    { keyword: `${titleKey} 1`, sort: "standard", page: 2 },
  ];

  for (const q of tries) {
    const list = await rakutenSearch(q);
    const best = pickBest(wk, list);
    if (best) return best;
    await sleep(120);
  }
  return null;
}

function pickRep(group) {
  const v1 = group.find((x) => x.seriesType === "main" && x.volumeHint === 1);
  if (v1) return v1;
  const main = group.filter((x) => x.seriesType === "main");
  const pool = main.length ? main : group;
  const withVol = pool
    .filter((x) => Number.isFinite(x.volumeHint))
    .sort((a, b) => a.volumeHint - b.volumeHint);
  return withVol[0] || pool[0];
}

const path = "data/manga/items_master.json";
const items = JSON.parse(await fs.readFile(path, "utf8"));

// volumeHintが空なら補完
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

  // 既にあれば昇格
  if (byIsbn.has(isbn)) {
    const ex = items.find((x) => x.isbn13 === isbn);
    if (ex) {
      ex.workKey = wk;
      ex.seriesType = "main";
      ex.volumeHint = 1;
      if (!ex.description && it.itemCaption) ex.description = it.itemCaption;
      if (!ex.image && it.largeImageUrl) ex.image = it.largeImageUrl;
      promoted++;
    }
    continue;
  }

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
    description: it.itemCaption || null,
    image: it.largeImageUrl || null,
    volumeHint: best.v || 1,
    _rep: false,
  });

  byIsbn.add(isbn);
  added++;
}

// rep 付け替え
const byWork2 = new Map();
for (const x of items) {
  x._rep = false;
  const k = x.workKey || x.title;
  const g = byWork2.get(k) || [];
  g.push(x);
  byWork2.set(k, g);
}
for (const [, g] of byWork2) pickRep(g)._rep = true;

await fs.writeFile(path, JSON.stringify(items, null, 2));

console.log(
  `works=${byWork2.size} items=${items.length} rep=${items.filter((x) => x._rep).length} desc=${items.filter((x) => x.description).length} backfilled=${backfilled} added=${added} promoted=${promoted}`
);
