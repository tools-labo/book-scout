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
 * 全角→半角（数字・括弧・スペース）を軽く正規化
 * 目的： （１） を (1) と同等に扱う
 */
function z2hBasic(str) {
  const s = norm(str);
  return s
    // 全角数字
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    // 全角括弧
    .replace(/（/g, "(")
    .replace(/）/g, ")")
    // 全角スペース
    .replace(/\u3000/g, " ");
}

/** -----------------------
 * title heuristics
 * ---------------------- */
function isLikelySingleEpisode(title) {
  const t = z2hBasic(title);
  return (
    /第\s*\d+\s*話/.test(t) ||
    /分冊|単話|話売り/.test(t) ||
    /Kindle版|電子版|デジタル版/.test(t)
  );
}
function isSetLike(title) {
  const t = z2hBasic(title);
  return /(\d+\s*-\s*\d+巻)|(\d+巻\s*セット)|(巻\s*セット)|新品セット|セット|まとめ売り/.test(t);
}
function isExtraBookLike(title) {
  const t = z2hBasic(title);
  return /総集編|公式ファンブック|特装版|限定版|ガイド|画集|副読本|ポスター|キャラクターブック|ムック|図録/i.test(t);
}
function isVol1Like(title) {
  const t = z2hBasic(title);

  // (1) / （１）→正規化で(1)になる
  if (/\(\s*1\s*\)/.test(t)) return true;

  // 1巻/第1巻
  if (/第\s*1\s*巻/.test(t)) return true;
  if (/(^|[^0-9])1\s*巻/.test(t)) return true;

  // Vol.1
  if (/Vol\.?\s*1/i.test(t)) return true;

  return false;
}

function scoreCandidate({ title, isbn13, seriesKey, author, creator, asin }) {
  let score = 0;
  const t = z2hBasic(title);
  if (!t) return 0;

  // 紙の本(ASIN=ISBN10の10桁数字)を強く優先
  if (asin && /^\d{10}$/.test(String(asin))) score += 80;
  if (asin && /^B[0-9A-Z]{9}$/.test(String(asin))) score -= 60; // Kindle等を落とす

  if (isbn13) score += 70;

  if (seriesKey && normLoose(z2hBasic(t)).includes(normLoose(z2hBasic(seriesKey)))) score += 30;

  if (isVol1Like(t)) score += 40;

  if (author && creator) {
    const a = normLoose(z2hBasic(author));
    const c = normLoose(z2hBasic(creator));
    if (a && c && c.includes(a)) score += 15;
  }

  if (isLikelySingleEpisode(t)) score -= 120;
  if (isSetLike(t)) score -= 160;
  if (isExtraBookLike(t)) score -= 80;
  if (/FULL\s*COLOR|フルカラー|バイリンガル/i.test(t)) score -= 25;

  return score;
}
function pickBest(cands) {
  if (!cands.length) return null;
  cands.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  return cands[0];
}

/** -----------------------
 * NDL OpenSearch（現状ノイズが多いので、ここは「補助」扱い）
 * ---------------------- */
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
    const t = (block.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? "")
      .replace(/&amp;/g, "&")
      .trim();

    if (t && titleSamples.length < 5) titleSamples.push(t);

    const creator = (block.match(/<(dc:creator|creator)>([\s\S]*?)<\/\1>/i)?.[2] ?? "").trim();
    const isbn13 = (block.match(/97[89]\d{10}/g) || [])[0] || null;

    const tt = z2hBasic(t);

    if (!tt || isLikelySingleEpisode(tt) || isSetLike(tt)) {
      dropped++;
      continue;
    }

    const hasSeries = normLoose(z2hBasic(tt)).includes(normLoose(z2hBasic(seriesKey)));
    if (!hasSeries) {
      dropped++;
      continue;
    }

    cands.push({
      source: "ndl_opensearch",
      title: t,
      creator: creator || null,
      isbn13,
      score: scoreCandidate({ title: t, isbn13, seriesKey, author: null, creator, asin: null }),
    });
  }

  return { query: `${seriesKey} 1`, url, returned: items.length, candidates: cands, dropped, titleSamples };
}

/** -----------------------
 * Amazon PA-API signed fetch
 * ---------------------- */
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

async function paapiSignedFetch({ apiPath, bodyObj, opName }) {
  if (!AMZ_ACCESS_KEY || !AMZ_SECRET_KEY || !AMZ_PARTNER_TAG) {
    return { skipped: true, reason: "missing_paapi_secrets" };
  }

  const host = "webservices.amazon.co.jp";
  const region = "us-west-2";
  const service = "ProductAdvertisingAPI";
  const endpoint = `https://${host}${apiPath}`;

  const body = JSON.stringify(bodyObj);

  const { amzDate: xAmzDate, dateStamp } = amzDate();
  const method = "POST";
  const canonicalUri = apiPath;
  const canonicalQuerystring = "";
  const canonicalHeaders =
    `content-encoding:amz-1.0\ncontent-type:application/json; charset=utf-8\nhost:${host}\nx-amz-date:${xAmzDate}\nx-amz-target:com.amazon.paapi5.v1.ProductAdvertisingAPIv1.${opName}\n`;
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
      "x-amz-target": `com.amazon.paapi5.v1.ProductAdvertisingAPIv1.${opName}`,
      Authorization: authorizationHeader,
    },
    body,
  });

  const text = await r.text();
  if (!r.ok) return { error: true, status: r.status, body: text.slice(0, 1500) };
  return { ok: true, json: JSON.parse(text) };
}

async function paapiSearchItems({ keywords }) {
  const bodyObj = {
    Keywords: keywords,
    SearchIndex: "Books",
    ItemCount: 10,
    PartnerTag: AMZ_PARTNER_TAG,
    PartnerType: "Associates",
    Resources: [
      "ItemInfo.Title",
      "ItemInfo.ExternalIds",
      "ItemInfo.ByLineInfo",
      "Images.Primary.Large",
    ],
  };
  return paapiSignedFetch({ apiPath: "/paapi5/searchitems", bodyObj, opName: "SearchItems" });
}

async function paapiGetItems({ asin }) {
  const bodyObj = {
    ItemIds: [asin],
    PartnerTag: AMZ_PARTNER_TAG,
    PartnerType: "Associates",
    // DetailPageURL は Resources に入れない（勝手に返る）
    Resources: [
      "ItemInfo.Title",
      "ItemInfo.ExternalIds",
      "ItemInfo.ByLineInfo",
      "Images.Primary.Large",
    ],
  };
  return paapiSignedFetch({ apiPath: "/paapi5/getitems", bodyObj, opName: "GetItems" });
}

/** -----------------------
 * ExternalIds parsing
 * ---------------------- */
function isbn10to13(isbn10) {
  const s = String(isbn10 || "").replace(/[^0-9X]/gi, "");
  if (!/^\d{9}[\dX]$/i.test(s)) return null;

  const core = `978${s.slice(0, 9)}`; // 12桁
  let sum = 0;
  for (let i = 0; i < core.length; i++) {
    const n = Number(core[i]);
    sum += i % 2 === 0 ? n : n * 3;
  }
  const cd = (10 - (sum % 10)) % 10;
  return `${core}${cd}`;
}

function extractIsbn13(item) {
  const eans = item?.ItemInfo?.ExternalIds?.EANs?.DisplayValues;
  if (Array.isArray(eans) && eans.length) {
    const v = String(eans[0]).replace(/[^0-9]/g, "");
    if (/^97[89]\d{10}$/.test(v)) return v;
  }

  const isbns = item?.ItemInfo?.ExternalIds?.ISBNs?.DisplayValues;
  if (Array.isArray(isbns) && isbns.length) {
    const raw = String(isbns[0]).replace(/[^0-9X]/gi, "");
    if (/^97[89]\d{10}$/.test(raw)) return raw;
    if (/^\d{9}[\dX]$/i.test(raw)) return isbn10to13(raw);
  }

  return null;
}

function extractTitle(item) {
  return item?.ItemInfo?.Title?.DisplayValue || "";
}
function extractImage(item) {
  return item?.Images?.Primary?.Large?.URL || null;
}
function extractDetailUrl(item) {
  return item?.DetailPageURL || null;
}

/** -----------------------
 * PA-API search vol1
 * ---------------------- */
async function paapiSearchVol1({ seriesKey, author }) {
  const tries = [
    `${seriesKey} 1`,
    `${seriesKey} （1）`,
    `${seriesKey} 1 コミックス`,
    author ? `${seriesKey} 1 ${author}` : null,
  ].filter(Boolean);

  const results = [];

  for (const q of tries) {
    const res = await paapiSearchItems({ keywords: q });
    if (res?.skipped) return { skipped: true, reason: res.reason };

    if (res?.error) {
      results.push({ query: q, ok: false, status: res.status, body: res.body });
      continue;
    }

    const items = res?.json?.SearchResult?.Items || [];
    let best = null;
    const candidatesAll = [];

    for (const it of items) {
      const title = extractTitle(it);
      const asin = it?.ASIN || null;
      const isbn13 = extractIsbn13(it);

      // シリーズ名必須（全角も吸収）
      if (!normLoose(z2hBasic(title)).includes(normLoose(z2hBasic(seriesKey)))) continue;

      // まずノイズ落とし
      if (isLikelySingleEpisode(title)) continue;
      if (isSetLike(title)) continue;
      if (isExtraBookLike(title)) continue;

      // 1巻判定は必須（副読本を除外する主砦）
      if (!isVol1Like(title)) continue;

      const score = scoreCandidate({ title, isbn13, seriesKey, author, creator: null, asin });
      const cand = { source: "paapi_search", query: q, title, asin, isbn13, score };
      candidatesAll.push(cand);

      if (!best || cand.score > best.score) best = cand;
    }

    results.push({ query: q, ok: true, returned: items.length, best, candidatesAll });
    await sleep(900);
  }

  const bests = results.map((x) => x.best).filter(Boolean);
  const best = pickBest(bests);

  return { tried: tries, results, best };
}

/** -----------------------
 * main
 * ---------------------- */
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

    // NDL（補助）
    let ndl;
    try {
      ndl = await ndlOpensearch({ seriesKey, author });
    } catch (e) {
      ndl = { error: String(e?.message || e) };
    }
    one.ndl = ndl;

    // PA-API 検索
    const paSearch = await paapiSearchVol1({ seriesKey, author });
    one.paapiSearch = paSearch;

    const b = paSearch?.best;
    if (b?.asin) {
      const paGet = await paapiGetItems({ asin: b.asin });
      one.paapiGet = paGet;

      if (paGet?.ok) {
        const item = paGet?.json?.ItemsResult?.Items?.[0];
        const isbn13 = extractIsbn13(item);
        const title = extractTitle(item);
        const image = extractImage(item);
        const amazonDp = extractDetailUrl(item);

        const titleOk =
          normLoose(z2hBasic(title)).includes(normLoose(z2hBasic(seriesKey))) &&
          isVol1Like(title) &&
          !isLikelySingleEpisode(title) &&
          !isSetLike(title) &&
          !isExtraBookLike(title);

        // 紙の本（10桁数字ASIN）を原則要求：Kindleに引っ張られてISBN取れないのを防ぐ
        const physicalOk = /^\d{10}$/.test(String(b.asin));

        if (isbn13 && titleOk && physicalOk) {
          confirmed.push({
            seriesKey,
            author,
            vol1: {
              title,
              isbn13,
              image: image || null,
              amazonDp: amazonDp || null,
              source: "paapi_search+getitems",
            },
          });
          debug.push(one);
          await sleep(600);
          continue;
        }
      }
    }

    todo.push({
      seriesKey,
      author,
      reason: paSearch?.skipped ? `paapi_skipped(${paSearch.reason})` : "no_confirmed_isbn",
      best: b
        ? { source: "paapi_search", score: b.score ?? 0, title: b.title ?? null, asin: b.asin ?? null, isbn13: b.isbn13 ?? null, query: b.query ?? null }
        : { source: "none", score: 0, title: null, asin: null, isbn13: null, query: null },
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
