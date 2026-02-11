// scripts/lane2/build_lane2.mjs
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const SEEDS_PATH = "data/lane2/seeds.json";
const OUT_SERIES = "data/lane2/series.json";
const OUT_TODO = "data/lane2/todo.json";
const OUT_REVIEW = "data/lane2/review.json"; // ★要確認レーン
const OUT_DEBUG = "data/lane2/debug_candidates.json";

const AMZ_ACCESS_KEY = process.env.AMZ_ACCESS_KEY || "";
const AMZ_SECRET_KEY = process.env.AMZ_SECRET_KEY || "";
const AMZ_PARTNER_TAG = process.env.AMZ_PARTNER_TAG || "";

// ★今回の処理上限（積み上げ運用の肝）
const BUILD_LIMIT = Math.max(1, Math.min(200, parseInt(process.env.LANE2_BUILD_LIMIT || "20", 10) || 20));

function nowIso() {
  return new Date().toISOString();
}
async function loadJson(p, fallback) {
  try {
    return JSON.parse(await fs.readFile(p, "utf8"));
  } catch {
    return fallback;
  }
}
async function saveJson(p, obj) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(obj, null, 2));
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function norm(s) {
  return String(s ?? "").trim();
}
function normLoose(s) {
  return norm(s).replace(/\s+/g, "");
}
function toHalfWidth(s) {
  return String(s ?? "")
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[（]/g, "(")
    .replace(/[）]/g, ")")
    .replace(/[　]/g, " ");
}

function titleHasSeries(title, seriesKey) {
  const t = normLoose(title);
  const s = normLoose(seriesKey);
  if (!t || !s) return false;
  return t.includes(s);
}
function isVol1Like(title) {
  const t = toHalfWidth(norm(title));
  if (/\(\s*1\s*\)/.test(t)) return true;
  if (/（\s*1\s*）/.test(t)) return true;
  if (/第\s*1\s*巻/.test(t)) return true;
  if (/1\s*巻/.test(t)) return true;
  return /\b1\b/.test(t);
}

/**
 * 派生を弾く（タイトルだけで安全側に）
 */
function isDerivedEdition(title) {
  const t = toHalfWidth(norm(title)).toLowerCase();

  if (/全巻|巻セット|セット|box|ボックス|まとめ買い/.test(t)) return true;

  if (/ファンブック|副読本|ガイド|ムック|設定資料|資料集|キャラクターブック|bible|図録|公式/.test(t))
    return true;

  if (/episode|外伝|番外編|スピンオフ|side\s*story/.test(t)) return true;

  if (/小説|ノベライズ|文庫/.test(t)) return true;

  if (/full\s*color|フルカラー|カラー|selection/.test(t)) return true;

  if (
    /バイリンガル|bilingual|デラックス|deluxe|英語版|翻訳|korean|韓国語|中国語|台湾|français|french|german|deutsch/.test(t)
  )
    return true;

  if (/単話|分冊|話売り|第\s*\d+\s*話/.test(t)) return true;

  if (/ポスター|画集|原画集|イラストブック|設定集|ビジュアルブック/.test(t)) return true;

  return false;
}

/**
 * ★「シリーズ名の後に余計な文字列が入ってから巻表記が来る」→ reviewへ
 * - 極主夫道 1巻: バンチコミックス   => OK（余計な文字なしで巻表記）
 * - ホムンクルスの詩 １話-（１）     => review（シリーズ名の後に "の詩 １話-" が入る）
 * - 東京卍リベンジャーズ ~場地…~(1)  => review
 */
function detectSuspiciousSubtitle({ title, seriesKey }) {
  const t = toHalfWidth(norm(title));
  const s = toHalfWidth(norm(seriesKey));
  if (!t || !s) return { suspicious: false, reason: null };

  const idx = t.indexOf(s);
  if (idx < 0) return { suspicious: false, reason: null };

  const after = t.slice(idx + s.length);

  // 「巻表記」が最初に現れる位置を探す（ここより前に実文字があったら危険）
  const volMarkers = [
    /\(\s*1\s*\)/, /（\s*1\s*）/,
    /第\s*1\s*巻/,
    /1\s*巻/,
    /\b1\b/,
  ];

  let cut = after.length;
  for (const re of volMarkers) {
    const m = after.match(re);
    if (!m || m.index == null) continue;
    cut = Math.min(cut, m.index);
  }

  // 巻表記が見つからないならここでは疑わない（別ルートで落ちる）
  if (cut === after.length) return { suspicious: false, reason: null };

  // 巻表記の前の部分
  const beforeVol = after.slice(0, cut);

  // 「許容するノイズ」（空白・記号・中点など）
  const cleaned = beforeVol
    .replace(/[\s　]/g, "")
    .replace(/[・･\.\-ー–—:：~～]/g, "")
    .replace(/[()（）【】『』「」]/g, "");

  // ★ここが肝：実文字が残る＝シリーズ名直後に別題が混ざってる
  if (cleaned.length > 0) {
    // 理由の粗分類（デバッグ用）
    if (/[~～]/.test(beforeVol)) return { suspicious: true, reason: "subtitle_tilde" };
    if (/[：:]/.test(beforeVol)) return { suspicious: true, reason: "subtitle_colon" };
    if (/[「『【]/.test(beforeVol)) return { suspicious: true, reason: "subtitle_quotes" };
    if (/[-ー–—]/.test(beforeVol)) return { suspicious: true, reason: "subtitle_dash" };
    if (beforeVol.length >= 8) return { suspicious: true, reason: "subtitle_long" };
    return { suspicious: true, reason: "subtitle_text_before_vol" };
  }

  // 追加の「派生ワード」検知（巻表記後でも危険なやつ）
  // ※ここは review 送りで、確定弾きはしない
  const rest = after.slice(cut).replace(/\s+/g, " ");
  if (/(からの手紙|アンソロジー|公式アンソロジー|特装版|限定版|キャラブック|設定資料|ガイド|ムック|ファンブック)/.test(rest)) {
    return { suspicious: true, reason: "subtitle_keyword" };
  }

  return { suspicious: false, reason: null };
}

/**
 * “本線1巻” 判定（タイトルベース）
 */
function isMainlineVol1ByTitle(title, seriesKey) {
  const t = toHalfWidth(norm(title));
  const s = toHalfWidth(norm(seriesKey));
  if (!t || !s) return false;
  if (!titleHasSeries(t, s)) return false;
  if (!isVol1Like(t)) return false;
  if (isDerivedEdition(t)) return false;

  const idx = t.indexOf(s);
  if (idx >= 0) {
    const rest = t.slice(idx + s.length);
    if (/^\s*[-ー–—]\s*(episode|外伝)/i.test(rest)) return false;
  }
  return true;
}

/**
 * スコアは “補助”
 */
function scoreCandidate({ title, isbn13, seriesKey }) {
  let score = 0;
  const t = norm(title);
  if (!t) return 0;

  if (isbn13) score += 80;
  if (seriesKey && titleHasSeries(t, seriesKey)) score += 40;

  if (isVol1Like(t)) score += 25;

  if (isDerivedEdition(t)) score -= 1000;

  if (seriesKey && isMainlineVol1ByTitle(t, seriesKey)) score += 500;

  return score;
}

function pickBest(cands, seriesKey) {
  if (!cands.length) return null;

  const withIdx = cands.map((c, i) => ({ ...c, __i: i }));
  withIdx.sort((a, b) => {
    const sa = a.score ?? 0;
    const sb = b.score ?? 0;
    if (sb !== sa) return sb - sa;

    const am = seriesKey && isMainlineVol1ByTitle(a.title || "", seriesKey) ? 1 : 0;
    const bm = seriesKey && isMainlineVol1ByTitle(b.title || "", seriesKey) ? 1 : 0;
    if (bm !== am) return bm - am;

    const la = (a.title || "").length;
    const lb = (b.title || "").length;
    if (la !== lb) return la - lb;

    return a.__i - b.__i;
  });

  const { __i, ...best } = withIdx[0];
  return best;
}

// ★dpは「ASIN優先」で正規化
function dpPreferAsin({ asin, isbn13, isbn10 }) {
  if (asin && /^[A-Z0-9]{10}$/i.test(String(asin))) {
    return `https://www.amazon.co.jp/dp/${String(asin).toUpperCase()}`;
  }
  if (isbn10 && /^\d{10}$/.test(String(isbn10))) {
    return `https://www.amazon.co.jp/dp/${String(isbn10)}`;
  }
  if (isbn13 && /^\d{13}$/.test(String(isbn13))) {
    return `https://www.amazon.co.jp/dp/${String(isbn13)}`;
  }
  return null;
}

/* -----------------------
 * Amazon PA-API（公式APIのみ）
 * ----------------------- */
function awsHmac(key, data) {
  return crypto.createHmac("sha256", key).update(data, "utf8").digest();
}
function awsHash(data) {
  return crypto.createHash("sha256", data).digest("hex");
}
function amzDate() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  return { amzDate: `${y}${m}${day}T${hh}${mm}${ss}Z`, dateStamp: `${y}${m}${day}` };
}

// 429 はリトライ（軽め）
async function paapiRequest({ target, pathUri, bodyObj }) {
  if (!AMZ_ACCESS_KEY || !AMZ_SECRET_KEY || !AMZ_PARTNER_TAG) {
    return { skipped: true, reason: "missing_paapi_secrets" };
  }

  const host = "webservices.amazon.co.jp";
  const region = "us-west-2";
  const service = "ProductAdvertisingAPI";
  const endpoint = `https://${host}${pathUri}`;

  let wait = 900;
  for (let attempt = 1; attempt <= 4; attempt++) {
    const body = JSON.stringify(bodyObj);
    const { amzDate: xAmzDate, dateStamp } = amzDate();
    const method = "POST";
    const canonicalUri = pathUri;
    const canonicalQuerystring = "";
    const canonicalHeaders =
      `content-encoding:amz-1.0\ncontent-type:application/json; charset=utf-8\nhost:${host}\nx-amz-date:${xAmzDate}\nx-amz-target:${target}\n`;
    const signedHeaders = "content-encoding;content-type;host;x-amz-date;x-amz-target";
    const payloadHash = crypto.createHash("sha256").update(body, "utf8").digest("hex");

    const canonicalRequest = [method, canonicalUri, canonicalQuerystring, canonicalHeaders, signedHeaders, payloadHash].join("\n");
    const algorithm = "AWS4-HMAC-SHA256";
    const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
    const stringToSign = [algorithm, xAmzDate, credentialScope, crypto.createHash("sha256").update(canonicalRequest, "utf8").digest("hex")].join("\n");

    const kDate = awsHmac(`AWS4${AMZ_SECRET_KEY}`, dateStamp);
    const kRegion = awsHmac(kDate, region);
    const kService = awsHmac(kRegion, service);
    const kSigning = awsHmac(kService, "aws4_request");
    const signature = crypto.createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");

    const authorizationHeader =
      `${algorithm} Credential=${AMZ_ACCESS_KEY}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const r = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-encoding": "amz-1.0",
        "content-type": "application/json; charset=utf-8",
        host,
        "x-amz-date": xAmzDate,
        "x-amz-target": target,
        Authorization: authorizationHeader,
      },
      body,
    });

    const text = await r.text();

    if (r.ok) return { ok: true, json: JSON.parse(text) };

    if (r.status === 429 && attempt < 4) {
      await sleep(wait);
      wait *= 2;
      continue;
    }

    return { error: true, status: r.status, body: text.slice(0, 1400) };
  }

  return { error: true, status: 429, body: "retry_exhausted" };
}

async function paapiSearchItems({ keywords }) {
  return paapiRequest({
    target: "com.amazon.paapi5.v1.ProductAdvertisingAPIv1.SearchItems",
    pathUri: "/paapi5/searchitems",
    bodyObj: {
      Keywords: keywords,
      SearchIndex: "Books",
      ItemCount: 10,
      PartnerTag: AMZ_PARTNER_TAG,
      PartnerType: "Associates",
      Resources: ["ItemInfo.Title", "ItemInfo.ExternalIds", "ItemInfo.ByLineInfo", "Images.Primary.Large"],
    },
  });
}

async function paapiGetItems({ itemIds }) {
  return paapiRequest({
    target: "com.amazon.paapi5.v1.ProductAdvertisingAPIv1.GetItems",
    pathUri: "/paapi5/getitems",
    bodyObj: {
      ItemIds: itemIds,
      PartnerTag: AMZ_PARTNER_TAG,
      PartnerType: "Associates",
      Resources: ["ItemInfo.Title", "ItemInfo.ExternalIds", "ItemInfo.ByLineInfo", "Images.Primary.Large"],
    },
  });
}

function extractIsbn13(item) {
  const eans = item?.ItemInfo?.ExternalIds?.EANs?.DisplayValues;
  if (Array.isArray(eans) && eans.length) {
    const v = String(eans[0]).replace(/[^0-9]/g, "");
    if (/^97[89]\d{10}$/.test(v)) return v;
  }
  const isbns = item?.ItemInfo?.ExternalIds?.ISBNs?.DisplayValues;
  if (Array.isArray(isbns) && isbns.length) {
    const v = String(isbns[0]).replace(/[^0-9]/g, "");
    if (/^97[89]\d{10}$/.test(v)) return v;
  }
  return null;
}
function extractTitle(item) {
  return item?.ItemInfo?.Title?.DisplayValue || "";
}
function extractImage(item) {
  return item?.Images?.Primary?.Large?.URL || null;
}

/**
 * PA-API search（“本線1巻” だけ候補化）
 * ★デバッグ用に「シリーズ名は含むが落ちた候補」を少し残す
 */
async function paapiSearchMainlineVol1({ seriesKey }) {
  const tries = [
    `${seriesKey} (1)`,
    `${seriesKey}（1）`,
    `${seriesKey} 1`,
    `${seriesKey} 1 コミックス`,
    `${seriesKey} 1 (コミックス)`,
  ];

  const results = [];
  for (const q of tries) {
    const res = await paapiSearchItems({ keywords: q });
    if (res?.skipped) return { skipped: true, reason: res.reason };
    if (res?.error) {
      results.push({ query: q, ok: false, status: res.status, body: res.body });
      continue;
    }

    const items = res?.json?.SearchResult?.Items || [];
    const cands = [];
    const rejected = [];

    for (const it of items) {
      const title = extractTitle(it);
      const isbn13 = extractIsbn13(it);
      const asin = it?.ASIN || null;
      const image = extractImage(it) || null;

      // シリーズ名を含まないものは関係ないので無視
      if (!titleHasSeries(title, seriesKey)) continue;

      // デバッグ用：落ちた理由を軽く残す（最大5件）
      if (!isMainlineVol1ByTitle(title, seriesKey)) {
        if (rejected.length < 5) {
          const sub = detectSuspiciousSubtitle({ title, seriesKey });
          rejected.push({
            title,
            asin,
            isbn13,
            why: isDerivedEdition(title) ? "derived" : sub.suspicious ? `suspicious(${sub.reason})` : "not_mainline_vol1",
          });
        }
        continue;
      }

      const score = scoreCandidate({ title, isbn13, seriesKey }) + (asin ? 5 : 0);
      cands.push({ source: "paapi_search", query: q, title, isbn13, asin, image, score });
    }

    const best = pickBest(cands, seriesKey);
    results.push({ query: q, ok: true, returned: items.length, best, rejected });
    await sleep(900);
  }

  const bests = results.map((x) => x.best).filter(Boolean);
  const best = pickBest(bests, seriesKey);
  return { tried: tries, results, best };
}

/* -----------------------
 * seed hint（任意）
 * ----------------------- */
function parseSeedHint(seed) {
  const vol1Isbn10 = norm(seed?.vol1Isbn10 || "");
  const vol1Isbn13 = norm(seed?.vol1Isbn13 || "");
  const vol1Asin = norm(seed?.vol1Asin || "");
  return {
    vol1Isbn10: vol1Isbn10 || null,
    vol1Isbn13: vol1Isbn13 || null,
    vol1Asin: vol1Asin || null,
  };
}

async function resolveBySeedHint({ seedHint, seriesKey }) {
  const debug = {
    used: true,
    hintAsin: seedHint.vol1Asin,
    hintIsbn10: seedHint.vol1Isbn10,
    hintIsbn13: seedHint.vol1Isbn13,
    resolvedBy: null,
    title: null,
    isbn13: null,
    asin: null,
  };

  if (seedHint.vol1Asin) {
    const pa = await paapiGetItems({ itemIds: [seedHint.vol1Asin] });
    debug.paapiGetAsin = pa;
    if (pa?.ok) {
      const item = pa?.json?.ItemsResult?.Items?.[0] || null;
      const title = extractTitle(item);
      const isbn13 = extractIsbn13(item);
      if (title && isbn13 && isMainlineVol1ByTitle(title, seriesKey)) {
        debug.resolvedBy = "getitems_asin";
        debug.title = title;
        debug.isbn13 = isbn13;
        debug.asin = seedHint.vol1Asin;
        return { ok: true, title, isbn13, asin: seedHint.vol1Asin, image: extractImage(item) || null, debug };
      }
    } else if (pa?.skipped) {
      return { ok: false, reason: `paapi_skipped(${pa.reason})`, debug };
    }
  }

  if (seedHint.vol1Isbn10) {
    const pa = await paapiGetItems({ itemIds: [seedHint.vol1Isbn10] });
    debug.paapiGet10 = pa;
    if (pa?.ok) {
      const item = pa?.json?.ItemsResult?.Items?.[0] || null;
      const title = extractTitle(item);
      const isbn13 = extractIsbn13(item);
      const asin = item?.ASIN || seedHint.vol1Isbn10;
      if (title && isbn13 && isMainlineVol1ByTitle(title, seriesKey)) {
        debug.resolvedBy = "getitems10";
        debug.title = title;
        debug.isbn13 = isbn13;
        debug.asin = asin;
        return { ok: true, title, isbn13, asin, image: extractImage(item) || null, debug };
      }
    } else if (pa?.skipped) {
      return { ok: false, reason: `paapi_skipped(${pa.reason})`, debug };
    }
  }

  if (seedHint.vol1Isbn13) {
    const s = await paapiSearchItems({ keywords: seedHint.vol1Isbn13 });
    debug.paapiSearch13 = s;
    if (s?.ok) {
      const items = s?.json?.SearchResult?.Items || [];
      const hit =
        items.find((it) => {
          const title = extractTitle(it);
          const isbn13 = extractIsbn13(it);
          return isbn13 === seedHint.vol1Isbn13 && isMainlineVol1ByTitle(title, seriesKey);
        }) || null;

      if (hit?.ASIN) {
        const g = await paapiGetItems({ itemIds: [hit.ASIN] });
        debug.paapiGetFrom13 = g;
        if (g?.ok) {
          const item = g?.json?.ItemsResult?.Items?.[0] || null;
          const title = extractTitle(item);
          const isbn13 = extractIsbn13(item);
          const asin = item?.ASIN || hit.ASIN;
          if (title && isbn13 && isMainlineVol1ByTitle(title, seriesKey)) {
            debug.resolvedBy = "isbn13_search_then_getitems";
            debug.title = title;
            debug.isbn13 = isbn13;
            debug.asin = asin;
            return { ok: true, title, isbn13, asin, image: extractImage(item) || null, debug };
          }
        }
      }
    } else if (s?.skipped) {
      return { ok: false, reason: `paapi_skipped(${s.reason})`, debug };
    }
  }

  return { ok: false, reason: "seed_hint_unresolved", debug };
}

/* -----------------------
 * merge helpers（積み上げ）
 * ----------------------- */
function mapBySeriesKey(items) {
  const m = new Map();
  for (const x of Array.isArray(items) ? items : []) {
    const k = norm(x?.seriesKey);
    if (!k) continue;
    if (!m.has(k)) m.set(k, x); // 先勝ち
  }
  return m;
}

/* -----------------------
 * main
 * ----------------------- */
async function main() {
  const seeds = await loadJson(SEEDS_PATH, { items: [] });
  const seedItemsAll = Array.isArray(seeds?.items) ? seeds.items : [];

  // 既存の積み上げを読む
  const prevSeries = await loadJson(OUT_SERIES, { items: [] });
  const prevTodo = await loadJson(OUT_TODO, { items: [] });
  const prevReview = await loadJson(OUT_REVIEW, { items: [] });

  const prevConfirmedMap = mapBySeriesKey(prevSeries?.items);
  const prevTodoMap = mapBySeriesKey(prevTodo?.items);
  const prevReviewMap = mapBySeriesKey(prevReview?.items);

  // ★review も「既処理」として扱う（毎回拾い直しを防ぐ）
  const known = new Set([...prevConfirmedMap.keys(), ...prevTodoMap.keys(), ...prevReviewMap.keys()]);

  // 今回やる seeds（未処理だけ + 上限）
  const pendingSeeds = [];
  for (const s of seedItemsAll) {
    const k = norm(s?.seriesKey);
    if (!k) continue;
    if (known.has(k)) continue;
    pendingSeeds.push(s);
    if (pendingSeeds.length >= BUILD_LIMIT) break;
  }

  const confirmedNew = [];
  const todoNew = [];
  const reviewNew = [];
  const debug = [];

  for (const s of pendingSeeds) {
    const seriesKey = norm(s?.seriesKey);
    const author = norm(s?.author) || null;
    if (!seriesKey) continue;

    const one = { seriesKey };

    // 1) seed hint があれば最優先
    const seedHint = parseSeedHint(s);
    const hasHint = !!(seedHint.vol1Asin || seedHint.vol1Isbn10 || seedHint.vol1Isbn13);
    if (hasHint) {
      one.seedHint = seedHint;
      const r = await resolveBySeedHint({ seedHint, seriesKey });
      one.seedHintResult = r?.ok ? { ok: true, debug: r.debug } : { ok: false, reason: r.reason, debug: r.debug };

      if (r?.ok) {
        const sub = detectSuspiciousSubtitle({ title: r.title, seriesKey });
        if (sub.suspicious) {
          const out = {
            seriesKey,
            author,
            reason: `suspicious_subtitle(${sub.reason})`,
            vol1: {
              title: r.title,
              isbn13: r.isbn13,
              asin: r.asin || null,
              image: r.image,
              amazonDp: dpPreferAsin({ asin: r.asin, isbn13: r.isbn13, isbn10: seedHint.vol1Isbn10 }),
              source: r.debug?.resolvedBy ? `seed_hint(${r.debug.resolvedBy})+mainline_guard` : "seed_hint+mainline_guard",
            },
          };
          reviewNew.push(out);
          one.path = "seed_hint_review";
          one.review = out;
          debug.push(one);
          await sleep(600);
          continue;
        }

        const out = {
          seriesKey,
          author,
          vol1: {
            title: r.title,
            isbn13: r.isbn13,
            asin: r.asin || null,
            image: r.image,
            amazonDp: dpPreferAsin({ asin: r.asin, isbn13: r.isbn13, isbn10: seedHint.vol1Isbn10 }),
            source: r.debug?.resolvedBy ? `seed_hint(${r.debug.resolvedBy})+mainline_guard` : "seed_hint+mainline_guard",
          },
        };
        confirmedNew.push(out);
        one.path = "seed_hint";
        one.confirmed = out;
        debug.push(one);
        await sleep(600);
        continue;
      }
    }

    // 2) PA-API search → best を決める
    const paSearch = await paapiSearchMainlineVol1({ seriesKey });
    one.paapiSearch = paSearch;

    const b = paSearch?.best;

    if (!b?.asin) {
      todoNew.push({
        seriesKey,
        author,
        reason: paSearch?.skipped ? `paapi_skipped(${paSearch.reason})` : "no_mainline_vol1_candidate",
        best: b || null,
      });
      debug.push(one);
      await sleep(600);
      continue;
    }

    const sub0 = detectSuspiciousSubtitle({ title: b.title || "", seriesKey });
    if (sub0.suspicious) {
      const out = {
        seriesKey,
        author,
        reason: `suspicious_subtitle(${sub0.reason})`,
        vol1: {
          title: b.title,
          isbn13: b.isbn13 || null,
          asin: b.asin || null,
          image: b.image || null,
          amazonDp: dpPreferAsin({ asin: b.asin, isbn13: b.isbn13 || null }),
          source: "paapi_search(mainline_guard)",
        },
      };
      reviewNew.push(out);
      one.path = "paapi_search_review";
      one.review = out;
      debug.push(one);
      await sleep(600);
      continue;
    }

    if (b.isbn13 && isMainlineVol1ByTitle(b.title || "", seriesKey)) {
      const out = {
        seriesKey,
        author,
        vol1: {
          title: b.title,
          isbn13: b.isbn13,
          asin: b.asin || null,
          image: b.image || null,
          amazonDp: dpPreferAsin({ asin: b.asin, isbn13: b.isbn13 }),
          source: "paapi_search(mainline_guard)",
        },
      };
      confirmedNew.push(out);
      one.path = "paapi_search_only";
      one.confirmed = out;
      debug.push(one);
      await sleep(600);
      continue;
    }

    const get = await paapiGetItems({ itemIds: [b.asin] });
    one.paapiGet = get;

    if (!get?.ok) {
      todoNew.push({
        seriesKey,
        author,
        reason: get?.skipped ? `paapi_skipped(${get.reason})` : `paapi_getitems_error(${get?.status ?? "unknown"})`,
        best: b,
      });
      debug.push(one);
      await sleep(600);
      continue;
    }

    const item = get?.json?.ItemsResult?.Items?.[0] || null;
    const title = extractTitle(item) || b.title || "";
    const isbn13 = extractIsbn13(item) || b.isbn13 || null;

    const sub1 = detectSuspiciousSubtitle({ title, seriesKey });
    if (sub1.suspicious) {
      const out = {
        seriesKey,
        author,
        reason: `suspicious_subtitle(${sub1.reason})`,
        vol1: {
          title,
          isbn13: isbn13 || null,
          asin: b.asin || null,
          image: extractImage(item) || b.image || null,
          amazonDp: dpPreferAsin({ asin: b.asin, isbn13: isbn13 || null }),
          source: "paapi_getitems(mainline_guard)",
        },
      };
      reviewNew.push(out);
      one.path = "paapi_getitems_review";
      one.review = out;
      debug.push(one);
      await sleep(600);
      continue;
    }

    if (!isMainlineVol1ByTitle(title, seriesKey) || !isbn13) {
      todoNew.push({
        seriesKey,
        author,
        reason: !isbn13 ? "paapi_getitems_no_ean" : "final_guard_failed",
        best: b,
      });
      debug.push(one);
      await sleep(600);
      continue;
    }

    const out = {
      seriesKey,
      author,
      vol1: {
        title,
        isbn13,
        asin: b.asin || null,
        image: extractImage(item) || b.image || null,
        amazonDp: dpPreferAsin({ asin: b.asin, isbn13 }),
        source: "paapi_getitems(mainline_guard)",
      },
    };
    confirmedNew.push(out);
    one.path = "paapi_getitems";
    one.confirmed = out;
    debug.push(one);

    await sleep(600);
  }

  // ---- 積み上げマージ（先勝ち：既存を壊さない）
  for (const x of confirmedNew) {
    const k = norm(x?.seriesKey);
    if (!k) continue;
    if (!prevConfirmedMap.has(k)) prevConfirmedMap.set(k, x);
  }
  for (const x of todoNew) {
    const k = norm(x?.seriesKey);
    if (!k) continue;
    if (!prevTodoMap.has(k)) prevTodoMap.set(k, x);
  }
  for (const x of reviewNew) {
    const k = norm(x?.seriesKey);
    if (!k) continue;
    if (!prevReviewMap.has(k)) prevReviewMap.set(k, x);
  }

  const confirmedAll = Array.from(prevConfirmedMap.values());
  const todoAll = Array.from(prevTodoMap.values());
  const reviewAll = Array.from(prevReviewMap.values());

  await saveJson(OUT_SERIES, {
    updatedAt: nowIso(),
    total: seedItemsAll.length,
    confirmed: confirmedAll.length,
    todo: todoAll.length,
    review: reviewAll.length,
    processedThisRun: pendingSeeds.length,
    buildLimit: BUILD_LIMIT,
    items: confirmedAll,
  });

  await saveJson(OUT_TODO, {
    updatedAt: nowIso(),
    total: todoAll.length,
    addedThisRun: todoNew.length,
    items: todoAll,
  });

  await saveJson(OUT_REVIEW, {
    updatedAt: nowIso(),
    total: reviewAll.length,
    addedThisRun: reviewNew.length,
    items: reviewAll,
  });

  await saveJson(OUT_DEBUG, {
    updatedAt: nowIso(),
    processedThisRun: pendingSeeds.length,
    items: debug,
  });

  console.log(
    `[lane2] seeds=${seedItemsAll.length} pending=${pendingSeeds.length} (+confirmed ${confirmedNew.length}, +todo ${todoNew.length}, +review ${reviewNew.length}) total_confirmed=${confirmedAll.length} total_todo=${todoAll.length} total_review=${reviewAll.length}`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
