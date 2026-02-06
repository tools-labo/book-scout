// scripts/manga/openbd_items.mjs （全差し替え）
// 入力: data/manga/list_items.json
// 出力: data/manga/items_master.json
//
// 仕様:
// - openBD -> description を取得（可能なら）
// - 取れない場合: 既存items_master.descriptionを保持（消さない）
// - RAKUTEN_APP_ID があれば Rakuten itemCaption をフォールバック多段で埋める
//    1) ISBN検索
//    2) 最新刊タイトル検索
//    3) 作品名（巻数・記号除去）検索
//    4) 作品名 + 著者（ヒット過多の時の絞り）
// - OPENBD_PROBE=1 で最初の1件だけ観測ログを出す
import fs from "node:fs/promises";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchText(url, tries = 3, headers = {}) {
  for (let i = 0; i < tries; i++) {
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), 15000);
    try {
      const r = await fetch(url, { cache: "no-store", signal: ac.signal, headers });
      clearTimeout(to);
      const t = await r.text();
      if (r.ok) return t;
      if ((r.status === 429 || r.status >= 500) && i < tries - 1) {
        await sleep(800 + i * 600);
        continue;
      }
      throw new Error(`HTTP ${r.status}\n${t.slice(0, 160)}`);
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

async function fetchJson(url, tries = 3, headers = {}) {
  const t = await fetchText(url, tries, headers);
  return t ? JSON.parse(t) : null;
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

// openBD description 抽出（形ゆれ耐性）
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
  return (
    group
      .filter((x) => Number.isFinite(x.volumeHint))
      .sort((a, b) => (b.volumeHint ?? -1) - (a.volumeHint ?? -1))[0] || group[0]
  );
}

// --- Rakuten fallback ---
const APP_ID = process.env.RAKUTEN_APP_ID || "";
const UA = { "User-Agent": "book-scout-bot" };

const digits = (s) => String(s || "").replace(/\D/g, "");

function cleanTitle(t) {
  return String(t || "").replace(/\s+/g, " ").trim();
}
function cleanAuthor(a) {
  return String(a || "")
    .replace(/[、,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function scoreCandidate(targetTitle, targetAuthor, it) {
  const tt = norm(targetTitle);
  const ta = norm(targetAuthor);
  const ct = norm(it?.title || "");
  const ca = norm(it?.author || "");

  let s = 0;

  // タイトル一致系
  if (ct && tt && ct.includes(tt)) s += 60;
  if (ct && tt && tt.includes(ct)) s += 25;
  if (ct && tt && ct.startsWith(tt)) s += 15;

  // 著者
  if (ta && ca && ca.includes(ta)) s += 40;
  if (ta && ca && ta.includes(ca)) s += 15;

  // ISBN
  const isbn = digits(it?.isbn || "");
  if (isbn.length === 13) s += 5;

  // 付録系の誤爆ペナルティ
  const raw = String(it?.title || "");
  if (/外伝|番外編|スピンオフ|公式|ガイド|ファンブック|設定資料|画集|アンソロジー/i.test(raw)) s -= 30;

  return s;
}

async function rakutenSearch(params) {
  const url =
    "https://app.rakuten.co.jp/services/api/BooksBook/Search/20170404" +
    `?applicationId=${encodeURIComponent(APP_ID)}` +
    `&format=json&hits=${encodeURIComponent(params.hits || 10)}` +
    `&elements=${encodeURIComponent(params.elements || "title,author,isbn,itemCaption")}` +
    (params.isbn ? `&isbn=${encodeURIComponent(digits(params.isbn))}` : "") +
    (params.title ? `&title=${encodeURIComponent(params.title)}` : "") +
    (params.author ? `&author=${encodeURIComponent(params.author)}` : "");

  return await fetchJson(url, 3, UA);
}

async function rakutenCaptionFallback({ isbn13, latestTitle, seriesTitle, author }) {
  if (!APP_ID) return null;

  // 1) ISBN
  try {
    const j = await rakutenSearch({
      isbn: isbn13,
      hits: 3,
      elements: "title,author,isbn,itemCaption",
    });
    const it = j?.Items?.[0]?.Item;
    const cap = (it?.itemCaption || "").trim();
    if (cap) return { cap, method: "rakuten_isbn" };
  } catch {}

  // 共通: 候補評価
  const pickFrom = (items, t, a) => {
    const list = (items || []).map((x) => x?.Item).filter(Boolean);
    if (!list.length) return null;

    let best = null;
    let bestScore = -1;
    for (const it of list) {
      const s = scoreCandidate(t, a, it);
      if (s > bestScore) {
        bestScore = s;
        best = it;
      }
    }
    const cap = (best?.itemCaption || "").trim();
    if (!cap) return null;
    if (bestScore < 35) return null;
    return { cap, bestScore };
  };

  const a = cleanAuthor(author);

  // 2) 最新刊タイトル検索
  try {
    const t = cleanTitle(latestTitle);
    if (t) {
      const j = await rakutenSearch({
        title: t,
        hits: 10,
        elements: "title,author,isbn,itemCaption",
      });
      const hit = pickFrom(j?.Items, t, a);
      if (hit?.cap) return { cap: hit.cap, method: "rakuten_title_latest" };
    }
  } catch {}

  // 3) 作品名（巻数除去）検索 ← ここが本命
  try {
    const t = cleanTitle(seriesTitle);
    if (t) {
      const j = await rakutenSearch({
        title: t,
        hits: 10,
        elements: "title,author,isbn,itemCaption",
      });
      const hit = pickFrom(j?.Items, t, a);
      if (hit?.cap) return { cap: hit.cap, method: "rakuten_title_series" };
    }
  } catch {}

  // 4) 作品名 + 著者（絞り検索）
  try {
    const t = cleanTitle(seriesTitle);
    if (t && a) {
      const j = await rakutenSearch({
        title: t,
        author: a,
        hits: 10,
        elements: "title,author,isbn,itemCaption",
      });
      const hit = pickFrom(j?.Items, t, a);
      if (hit?.cap) return { cap: hit.cap, method: "rakuten_title_series_author" };
    }
  } catch {}

  return null;
}

// ---- main ----
const N = Number(process.env.ITEMS_MASTER || 30);
const PROBE = process.env.OPENBD_PROBE === "1";

const listRaw = JSON.parse(await fs.readFile("data/manga/list_items.json", "utf8"));
const list = Array.isArray(listRaw) ? listRaw : listRaw.items || [];
const src = list.slice(0, N);

let prev = [];
try {
  prev = JSON.parse(await fs.readFile("data/manga/items_master.json", "utf8"));
} catch {}
const prevByIsbn = new Map(prev.map((x) => [x?.isbn13, x]).filter(([k]) => k));

const items = [];
let descCount = 0;

// stats
let openbd_ok = 0;
let openbd_has_desc = 0;
let rakuten_tried = 0;
let rakuten_ok = 0;
const rakuten_ok_by = {
  isbn: 0,
  title_latest: 0,
  title_series: 0,
  title_series_author: 0,
};

for (let i = 0; i < src.length; i++) {
  const c = src[i] || {};
  const latest = c.latest || {};

  const isbn = latest.isbn13 || c.isbn13 || c.isbn || null;
  const title = latest.title || c.title || null;
  if (!isbn || !title) continue;

  console.log(`[openbd_items] ${i + 1}/${src.length} isbn=${isbn} title=${String(title).slice(0, 40)}`);

  const prevHit = prevByIsbn.get(String(isbn).replace(/\D/g, "")) || prevByIsbn.get(isbn) || {};

  // ---- openBD ----
  let ob = null;
  try {
    ob = await openbdByIsbn(isbn);
    if (ob) openbd_ok++;
  } catch (e) {
    console.log(`[openbd_items]   openbd error: ${String(e?.message || e).slice(0, 80)}`);
  }

  if (PROBE && i === 0) {
    const has = !!ob;
    const keys = ob ? Object.keys(ob).slice(0, 20) : [];
    const sumKeys = ob?.summary ? Object.keys(ob.summary) : [];
    const tc = ob?.onix?.CollateralDetail?.TextContent;
    const tcType = Array.isArray(tc) ? `array(${tc.length})` : typeof tc;
    console.log(`[openbd_probe] has=${has} keys=${JSON.stringify(keys)}`);
    console.log(`[openbd_probe] summaryKeys=${JSON.stringify(sumKeys)}`);
    console.log(`[openbd_probe] TextContentType=${tcType}`);
  }

  await sleep(120);

  let desc = ob ? pickOpenbdText(ob) : null;
  if (desc) openbd_has_desc++;

  // ---- Rakuten ----
  if (!desc && APP_ID) {
    rakuten_tried++;
    try {
      const seriesTitle = c.seriesKey ? c.seriesKey : baseTitle(title);
      const r = await rakutenCaptionFallback({
        isbn13: isbn,
        latestTitle: title,
        seriesTitle,
        author: c.author || "",
      });
      if (r?.cap) {
        desc = r.cap;
        rakuten_ok++;
        if (r.method === "rakuten_isbn") rakuten_ok_by.isbn++;
        if (r.method === "rakuten_title_latest") rakuten_ok_by.title_latest++;
        if (r.method === "rakuten_title_series") rakuten_ok_by.title_series++;
        if (r.method === "rakuten_title_series_author") rakuten_ok_by.title_series_author++;
      }
    } catch {}
    await sleep(180);
  }

  // **重要**：descが取れなくても「既存のdescription」を消さない
  const finalDesc = desc || prevHit.description || null;
  if (finalDesc) descCount++;

  const sum = ob?.summary || {};

  const asin =
    (latest.asin && String(latest.asin).trim()) ||
    (prevHit.asin && String(prevHit.asin).trim()) ||
    null;

  const amazonUrl =
    dpFrom(latest.amazonDp || null) ||
    dpFrom(prevHit.amazonUrl || null) ||
    (asin ? dpFrom(asin) : null) ||
    null;

  items.push({
    workKey: c.seriesKey ? norm(c.seriesKey) : parentWorkKey(title),
    seriesType: classifySeriesType(title),
    title: title || sum.title || null,
    author: c.author || sum.author || null,
    publisher: c.publisher || sum.publisher || null,
    isbn13: String(isbn).replace(/\D/g, ""),
    asin,
    amazonUrl,
    publishedAt: latest.publishedAt || c.publishedAt || sum.pubdate || null,
    description: finalDesc,
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

await fs.writeFile("data/manga/items_master.json", JSON.stringify(items, null, 2));

const works = items.filter((x) => x._rep).length;
const amazon = items.filter((x) => x.asin || x.amazonUrl).length;
console.log(`items=${items.length} works=${works} desc=${descCount} amazon=${amazon}`);
console.log(
  `[openbd_stats] openbd_ok=${openbd_ok} openbd_has_desc=${openbd_has_desc} ` +
  `rakuten_tried=${rakuten_tried} rakuten_ok=${rakuten_ok} ` +
  `rakuten_ok_isbn=${rakuten_ok_by.isbn} ` +
  `rakuten_ok_title_latest=${rakuten_ok_by.title_latest} ` +
  `rakuten_ok_title_series=${rakuten_ok_by.title_series} ` +
  `rakuten_ok_title_series_author=${rakuten_ok_by.title_series_author}`
);
