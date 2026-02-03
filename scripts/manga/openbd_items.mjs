import fs from "node:fs/promises";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), 15000); // 15s timeout
    try {
      const r = await fetch(url, { cache: "no-store", signal: ac.signal });
      clearTimeout(to);

      if (r.ok) return await r.json();

      const body = await r.text().catch(() => "");
      // 429/5xx は短くリトライ（長い待ちはしない）
      if ((r.status === 429 || r.status >= 500) && i < tries - 1) {
        await sleep(800 + i * 600); // 0.8s, 1.4s
        continue;
      }
      throw new Error(`HTTP ${r.status}\nBODY: ${body.slice(0, 120)}`);
    } catch (e) {
      clearTimeout(to);
      // Abort/Network も短くリトライ
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

function classifySeriesType(title) {
  const t = norm(title);
  if (/(color\s*walk|カラー\s*ウォーク|カラーウォーク|画集|イラスト|art\s*book|visual|ビジュアル|原画|設定資料)/i.test(t)) return "art";
  if (/(公式|ガイド|guide|ファンブック|キャラクター|データブック|ムック|解説|大全|book\s*guide)/i.test(t)) return "guide";
  if (/(スピンオフ|spinoff|episode|外伝|番外編|短編集|アンソロジー)/i.test(t)) return "spinoff";
  return "main";
}

async function googleByIsbn(isbn) {
  const u = `https://www.googleapis.com/books/v1/volumes?q=isbn:${encodeURIComponent(isbn)}&maxResults=1`;
  const r = await fetchJson(u);
  return r?.items?.[0]?.volumeInfo || null;
}

function repPick(group) {
  const v1 = group.find((x) => x.seriesType === "main" && x.volumeHint === 1);
  if (v1) return v1;
  const main = group.filter((x) => x.seriesType === "main");
  const pool = main.length ? main : group;
  const withVol = pool
    .filter((x) => Number.isFinite(x.volumeHint))
    .sort((a, b) => a.volumeHint - b.volumeHint);
  return withVol[0] || pool[0];
}

// ---- main ----
const N = Number(process.env.ITEMS_MASTER || 30);

const candRaw = JSON.parse(await fs.readFile("data/manga/candidates.json", "utf8"));
const candList = Array.isArray(candRaw) ? candRaw : candRaw.items || candRaw.Items || [];
const src = candList.slice(0, N);

// 既存を引き継ぐ（asin/amazonUrl）
let prev = [];
try { prev = JSON.parse(await fs.readFile("data/manga/items_master.json", "utf8")); } catch {}
const prevByIsbn = new Map(prev.map((x) => [x.isbn13, x]).filter(([k]) => k));

const items = [];
let descCount = 0;

for (let i = 0; i < src.length; i++) {
  const x = src[i];
  const isbn = x.isbn || x.isbn13 || null;
  if (!isbn) continue;

  const prevHit = prevByIsbn.get(isbn) || {};
  console.log(`[openbd_items] ${i + 1}/${src.length} isbn=${isbn} title=${String(x.title || "").slice(0, 40)}`);

  let v = null;
  try {
    v = await googleByIsbn(isbn);
  } catch (e) {
    console.log(`[openbd_items]   skip (fetch failed): ${String(e?.message || e).slice(0, 80)}`);
    v = null;
  }

  await sleep(120); // 呼び出し間隔を少し空ける

  const description = v?.description || null;
  if (description) descCount++;

  items.push({
    workKey: parentWorkKey(x.title || ""),
    seriesType: classifySeriesType(x.title || ""),
    title: x.title || null,
    author: x.author || v?.authors?.[0] || null,
    publisher: x.publisherName || x.publisher || v?.publisher || null,
    isbn13: isbn,
    asin: prevHit.asin || null,
    amazonUrl: prevHit.amazonUrl || null,
    publishedAt: x.salesDate || v?.publishedDate || null,
    description,
    image: x.largeImageUrl || x.image || v?.imageLinks?.thumbnail || null,
    volumeHint: Number.isFinite(x.volumeHint) ? x.volumeHint : volumeHint(x.title || ""),
    _rep: false,
  });
}

// rep付与
const byWork = new Map();
for (const it of items) {
  const k = it.workKey || it.title;
  const g = byWork.get(k) || [];
  g.push(it);
  byWork.set(k, g);
}
for (const [, g] of byWork) repPick(g)._rep = true;

await fs.writeFile("data/manga/items_master.json", JSON.stringify(items, null, 2));

const works = items.filter((x) => x._rep).length;
const amazon = items.filter((x) => x.asin || x.amazonUrl).length;
console.log(`items=${items.length} works=${works} desc=${descCount} amazon=${amazon}`);
