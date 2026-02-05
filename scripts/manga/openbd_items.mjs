// scripts/manga/openbd_items.mjs （全差し替え）
// 最新刊（items_master.json）を作る：入力は data/manga/list_items.json
// - openBD から description を出来る限り拾う（形ゆれ耐性あり）
// - 既存 items_master があれば asin/amazonUrl を引き継ぐ
// - workKey / seriesType / volumeHint を推定
// - workKeyごとに rep（代表）付与
import fs from "node:fs/promises";

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
  if (/(color\s*walk|カラー\s*ウォーク|カラーウォーク|画集|イラスト|art\s*book|visual|ビジュアル|原画|設定資料)/i.test(t))
    return "art";
  if (/(公式|ガイド|guide|ファンブック|キャラクター|データブック|ムック|解説|大全|book\s*guide)/i.test(t))
    return "guide";
  if (/(スピンオフ|spinoff|episode|外伝|番外編|短編集|アンソロジー)/i.test(t))
    return "spinoff";
  return "main";
}

// --- openBD description 抽出（形ゆれ耐性） ---
function firstTextDeep(v) {
  if (v == null) return null;
  if (typeof v === "string") {
    const s = v.trim();
    return s ? s : null;
  }

  if (Array.isArray(v)) {
    for (const x of v) {
      const t = firstTextDeep(x);
      if (t) return t;
    }
    return null;
  }

  if (typeof v === "object") {
    const keys = ["Text", "text", "#text", "content", "value"];
    for (const k of keys) {
      if (k in v) {
        const t = firstTextDeep(v[k]);
        if (t) return t;
      }
    }
    for (const k of Object.keys(v)) {
      const t = firstTextDeep(v[k]);
      if (t) return t;
    }
  }
  return null;
}

function pickOpenbdText(x) {
  const t1 = firstTextDeep(x?.onix?.CollateralDetail?.TextContent);
  if (t1) return t1;

  const t2 = firstTextDeep(x?.summary?.description);
  if (t2) return t2;

  return null;
}

async function openbdByIsbn(isbn) {
  const u = `https://api.openbd.jp/v1/get?isbn=${encodeURIComponent(isbn)}`;
  const r = await fetchJson(u);
  const x = Array.isArray(r) ? r[0] : null;
  return x || null;
}

function dpFrom(asinOrUrl) {
  if (!asinOrUrl) return null;
  const s = String(asinOrUrl).trim();
  const m = s.match(
    /^https:\/\/www\.amazon\.co\.jp\/dp\/([A-Z0-9]{10}|[0-9]{9}X|[0-9]{10})(?:[/?].*)?$/i
  );
  if (m) return `https://www.amazon.co.jp/dp/${m[1]}`;
  const asin = s.toUpperCase().replace(/[^0-9A-Z]/g, "");
  if (/^[A-Z0-9]{10}$/.test(asin)) return `https://www.amazon.co.jp/dp/${asin}`;
  return null;
}

function repPick(group) {
  // 最新刊（items_master）は基本1冊/series想定だが、念のため
  const main = group.filter((x) => x.seriesType === "main");
  const pool = main.length ? main : group;

  const withVol = pool
    .filter((x) => Number.isFinite(x.volumeHint))
    .sort((a, b) => a.volumeHint - b.volumeHint);

  // 最新刊側は volumeHint が大きいほど新しい前提なので、最大を代表にする
  return (
    pool
      .filter((x) => Number.isFinite(x.volumeHint))
      .sort((a, b) => (b.volumeHint ?? -1) - (a.volumeHint ?? -1))[0] ||
    withVol[withVol.length - 1] ||
    pool[0]
  );
}

// ---- main ----
const N = Number(process.env.ITEMS_MASTER || 30);

// 入力：list_items.json（あなたの現行設計）
// ※ latest に isbn13/title が入ってる前提。無ければトップの title/isbn13 も見る。
const listRaw = JSON.parse(await fs.readFile("data/manga/list_items.json", "utf8"));
const list = Array.isArray(listRaw) ? listRaw : listRaw.items || [];
const src = list.slice(0, N);

// 既存 items_master があれば ASIN / amazonUrl を引き継ぐ
let prev = [];
try {
  prev = JSON.parse(await fs.readFile("data/manga/items_master.json", "utf8"));
} catch {}
const prevByIsbn = new Map(
  prev
    .map((x) => [x?.isbn13, x])
    .filter(([k]) => k && typeof k === "string")
);

const items = [];
let descCount = 0;

for (let i = 0; i < src.length; i++) {
  const c = src[i] || {};
  const latest = c.latest || {};

  const isbn =
    latest.isbn13 ||
    c.isbn13 ||
    c.isbn ||
    null;

  const title =
    latest.title ||
    c.title ||
    null;

  if (!isbn || !title) continue;

  console.log(
    `[openbd_items] ${i + 1}/${src.length} isbn=${isbn} title=${String(title).slice(0, 40)}`
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

  // Amazon情報：優先順位（list_items.latest.amazonDp -> prev -> (asin)->dp）
  const fromListDp = dpFrom(latest.amazonDp || latest.asin || null);
  const prevDp = dpFrom(prevHit.amazonUrl || prevHit.asin || null);

  const asin =
    (latest.asin && String(latest.asin).trim()) ||
    (prevHit.asin && String(prevHit.asin).trim()) ||
    null;

  const amazonUrl =
    fromListDp ||
    prevDp ||
    (asin ? dpFrom(asin) : null) ||
    null;

  items.push({
    workKey: c.seriesKey ? norm(c.seriesKey) : parentWorkKey(title),
    seriesType: classifySeriesType(title),
    title: title || sum.title || null,
    author: c.author || sum.author || null,
    publisher: c.publisher || sum.publisher || null,
    isbn13: isbn,
    asin,
    amazonUrl,
    publishedAt: latest.publishedAt || c.publishedAt || sum.pubdate || null,
    description: desc,
    image: (c.vol1 && c.vol1.image) || c.image || sum.cover || null,
    volumeHint:
      Number.isFinite(latest.volume) ? latest.volume
      : Number.isFinite(c.volumeHint) ? c.volumeHint
      : volumeHint(title),
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

// 出力
await fs.writeFile("data/manga/items_master.json", JSON.stringify(items, null, 2));

const works = items.filter((x) => x._rep).length;
const amazon = items.filter((x) => x.asin || x.amazonUrl).length;
console.log(`items=${items.length} works=${works} desc=${descCount} amazon=${amazon}`);
