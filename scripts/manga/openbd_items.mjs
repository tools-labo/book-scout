// scripts/manga/openbd_items.mjs （全差し替え）
// 入力: data/manga/list_items.json（最新刊リスト）
// 出力: data/manga/items_master.json（最新刊アイテム）
//
// 仕様:
// - openBD -> description を取得（可能なら）
// - 取れない場合: 既存items_master.descriptionを保持（消さない）
// - さらに RAKUTEN_APP_ID があれば Rakuten itemCaption をフォールバックで埋める
//   * まず isbn 検索
//   * ダメなら title+author 検索（こちらが現状の勝ち筋）
// - OPENBD_PROBE=1 で最初の1件だけ観測ログ（openbd/rakuten）

import fs from "node:fs/promises";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchText(url, tries = 3, headers = {}) {
  for (let i = 0; i < tries; i++) {
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), 15000);
    try {
      const r = await fetch(url, {
        cache: "no-store",
        signal: ac.signal,
        headers: {
          "User-Agent": "book-scout-bot",
          ...headers,
        },
      });
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

const digits = (s) => String(s || "").replace(/\D/g, "");

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
  const r = await fetchJson(u, 3);
  const x = Array.isArray(r) ? r[0] : null;
  // openBDは「見つからない」だと null が入る。{} もあり得るので保険
  if (!x || (typeof x === "object" && Object.keys(x).length === 0)) return null;
  return x;
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

async function rakutenCaptionByIsbn(isbn13) {
  if (!APP_ID) return { cap: null, err: "no_app_id" };
  const url =
    "https://app.rakuten.co.jp/services/api/BooksBook/Search/20170404" +
    `?applicationId=${encodeURIComponent(APP_ID)}` +
    `&isbn=${encodeURIComponent(digits(isbn13))}` +
    "&format=json" +
    "&hits=1" +
    "&elements=isbn,itemCaption";
  try {
    const j = await fetchJson(url, 3);
    const it = j?.Items?.[0]?.Item;
    const cap = (it?.itemCaption || "").trim();
    return { cap: cap || null, err: cap ? null : "empty" };
  } catch (e) {
    return { cap: null, err: String(e?.message || e).slice(0, 120) };
  }
}

// isbnが当たらない時用：title(+author)検索で itemCaption を拾う（こっちが勝ち筋）
async function rakutenCaptionByTitle(title, author, expectIsbn13) {
  if (!APP_ID) return { cap: null, err: "no_app_id" };

  const qTitle = String(title || "").trim();
  if (!qTitle) return { cap: null, err: "no_title" };

  const url =
    "https://app.rakuten.co.jp/services/api/BooksBook/Search/20170404" +
    `?applicationId=${encodeURIComponent(APP_ID)}` +
    `&title=${encodeURIComponent(qTitle)}` +
    (author ? `&author=${encodeURIComponent(String(author).trim())}` : "") +
    "&format=json" +
    "&hits=10" +
    "&elements=title,author,isbn,itemCaption";

  try {
    const j = await fetchJson(url, 3);
    const items = (j?.Items || []).map((x) => x?.Item).filter(Boolean);

    const want = digits(expectIsbn13);
    // 期待ISBN一致があれば最優先
    let best = items.find((it) => digits(it?.isbn) === want);

    // それでも無ければ、captionがある最初のやつ
    if (!best) best = items.find((it) => String(it?.itemCaption || "").trim());

    const cap = (best?.itemCaption || "").trim();
    return { cap: cap || null, err: cap ? null : "empty" };
  } catch (e) {
    return { cap: null, err: String(e?.message || e).slice(0, 120) };
  }
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
const prevByIsbn = new Map(
  prev.map((x) => [x?.isbn13, x]).filter(([k]) => k && typeof k === "string")
);

const items = [];
let descCount = 0;

let openbdOk = 0;
let openbdHasDesc = 0;
let rakutenTried = 0;
let rakutenOk = 0;

for (let i = 0; i < src.length; i++) {
  const c = src[i] || {};
  const latest = c.latest || {};

  const isbn = latest.isbn13 || c.isbn13 || c.isbn || null;
  const title = latest.title || c.title || null;
  if (!isbn || !title) continue;

  console.log(
    `[openbd_items] ${i + 1}/${src.length} isbn=${isbn} title=${String(title).slice(0, 40)}`
  );

  const prevHit = prevByIsbn.get(isbn) || {};

  // openBD
  let ob = null;
  try {
    ob = await openbdByIsbn(isbn);
    if (ob) openbdOk++;
  } catch (e) {
    if (PROBE && i === 0) {
      console.log(`[openbd_probe] openbd_error=${String(e?.message || e).slice(0, 120)}`);
    }
  }

  if (PROBE && i === 0) {
    const has = !!ob;
    const sumKeys = ob?.summary ? Object.keys(ob.summary) : [];
    const tc = ob?.onix?.CollateralDetail?.TextContent;
    const tcType = Array.isArray(tc) ? `array(${tc.length})` : typeof tc;
    console.log(`[openbd_probe] has=${has} summaryKeys=${JSON.stringify(sumKeys)}`);
    console.log(`[openbd_probe] TextContentType=${tcType}`);
  }

  await sleep(120);

  let desc = ob ? pickOpenbdText(ob) : null;
  if (desc) openbdHasDesc++;

  // Rakuten fallback
  if (!desc) {
    rakutenTried++;

    // 1) isbn検索
    let r1 = await rakutenCaptionByIsbn(isbn);

    // 2) ダメなら title(+author)検索（勝ち筋）
    if (!r1.cap) {
      const r2 = await rakutenCaptionByTitle(title, c.author || "", isbn);
      if (PROBE && i === 0) {
        console.log(`[openbd_probe] rakuten_isbn_fail=${r1.err}`);
        console.log(`[openbd_probe] rakuten_title_fail=${r2.err}`);
      }
      if (r2.cap) r1 = r2;
    }

    if (r1.cap) {
      desc = r1.cap;
      rakutenOk++;
    }

    await sleep(220);
  }

  // 既存保持（消さない）
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
    isbn13: isbn,
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

// rep 付与
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
  `[openbd_stats] openbd_ok=${openbdOk} openbd_has_desc=${openbdHasDesc} rakuten_tried=${rakutenTried} rakuten_ok=${rakutenOk}`
);
