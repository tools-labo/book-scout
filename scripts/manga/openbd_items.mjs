import fs from "node:fs/promises";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function j(url, tries = 6) {
  for (let i = 0; i < tries; i++) {
    const r = await fetch(url, { cache: "no-store" });
    if (r.ok) return await r.json();

    const body = await r.text().catch(() => "");
    const retryAfter = Number(r.headers.get("retry-after") || 0) * 1000;

    // 429 / 5xx は待って再試行
    if ((r.status === 429 || r.status >= 500) && i < tries - 1) {
      const backoff = 800 * (2 ** i); // 0.8s, 1.6s, 3.2s...
      const jitter = Math.floor(Math.random() * 300);
      await sleep(Math.max(retryAfter, backoff) + jitter);
      continue;
    }

    throw new Error(`HTTP ${r.status}\nURL: ${url}\nBODY: ${body.slice(0, 200)}`);
  }
  throw new Error(`HTTP 429 (exhausted retries)\nURL: ${url}`);
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

// 親（本編）寄せキー
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
  if (/(スピンオフ|spinoff|episode|外伝|番外編|短編集|アンソロジー|公式アンソロジー)/i.test(t)) return "spinoff";
  return "main";
}

async function googleByIsbn(isbn) {
  const u = `https://www.googleapis.com/books/v1/volumes?q=isbn:${encodeURIComponent(isbn)}&maxResults=1`;
  const r = await j(u);
  return r?.items?.[0]?.volumeInfo || null;
}

function repPick(group) {
  // 1) main&vol1 があれば必ずそれ
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

// ---------------------------
// main
// ---------------------------

const N = Number(process.env.ITEMS_MASTER || 30);

// candidates 読み込み（形が違っても耐える）
const candRaw = JSON.parse(await fs.readFile("data/manga/candidates.json", "utf8"));
const candList = Array.isArray(candRaw) ? candRaw : candRaw.items || candRaw.Items || [];
const src = candList.slice(0, N);

// 既存items_masterがあればASIN等を引き継ぐ
let prev = [];
try {
  prev = JSON.parse(await fs.readFile("data/manga/items_master.json", "utf8"));
} catch {}
const prevByIsbn = new Map(prev.map((x) => [x.isbn13, x]).filter(([k]) => k));

const items = [];
let descCount = 0;

// candidates → items（429対策で少し間隔を空ける）
for (const x of src) {
  const isbn = x.isbn || x.isbn13 || null;
  if (!isbn) continue;

  const prevHit = prevByIsbn.get(isbn) || {};
  let v = null;

  try {
    v = await googleByIsbn(isbn);
  } catch (e) {
    // ここで落とさない（次のループへ）
    v = null;
  }

  // 連続アクセス抑制（429予防）
  await sleep(140);

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

// rep付け
const byWork = new Map();
for (const it of items) {
  const k = it.workKey || it.title;
  const g = byWork.get(k) || [];
  g.push(it);
  byWork.set(k, g);
}

for (const [, g] of byWork) repPick(g)._rep = true;

// 書き込み
await fs.writeFile("data/manga/items_master.json", JSON.stringify(items, null, 2));

const works = items.filter((x) => x._rep).length;
const amazon = items.filter((x) => x.asin || x.amazonUrl).length;
console.log(`items=${items.length} works=${works} desc=${descCount} amazon=${amazon}`);
