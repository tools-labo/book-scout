// scripts/manga/openbd_items.mjs
import fs from "node:fs/promises";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function loadJson(path, fallback) {
  try {
    return JSON.parse(await fs.readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

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
      throw new Error(`HTTP ${r.status}\n${t.slice(0, 120)}`);
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

function pickOpenbdText(x) {
  if (!x) return null;

  // onix -> CollateralDetail
  const cd = x?.onix?.CollateralDetail;

  // TextContent
  const tcs = cd?.TextContent;
  if (Array.isArray(tcs)) {
    for (const tc of tcs) {
      const t = tc?.Text;
      if (typeof t === "string" && t.trim()) return t.trim();
      if (Array.isArray(t) && typeof t[0] === "string" && t[0].trim()) return t[0].trim();
      if (t && typeof t === "object") {
        const v = t?.[0] ?? t?.content ?? t?.text;
        if (typeof v === "string" && v.trim()) return v.trim();
      }
    }
  }

  // OtherText（古いONIX）
  const other = cd?.OtherText;
  if (Array.isArray(other)) {
    for (const ot of other) {
      const t = ot?.Text;
      if (typeof t === "string" && t.trim()) return t.trim();
      if (Array.isArray(t) && typeof t[0] === "string" && t[0].trim()) return t[0].trim();
    }
  }

  // summary.description
  const s = x?.summary?.description;
  if (typeof s === "string" && s.trim()) return s.trim();

  return null;
}

async function openbdByIsbn(isbn) {
  const u = `https://api.openbd.jp/v1/get?isbn=${encodeURIComponent(isbn)}`;
  const r = await fetchJson(u);
  const x = Array.isArray(r) ? r[0] : null;
  return x || null;
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

// ---- source selection ----
function buildSrcFromListItems(listItems) {
  if (!Array.isArray(listItems)) return [];
  const out = [];
  for (const x of listItems) {
    const isbn = x?.latest?.isbn13 || null;
    if (!isbn) continue;
    out.push({
      isbn13: isbn,
      title: x?.title || x?.seriesKey || "",
      author: x?.author || "",
      publisherName: x?.publisher || "",
      salesDate: x?.latest?.publishedAt || "",
      volumeHint: x?.latest?.volume ?? null,
    });
  }
  return out;
}

function buildSrcFromPrevItems(prev) {
  if (!Array.isArray(prev)) return [];
  return prev
    .filter((x) => x?.isbn13)
    .map((x) => ({
      isbn13: x.isbn13,
      title: x.title || x.workKey || "",
      author: x.author || "",
      publisherName: x.publisher || "",
      salesDate: x.publishedAt || "",
      volumeHint: x.volumeHint ?? null,
    }));
}

// ---- main ----
const N = Number(process.env.ITEMS_MASTER || 30);

const listItems = await loadJson("data/manga/list_items.json", null);
let src = buildSrcFromListItems(listItems);

let prev = await loadJson("data/manga/items_master.json", []);
if (!src.length) src = buildSrcFromPrevItems(prev);

src = src.slice(0, N);

// 既存 items_master があれば ASIN など引き継ぐ
const prevByIsbn = new Map(prev.map((x) => [x.isbn13, x]).filter(([k]) => k));

const items = [];
let descCount = 0;

for (let i = 0; i < src.length; i++) {
  const c = src[i];
  const isbn = c.isbn || c.isbn13 || null;
  if (!isbn) continue;

  console.log(
    `[openbd_items] ${i + 1}/${src.length} isbn=${isbn} title=${String(c.title || "").slice(0, 40)}`
  );

  const prevHit = prevByIsbn.get(isbn) || {};
  let ob = null;
  try {
    ob = await openbdByIsbn(isbn);
  } catch (e) {
    console.log(`[openbd_items]   openbd skip: ${String(e?.message || e).slice(0, 80)}`);
  }

  await sleep(120);

  const desc = ob ? pickOpenbdText(ob) : null;
  if (desc) descCount++;

  const sum = ob?.summary || {};
  const title = c.title || sum.title || null;

  items.push({
    workKey: parentWorkKey(title || ""),
    seriesType: classifySeriesType(title || ""),
    title,
    author: c.author || sum.author || null,
    publisher: c.publisherName || sum.publisher || null,
    isbn13: isbn,
    asin: prevHit.asin || null,
    amazonUrl: prevHit.amazonUrl || null,
    publishedAt: c.salesDate || sum.pubdate || null,
    description: desc || null,
    image: c.largeImageUrl || sum.cover || null,
    volumeHint: Number.isFinite(c.volumeHint) ? c.volumeHint : volumeHint(title || ""),
    _rep: false,
  });
}

// rep 付与（workKeyごと）
const byWork = new Map();
for (const it of items) {
  const k = it.workKey || it.title;
  const g = byWork.get(k) || [];
  g.push(it);
  byWork.set(k, g);
}
for (const [, g] of byWork) repPick(g)._rep = true;

await fs.mkdir("data/manga", { recursive: true });
await fs.writeFile("data/manga/items_master.json", JSON.stringify(items, null, 2));

const works = items.filter((x) => x._rep).length;
const amazon = items.filter((x) => x.asin || x.amazonUrl).length;
console.log(`items=${items.length} works=${works} desc=${descCount} amazon=${amazon}`);
