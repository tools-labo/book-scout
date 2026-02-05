// scripts/manga/openbd_items.mjs （全差し替え）
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
  if (/(color\s*walk|カラー\s*ウォーク|カラーウォーク|画集|イラスト|art\s*book|visual|ビジュアル|原画|設定資料)/i.test(t)) return "art";
  if (/(公式|ガイド|guide|ファンブック|キャラクター|データブック|ムック|解説|大全|book\s*guide)/i.test(t)) return "guide";
  if (/(スピンオフ|spinoff|episode|外伝|番外編|短編集|アンソロジー)/i.test(t)) return "spinoff";
  return "main";
}

function pickOpenbdText(x) {
  const tcs = x?.onix?.CollateralDetail?.TextContent;
  if (Array.isArray(tcs)) {
    const hit = tcs.find((a) => a?.Text) || tcs.find((a) => a?.Text?.[0]);
    const t = hit?.Text;
    if (typeof t === "string") return t;
    if (Array.isArray(t) && typeof t[0] === "string") return t[0];
  }
  const s = x?.summary?.description;
  return typeof s === "string" ? s : null;
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

// ---------------- helpers: load json safely ----------------
async function loadJson(path, fallback) {
  try {
    return JSON.parse(await fs.readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

async function fileExists(path) {
  try {
    await fs.stat(path);
    return true;
  } catch {
    return false;
  }
}

// ---------------- source candidates ----------------
//
// 期待する candidate 形（最低限）:
// { isbn13/isbn, title, author, publisherName/publisher, salesDate/publishedAt, volumeHint, largeImageUrl/image, seriesKey/workKey, asin, amazonDp/amazonUrl }
async function buildSrcCandidates(limit) {
  // 1) candidates.json（従来互換）
  if (await fileExists("data/manga/candidates.json")) {
    const candRaw = await loadJson("data/manga/candidates.json", []);
    const candList = Array.isArray(candRaw) ? candRaw : candRaw.items || candRaw.Items || [];
    return candList.slice(0, limit);
  }

  // 2) list_items.json（新構造：latest）
  if (await fileExists("data/manga/list_items.json")) {
    const listItems = await loadJson("data/manga/list_items.json", []);
    if (Array.isArray(listItems) && listItems.length) {
      // なるべく「発売日が新しい順」っぽく並べる（文字列比較の簡易）
      const sorted = [...listItems].sort((a, b) => {
        const pa = String(a?.latest?.publishedAt || "");
        const pb = String(b?.latest?.publishedAt || "");
        return pb.localeCompare(pa, "ja");
      });

      const out = [];
      for (const li of sorted) {
        const isbn13 = li?.latest?.isbn13 ? String(li.latest.isbn13).trim() : "";
        if (!isbn13) continue;

        out.push({
          isbn13,
          title: li?.title || null,
          author: li?.author || null,
          publisherName: li?.publisher || null,
          salesDate: li?.latest?.publishedAt || null,
          volumeHint: Number.isFinite(li?.latest?.volume) ? li.latest.volume : null,
          largeImageUrl: li?.vol1?.image || null,
          // workKey にシリーズキーを優先（安定）
          seriesKey: li?.seriesKey || null,
          // Amazon（最新刊側があれば使う）
          asin: li?.latest?.asin || null,
          amazonUrl: li?.latest?.amazonDp || null,
        });
        if (out.length >= limit) break;
      }
      return out;
    }
  }

  // 3) items_master.json（最後の保険）
  if (await fileExists("data/manga/items_master.json")) {
    const prev = await loadJson("data/manga/items_master.json", []);
    if (Array.isArray(prev) && prev.length) {
      const out = [];
      const seen = new Set();
      for (const it of prev) {
        const isbn13 = it?.isbn13 ? String(it.isbn13).trim() : "";
        if (!isbn13) continue;
        if (seen.has(isbn13)) continue;
        seen.add(isbn13);

        out.push({
          isbn13,
          title: it?.title || null,
          author: it?.author || null,
          publisherName: it?.publisher || null,
          salesDate: it?.publishedAt || null,
          volumeHint: Number.isFinite(it?.volumeHint) ? it.volumeHint : null,
          largeImageUrl: it?.image || null,
          seriesKey: it?.workKey || null,
          asin: it?.asin || null,
          amazonUrl: it?.amazonUrl || null,
        });
        if (out.length >= limit) break;
      }
      return out;
    }
  }

  // 4) 何もない
  return [];
}

// ---- main ----
const N = Number(process.env.ITEMS_MASTER || 30);

// 既存 items_master があれば ASIN など引き継ぐ（isbn13キー）
let prev = [];
try {
  prev = JSON.parse(await fs.readFile("data/manga/items_master.json", "utf8"));
} catch {}
const prevByIsbn = new Map(prev.map((x) => [x?.isbn13, x]).filter(([k]) => k));

const src = await buildSrcCandidates(N);

if (!src.length) {
  console.log("[openbd_items] src=0 (no candidates.json, no list_items.json, no items_master.json). write empty items_master and exit.");
  await fs.mkdir("data/manga", { recursive: true });
  await fs.writeFile("data/manga/items_master.json", JSON.stringify([], null, 2));
  console.log("items=0 works=0 desc=0 amazon=0");
  process.exit(0);
}

const items = [];
let descCount = 0;

for (let i = 0; i < src.length; i++) {
  const c = src[i] || {};
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

  // workKey：seriesKey/workKey があれば優先、なければタイトルから推定
  const wk = (c.seriesKey || c.workKey || "").trim();
  const finalWorkKey = wk ? norm(wk) : parentWorkKey(c.title || sum.title || "");

  // amazonUrl/asin：既存(items_master)の値を最優先（維持）→ srcにあれば使う
  const nextAsin = prevHit.asin || c.asin || null;
  const nextAmazonUrl = prevHit.amazonUrl || c.amazonUrl || null;

  items.push({
    workKey: finalWorkKey,
    seriesType: classifySeriesType(c.title || sum.title || ""),
    title: c.title || sum.title || null,
    author: c.author || sum.author || null,
    publisher: c.publisherName || c.publisher || sum.publisher || null,
    isbn13: isbn,
    asin: nextAsin,
    amazonUrl: nextAmazonUrl,
    publishedAt: c.salesDate || c.publishedAt || sum.pubdate || null,
    description: desc,
    image: c.largeImageUrl || c.image || sum.cover || null,
    volumeHint: Number.isFinite(c.volumeHint) ? c.volumeHint : volumeHint(c.title || sum.title || ""),
    _rep: false,
  });
}

// rep 付与
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
