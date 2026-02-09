// scripts/lane2/build_lane2.mjs
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const SEEDS_PATH = "data/lane2/seeds.json";
const OUT_SERIES = "data/lane2/series.json";
const OUT_TODO = "data/lane2/todo.json";
const OUT_DEBUG = "data/lane2/debug_candidates.json";

const AMZ_ACCESS_KEY = process.env.AMZ_ACCESS_KEY || "";
const AMZ_SECRET_KEY = process.env.AMZ_SECRET_KEY || "";
const AMZ_PARTNER_TAG = process.env.AMZ_PARTNER_TAG || "";

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

/**
 * ✅ 半角化（重要）
 * - 全角数字/括弧/全角スペース
 * - ★全角英字(Ａ-Ｚａ-ｚ)も半角化 → EPISODE / FULL COLOR 事故が消える
 */
function toHalfWidth(s) {
  return String(s ?? "")
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[Ａ-Ｚａ-ｚ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[（]/g, "(")
    .replace(/[）]/g, ")")
    .replace(/[　]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function titleHasSeries(title, seriesKey) {
  const t = normLoose(title);
  const s = normLoose(seriesKey);
  if (!t || !s) return false;
  return t.includes(s);
}

/**
 * ✅ vol1判定（誤爆防止：単なる「1」だけは採用しない）
 * - (1) / （1） / 第1巻 / 1巻
 */
function isVol1Like(title) {
  const t = toHalfWidth(norm(title));
  if (!t) return false;

  if (/\(\s*1\s*\)/.test(t)) return true;
  if (/第\s*1\s*巻/.test(t)) return true;
  if (/(^|[^\d])1巻([^\d]|$)/.test(t)) return true;

  return false;
}

/**
 * ✅ 派生・周辺本を弾く
 */
function isDerivedEdition(title) {
  const raw = toHalfWidth(norm(title));
  const t = raw.toLowerCase();

  // セット類
  if (/全巻|巻セット|セット|box|ボックス|まとめ買い/.test(raw)) return true;

  // 作品外の本（キャラブック/ガイド等）
  if (/ファンブック|副読本|ガイド|ムック|設定資料|資料集|キャラクターブック|bible|図録|公式/.test(raw)) return true;

  // グッズ・周辺物（ポスター事故対策）
  if (/ポスター|ポスターコレクション|カレンダー|ポストカード|カード|シール|クリアファイル|グッズ/.test(raw)) return true;

  // 画集・イラスト系（画集(Vol.1)事故対策）
  if (/画集|原画集|イラストブック|イラスト集|アートブック|設定画|設定集/.test(raw)) return true;

  // 外伝/派生
  if (/episode|外伝|番外編|スピンオフ|side\s*story/.test(t)) return true;

  // 小説
  if (/小説|ノベライズ|文庫/.test(raw)) return true;

  // フルカラー
  if (/full\s*color|フルカラー|カラー|selection/.test(t)) return true;

  // 多言語/デラックス
  if (/バイリンガル|bilingual|デラックス|deluxe|英語版|翻訳/.test(raw)) return true;

  // 電子単話
  if (/単話|分冊|話売り|第\s*\d+\s*話/.test(raw)) return true;

  return false;
}

/**
 * ✅ “本線1巻” 判定（最終ガード）
 */
function isMainlineVol1(title, seriesKey) {
  const t = toHalfWidth(norm(title));
  const s = toHalfWidth(norm(seriesKey));
  if (!t || !s) return false;

  if (!titleHasSeries(t, s)) return false;
  if (!isVol1Like(t)) return false;
  if (isDerivedEdition(t)) return false;

  // シリーズ名の直後が EPISODE/外伝 なら本線じゃない
  const idx = t.indexOf(s);
  if (idx >= 0) {
    const rest = t.slice(idx + s.length);
    if (/^\s*[-ー–—]\s*(episode|外伝)/i.test(rest)) return false;
  }

  return true;
}

function scoreCandidate({ title, isbn13, seriesKey }) {
  let score = 0;
  const t = norm(title);
  if (!t) return 0;

  if (isbn13) score += 120; // ★ISBN13ありを強めに優遇（紙を勝たせる）
  if (seriesKey && titleHasSeries(t, seriesKey)) score += 40;
  if (isVol1Like(t)) score += 25;

  if (isDerivedEdition(t)) score -= 1000;
  if (seriesKey && isMainlineVol1(t, seriesKey)) score += 500;

  return score;
}

function pickBest(cands, seriesKey) {
  if (!cands.length) return null;

  const withIdx = cands.map((c, i) => ({ ...c, __i: i }));
  withIdx.sort((a, b) => {
    const sa = a.score ?? 0;
    const sb = b.score ?? 0;
    if (sb !== sa) return sb - sa;

    const am = seriesKey && isMainlineVol1(a.title || "", seriesKey) ? 1 : 0;
    const bm = seriesKey && isMainlineVol1(b.title || "", seriesKey) ? 1 : 0;
    if (bm !== am) return bm - am;

    // ★ISBN13あり優先
    const ai = a.isbn13 ? 1 : 0;
    const bi = b.isbn13 ? 1 : 0;
    if (bi !== ai) return bi - ai;

    const la = (a.title || "").length;
    const lb = (b.title || "").length;
    if (la !== lb) return la - lb;

    return a.__i - b.__i;
  });

  const { __i, ...best } = withIdx[0];
  return best;
}

function dpFromAsinOrIsbn(asinOrIsbn) {
  if (!asinOrIsbn) return null;
  const a = String(asinOrIsbn).trim();
  if (/^[A-Z0-9]{10}$/i.test(a)) return `https://www.amazon.co.jp/dp/${a.toUpperCase()}`;
  if (/^\d{10}$/.test(a)) return `https://www.amazon.co.jp/dp/${a}`;
  if (/^\d{13}$/.test(a)) return `https://www.amazon.co.jp/dp/${a}`;
  return null;
}

/* -----------------------
 * NDL OpenSearch
 * ----------------------- */
async function ndlOpensearch({ seriesKey }) {
  const dpid = "iss-ndl-opac";
  const q = encodeURIComponent(`${seriesKey} 1`);
  const url = `https://ndlsearch.ndl.go.jp/api/opensearch?dpid=${encodeURIComponent(dpid)}&cnt=20&q=${q}`;

  const r = await fetch(url, { headers: { "user-agent": "tools-labo/book-scout lane2" } });
  if (!r.ok) throw new Error(`NDL HTTP ${r.status}`);
  const xml = await r.text();

  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1]);

  const cands = [];
  let dropped = 0;
  const titleSamples = [];

  for (const block of items) {
    const title = (block.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? "")
      .replace(/&amp;/g, "&")
      .trim();

    if (title && titleSamples.length < 5) titleSamples.push(title);

    const isbn13 = (block.match(/(97[89]\d{10})/g) || [])[0] || null;

    if (!title) {
      dropped++;
      continue;
    }
    if (!titleHasSeries(title, seriesKey)) {
      dropped++;
      continue;
    }
    if (!isMainlineVol1(title, seriesKey)) {
      dropped++;
      continue;
    }

    const score = scoreCandidate({ title, isbn13, seriesKey });
    cands.push({ source: "ndl_opensearch", title, isbn13, score });
  }

  return { query: `${seriesKey} 1`, url, returned: items.length, candidates: cands, dropped, titleSamples };
}

/* -----------------------
 * PA-API
 * ----------------------- */
function awsHmac(key, data) {
  return crypto.createHmac("sha256", key).update(data, "utf8").digest();
}
function awsHash(data) {
  return crypto.createHash("sha256").update(data, "utf8").digest("hex");
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

async function paapiRequest({ target, pathUri, bodyObj }) {
  if (!AMZ_ACCESS_KEY || !AMZ_SECRET_KEY || !AMZ_PARTNER_TAG) {
    return { skipped: true, reason: "missing_paapi_secrets" };
  }

  const host = "webservices.amazon.co.jp";
  const region = "us-west-2";
  const service = "ProductAdvertisingAPI";
  const endpoint = `https://${host}${pathUri}`;
  const body = JSON.stringify(bodyObj);

  const { amzDate: xAmzDate, dateStamp } = amzDate();
  const method = "POST";
  const canonicalUri = pathUri;
  const canonicalQuerystring = "";
  const canonicalHeaders =
    `content-encoding:amz-1.0\ncontent-type:application/json; charset=utf-8\nhost:${host}\nx-amz-date:${xAmzDate}\nx-amz-target:${target}\n`;
  const signedHeaders = "content-encoding;content-type;host;x-amz-date;x-amz-target";
  const payloadHash = awsHash(body);

  const canonicalRequest = [method, canonicalUri, canonicalQuerystring, canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const algorithm = "AWS4-HMAC-SHA256";
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [algorithm, xAmzDate, credentialScope, awsHash(canonicalRequest)].join("\n");

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
  if (!r.ok) return { error: true, status: r.status, body: text.slice(0, 1400) };
  return { ok: true, json: JSON.parse(text) };
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

async function paapiGetItems({ asins }) {
  return paapiRequest({
    target: "com.amazon.paapi5.v1.ProductAdvertisingAPIv1.GetItems",
    pathUri: "/paapi5/getitems",
    bodyObj: {
      ItemIds: asins,
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
 * ✅ PA-API検索（紙を取りに行く）
 * - (1) / （1） / 1 に加えて
 * - 「コミックス」「単行本」「(少年〜コミックス)」みたいな“紙寄せ”ワードを追加
 */
async function paapiSearchMainlineVol1({ seriesKey }) {
  const tries = [
    `${seriesKey} (1)`,
    `${seriesKey}（1）`,
    `${seriesKey} 1`,
    `${seriesKey} 1 コミックス`,
    `${seriesKey} 1 単行本`,
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

    for (const it of items) {
      const title = extractTitle(it);
      const isbn13 = extractIsbn13(it);
      const asin = it?.ASIN || null;

      if (!titleHasSeries(title, seriesKey)) continue;
      if (!isMainlineVol1(title, seriesKey)) continue;

      // ★ISBN13が取れないものは候補に入れるが弱くする（紙がいれば必ず負ける）
      const score = scoreCandidate({ title, isbn13, seriesKey }) + (asin ? 5 : 0) + (isbn13 ? 200 : -200);

      cands.push({ source: "paapi_search", query: q, title, isbn13, asin, score });
    }

    const best = pickBest(cands, seriesKey);
    results.push({ query: q, ok: true, returned: items.length, best, candidatesAll: cands });
    await sleep(900);
  }

  const bests = results.map((x) => x.best).filter(Boolean);
  const best = pickBest(bests, seriesKey);
  return { tried: tries, results, best };
}

/* -----------------------
 * main
 * ----------------------- */
async function main() {
  const seeds = await loadJson(SEEDS_PATH, { items: [] });
  const seedItems = Array.isArray(seeds?.items) ? seeds.items : [];

  const confirmed = [];
  const todo = [];
  const debug = [];

  for (const s of seedItems) {
    const seriesKey = norm(s?.seriesKey);
    const author = norm(s?.author) || null;
    if (!seriesKey) continue;

    const one = { seriesKey };

    // 1) NDL（本線1巻だけ候補化）
    let ndl;
    try {
      ndl = await ndlOpensearch({ seriesKey });
    } catch (e) {
      ndl = { error: String(e?.message || e) };
    }
    one.ndl = ndl;

    const ndlBest = pickBest(ndl?.candidates || [], seriesKey);

    if (ndlBest) {
      const pa = await paapiSearchItems({ keywords: ndlBest.isbn13 || `${seriesKey} (1)` });
      one.paapiProbe = pa;

      let image = null;
      let isbn13 = ndlBest.isbn13 || null;
      let asin = null;

      if (pa?.ok) {
        const items = pa?.json?.SearchResult?.Items || [];
        const hit = items.find((it) => isMainlineVol1(extractTitle(it), seriesKey));
        if (hit) {
          asin = hit.ASIN || null;
          image = extractImage(hit) || null;
          isbn13 = extractIsbn13(hit) || isbn13;
        }
      }

      confirmed.push({
        seriesKey,
        author,
        vol1: {
          title: ndlBest.title,
          isbn13,
          image,
          amazonDp: dpFromAsinOrIsbn(asin || isbn13),
          source: "ndl(mainline_guard)+paapi_probe",
        },
      });
      debug.push(one);
      await sleep(600);
      continue;
    }

    // 2) NDLで取れない → PA-API（本線1巻だけ候補化）
    const paSearch = await paapiSearchMainlineVol1({ seriesKey });
    one.paapiSearch = paSearch;

    const b = paSearch?.best;
    if (!b?.asin) {
      todo.push({
        seriesKey,
        author,
        reason: paSearch?.skipped ? `paapi_skipped(${paSearch.reason})` : "no_mainline_vol1_candidate",
        best: b || null,
      });
      debug.push(one);
      await sleep(600);
      continue;
    }

    const get = await paapiGetItems({ asins: [b.asin] });
    one.paapiGet = get;

    if (!get?.ok) {
      todo.push({
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

    // 最終ガード（本線1巻のみ確定）
    if (!isMainlineVol1(title, seriesKey) || !isbn13) {
      todo.push({
        seriesKey,
        author,
        reason: !isbn13 ? "paapi_getitems_no_ean" : "final_guard_failed",
        best: b,
      });
      debug.push(one);
      await sleep(600);
      continue;
    }

    confirmed.push({
      seriesKey,
      author,
      vol1: {
        title,
        isbn13,
        image: extractImage(item) || null,
        amazonDp: dpFromAsinOrIsbn(b.asin),
        source: "paapi(mainline_guard)",
      },
    });
    debug.push(one);
    await sleep(600);
  }

  await saveJson(OUT_SERIES, {
    updatedAt: nowIso(),
    total: seedItems.length,
    confirmed: confirmed.length,
    todo: todo.length,
    items: confirmed,
  });
  await saveJson(OUT_TODO, {
    updatedAt: nowIso(),
    total: todo.length,
    items: todo,
  });
  await saveJson(OUT_DEBUG, {
    updatedAt: nowIso(),
    items: debug,
  });

  console.log(`[lane2] seeds=${seedItems.length} confirmed=${confirmed.length} todo=${todo.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
