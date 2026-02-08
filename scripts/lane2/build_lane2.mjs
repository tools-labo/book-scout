// scripts/lane2/build_lane2.mjs
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const SEEDS_PATH = "data/lane2/seeds.json";
const OUT_SERIES = "data/lane2/series.json";
const OUT_TODO = "data/lane2/todo.json";
const OUT_DEBUG = "data/lane2/debug_candidates.json";

// ★ env 名はユーザー指定の AMZ_ に統一
const AMZ_ACCESS_KEY = process.env.AMZ_ACCESS_KEY || "";
const AMZ_SECRET_KEY = process.env.AMZ_SECRET_KEY || "";
const AMZ_PARTNER_TAG = process.env.AMZ_PARTNER_TAG || "";

function nowIso() {
  return new Date().toISOString();
}
function norm(s) {
  return String(s ?? "").trim();
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

function isLikelySingleEpisode(title) {
  const t = norm(title);
  return (
    /第\s*\d+\s*話/.test(t) ||
    /分冊|単話|話売り|Kindle版|電子版/.test(t)
  );
}
function isVol1Like(title) {
  const t = norm(title);
  return (
    /（\s*1\s*）/.test(t) ||
    /第\s*1\s*巻/.test(t) ||
    /\bvol\.?\s*1\b/i.test(t) ||
    // 「 1 」単独一致（ただし数字連結を避ける）
    /(^|[^0-9])1([^0-9]|$)/.test(t)
  );
}

function scoreCandidate({ title, isbn13 }) {
  let score = 0;
  const t = norm(title);
  if (!t) return 0;

  if (isbn13) score += 80;
  if (isVol1Like(t)) score += 30;

  if (/\b(上|前編)\b/.test(t)) score += 5;

  if (isLikelySingleEpisode(t)) score -= 60;
  if (/FULL\s*COLOR/i.test(t)) score -= 15;
  if (/総集編|公式ファンブック|特装版|限定版|ガイド|画集/.test(t)) score -= 40;

  return score;
}

function pickBestCandidate(cands) {
  if (!cands.length) return null;
  cands.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  return cands[0];
}

/**
 * -----------------------
 * NDL OpenSearch (申請不要枠)
 * -----------------------
 * 重要：<item>ごとに title と isbn を紐付けて拾う
 */
function extractItemsFromRss(xml) {
  // 雑でOK：<item>...</item> を抜く（OpenSearchはRSS風）
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml))) items.push(m[1]);
  return items;
}

function extractTagText(block, tag) {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = block.match(re);
  if (!m) return null;
  return m[1]
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

function extractIsbn13FromText(t) {
  if (!t) return null;
  const m = String(t).match(/97[89]\d{10}/);
  return m ? m[0] : null;
}

async function ndlSearchOpen({ seriesKey }) {
  const q = encodeURIComponent(`${seriesKey} 1`);
  const url = `https://ndlsearch.ndl.go.jp/api/opensearch?dpid=open&count=20&q=${q}`;

  const r = await fetch(url, {
    headers: { "user-agent": "tools-labo/book-scout lane2" },
  });
  if (!r.ok) throw new Error(`NDL HTTP ${r.status}`);
  const xml = await r.text();

  const itemBlocks = extractItemsFromRss(xml);
  const cands = [];

  for (const b of itemBlocks.slice(0, 20)) {
    const title = extractTagText(b, "title");
    if (!title) continue;

    // itemブロック内からISBNを拾う（dc:identifier等に混ざる）
    const isbn13 =
      extractIsbn13FromText(b) || extractIsbn13FromText(title) || null;

    const score = scoreCandidate({ title, isbn13 });

    cands.push({
      source: "ndl_open",
      query: `${seriesKey} 1`,
      title,
      isbn13,
      score,
      reason: isbn13 ? "isbn_in_item" : "no_isbn_in_item",
      detailUrl: extractTagText(b, "link") || null,
    });
  }

  return { query: `${seriesKey} 1`, url, candidates: cands };
}

/**
 * -----------------------
 * Amazon PA-API (SearchItems) - 検証用
 * -----------------------
 * 「ISBNで検索 → ExternalIds.ISBNが同じ」なら “確定”
 */
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
  return {
    amzDate: `${y}${m}${day}T${hh}${mm}${ss}Z`,
    dateStamp: `${y}${m}${day}`,
  };
}

async function paapiSearchItems({ keywords }) {
  if (!AMZ_ACCESS_KEY || !AMZ_SECRET_KEY || !AMZ_PARTNER_TAG) {
    return { skipped: true, reason: "missing_paapi_secrets" };
  }

  const host = "webservices.amazon.co.jp";
  const region = "us-west-2";
  const service = "ProductAdvertisingAPI";
  const endpoint = `https://${host}/paapi5/searchitems`;

  const bodyObj = {
    Keywords: keywords,
    SearchIndex: "Books",
    ItemCount: 5,
    PartnerTag: AMZ_PARTNER_TAG,
    PartnerType: "Associates",
    Resources: [
      "ItemInfo.Title",
      "ItemInfo.ExternalIds",
      "DetailPageURL",
      "Images.Primary.Large",
    ],
  };
  const body = JSON.stringify(bodyObj);

  const { amzDate: xAmzDate, dateStamp } = amzDate();

  const method = "POST";
  const canonicalUri = "/paapi5/searchitems";
  const canonicalHeaders =
    `content-encoding:amz-1.0\ncontent-type:application/json; charset=utf-8\nhost:${host}\nx-amz-date:${xAmzDate}\nx-amz-target:com.amazon.paapi5.v1.ProductAdvertisingAPIv1.SearchItems\n`;
  const signedHeaders =
    "content-encoding;content-type;host;x-amz-date;x-amz-target";
  const payloadHash = awsHash(body);

  const canonicalRequest = [
    method,
    canonicalUri,
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const algorithm = "AWS4-HMAC-SHA256";
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    algorithm,
    xAmzDate,
    credentialScope,
    awsHash(canonicalRequest),
  ].join("\n");

  const kDate = awsHmac(`AWS4${AMZ_SECRET_KEY}`, dateStamp);
  const kRegion = awsHmac(kDate, region);
  const kService = awsHmac(kRegion, service);
  const kSigning = awsHmac(kService, "aws4_request");
  const signature = crypto
    .createHmac("sha256", kSigning)
    .update(stringToSign, "utf8")
    .digest("hex");

  const authorizationHeader =
    `${algorithm} Credential=${AMZ_ACCESS_KEY}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const r = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-encoding": "amz-1.0",
      "content-type": "application/json; charset=utf-8",
      host,
      "x-amz-date": xAmzDate,
      "x-amz-target":
        "com.amazon.paapi5.v1.ProductAdvertisingAPIv1.SearchItems",
      Authorization: authorizationHeader,
    },
    body,
  });

  const text = await r.text();
  if (!r.ok) {
    return { error: true, status: r.status, body: text.slice(0, 1200) };
  }
  return { ok: true, json: JSON.parse(text) };
}

function extractIsbn13FromPaapiItem(item) {
  const vals = item?.ItemInfo?.ExternalIds?.ISBN?.DisplayValues;
  if (Array.isArray(vals) && vals.length) {
    const v = String(vals[0]).replace(/[^0-9X]/gi, "");
    if (/^97[89]\d{10}$/.test(v)) return v;
  }
  return null;
}

function scoreAmzItem(title, isbn13) {
  // Amazon側は「ISBNが付いてる」ことに強く寄せる
  let s = scoreCandidate({ title, isbn13 });
  if (isbn13) s += 10;
  return s;
}

async function amazonVerifyByIsbn({ isbn13 }) {
  const res = await paapiSearchItems({ keywords: isbn13 });
  if (res?.skipped) return { skipped: true, reason: res.reason };
  if (res?.error) return { error: true, status: res.status, body: res.body };

  const items = res?.json?.SearchResult?.Items || [];
  const cands = [];

  for (const it of items) {
    const title = it?.ItemInfo?.Title?.DisplayValue || "";
    const asin = it?.ASIN || null;
    const foundIsbn13 = extractIsbn13FromPaapiItem(it);
    const image = it?.Images?.Primary?.Large?.URL || null;
    const amazonDp = it?.DetailPageURL || null;

    cands.push({
      source: "amazon_paapi_isbn",
      query: isbn13,
      title,
      asin,
      isbn13: foundIsbn13,
      image,
      amazonDp,
      score: scoreAmzItem(title, foundIsbn13),
    });
  }

  const best = pickBestCandidate(cands);
  return { ok: true, candidates: cands, best };
}

/**
 * -----------------------
 * main
 * -----------------------
 * 確定条件（安全側）：
 *  - NDL itemから「巻1らしいtitle + isbn13」を取る
 *  - そのisbn13でPA-API検索し、同じisbn13が返ったら confirmed
 */
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

    // 1) NDL
    let ndl;
    try {
      ndl = await ndlSearchOpen({ seriesKey });
    } catch (e) {
      ndl = { error: true, message: String(e?.message || e) };
    }

    const ndlCands = ndl?.candidates || [];
    // 単話系は候補から落とす
    const ndlFiltered = ndlCands.filter((c) => !isLikelySingleEpisode(c.title));
    const ndlBest = pickBestCandidate(ndlFiltered.length ? ndlFiltered : ndlCands);

    const ndlIsbn = ndlBest?.isbn13 || null;

    // 2) PA-APIでISBN検証
    let amz = null;
    let paapiIsbn = null;
    let match = false;
    let bestAmz = null;

    if (ndlIsbn) {
      amz = await amazonVerifyByIsbn({ isbn13: ndlIsbn });
      bestAmz = amz?.best || null;
      paapiIsbn = bestAmz?.isbn13 || null;
      match = !!(paapiIsbn && paapiIsbn === ndlIsbn);
    } else {
      amz = { skipped: true, reason: "ndl_no_isbn" };
    }

    // --- 判定（強い安全策） ---
    if (ndlIsbn && match) {
      confirmed.push({
        seriesKey,
        author,
        vol1: {
          title: ndlBest?.title || seriesKey,
          isbn13: ndlIsbn,
          // 画像/リンクはPA-API側ベストから採用（=クリーン）
          image: bestAmz?.image || null,
          amazonDp: bestAmz?.amazonDp || null,
          source: "ndl_open+paapi_isbn_match",
        },
      });
    } else {
      const score = (ndlBest?.score ?? 0) + (match ? 50 : 0);

      todo.push({
        seriesKey,
        author,
        reason: `not_confirmed(score=${score}, ndlIsbn=${!!ndlIsbn}, paapiIsbn=${!!paapiIsbn}, match=${match})`,
        best: {
          score,
          // ★ ここを埋める：何が取れたかが後で追えるようにする
          title: ndlBest?.title || bestAmz?.title || null,
          asin: bestAmz?.asin || null,
          isbn13: ndlIsbn || paapiIsbn || null,
          query: ndl?.query || `${seriesKey} 1`,
          ndlIsbn: ndlIsbn,
          paapiIsbn: paapiIsbn,
          paapiError: amz?.error ? { status: amz.status, body: amz.body } : null,
          paapiSkipped: amz?.skipped ? amz.reason : null,
        },
      });
    }

    debug.push({
      seriesKey,
      author,
      ndl,
      amazon: amz,
      picked: {
        ndlBest,
        amazonBest: bestAmz,
        ndlIsbn,
        paapiIsbn,
        match,
      },
    });

    await sleep(350);
  }

  const outSeries = {
    updatedAt: nowIso(),
    total: seedItems.length,
    confirmed: confirmed.length,
    todo: todo.length,
    items: confirmed,
  };
  const outTodo = {
    updatedAt: nowIso(),
    total: todo.length,
    items: todo,
  };

  await saveJson(OUT_SERIES, outSeries);
  await saveJson(OUT_TODO, outTodo);
  await saveJson(OUT_DEBUG, { updatedAt: nowIso(), items: debug });

  console.log(
    `[lane2] seeds=${seedItems.length} confirmed=${confirmed.length} todo=${todo.length}`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
