// scripts/lane2/build_lane2.mjs
import fs from "node:fs/promises";
import crypto from "node:crypto";

const SEEDS_PATH = "data/lane2/seeds.json";
const OUT_SERIES = "data/lane2/series.json";
const OUT_TODO = "data/lane2/todo.json";
const OUT_DEBUG = "data/lane2/debug_candidates.json";

const AMAZON_ACCESS_KEY = process.env.AMAZON_ACCESS_KEY || "";
const AMAZON_SECRET_KEY = process.env.AMAZON_SECRET_KEY || "";
const AMAZON_PARTNER_TAG = process.env.AMAZON_PARTNER_TAG || "";

function nowIso() {
  return new Date().toISOString();
}

async function loadJson(path, fallback) {
  try {
    return JSON.parse(await fs.readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}
async function saveJson(path, obj) {
  await fs.mkdir(path.split("/").slice(0, -1).join("/"), { recursive: true });
  await fs.writeFile(path, JSON.stringify(obj, null, 2));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function norm(s) {
  return String(s ?? "").trim();
}

function isLikelySingleEpisode(title) {
  const t = norm(title);
  return (
    /第\s*\d+\s*話/.test(t) ||
    ((/\(\s*\d+\s*\)\s*$/.test(t) && /話/.test(t)) ?? false) ||
    /分冊|単話|話売り|Kindle版|電子版/.test(t)
  );
}

function isVol1Like(title) {
  const t = norm(title);
  return (
    /（\s*1\s*）/.test(t) ||
    /第\s*1\s*巻/.test(t) ||
    /Vol\.?\s*1/i.test(t) ||
    /(^|[^0-9])1([^0-9]|$)/.test(t)
  );
}

function pickBestCandidate(cands) {
  if (!cands.length) return null;
  cands.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  return cands[0];
}

function scoreCandidate({ title, isbn13 }) {
  let score = 0;
  const t = norm(title);
  if (!t) return 0;

  if (isbn13) score += 80;
  if (isVol1Like(t)) score += 30;

  // 「上」=巻1の可能性があるので弱い加点
  if (/\b(上|前編)\b/.test(t)) score += 5;

  // 単話っぽいのは大きく減点
  if (isLikelySingleEpisode(t)) score -= 60;

  // 派生版/別冊系を落とす
  if (/FULL\s*COLOR/i.test(t)) score -= 15;
  if (/総集編|公式ファンブック|特装版|限定版|ガイド|画集/.test(t)) score -= 40;

  return score;
}

/**
 * -----------------------
 * NDL Search (open) - SAFE
 * -----------------------
 * Atom(OpenSearch)を entry 単位でパースして title と ISBN を同じ entry から取得
 * ※ これが「同じISBNが全作品につく」バグを根絶する
 */
async function ndlSearchOpen({ seriesKey }) {
  const q = encodeURIComponent(`${seriesKey} 1`);
  const url = `https://ndlsearch.ndl.go.jp/api/opensearch?dpid=open&count=20&q=${q}`;

  const r = await fetch(url, {
    headers: { "user-agent": "tools-labo/book-scout lane2" },
  });
  if (!r.ok) throw new Error(`NDL HTTP ${r.status}`);
  const xml = await r.text();

  // entry単位で切る（Atom想定）
  const entries = [...xml.matchAll(/<entry\b[^>]*>[\s\S]*?<\/entry>/g)].map(
    (m) => m[0]
  );

  const cands = [];
  for (const e of entries) {
    // entry title
    const tm = e.match(/<title>([\s\S]*?)<\/title>/i);
    let title = tm ? tm[1] : "";
    title = title
      .replaceAll("&amp;", "&")
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">")
      .replaceAll("&quot;", '"')
      .replaceAll("&#39;", "'")
      .trim();

    if (!title) continue;

    // entry内の ISBN13（97[89]...）を抽出
    const im = e.match(/97[89]\d{10}/);
    const isbn13 = im ? im[0] : null;

    // entryのlink（あれば）
    const lm = e.match(/<link[^>]+href="([^"]+)"/i);
    const detailUrl = lm ? lm[1] : null;

    const score = scoreCandidate({ title, isbn13 });

    cands.push({
      source: "ndl_open",
      title,
      isbn13,
      score,
      detailUrl,
      reason: isbn13 ? "isbn_from_entry" : "no_isbn_in_entry",
    });
  }

  // 参考：feed全体で拾えるISBN（デバッグ用）
  const rawIsbns = [
    ...new Set([...xml.matchAll(/97[89]\d{10}/g)].map((m) => m[0])),
  ].slice(0, 10);

  return { query: `${seriesKey} 1`, url, candidates: cands, rawIsbns };
}

/**
 * -----------------------
 * Amazon PA-API (SearchItems)
 * -----------------------
 * 漏れがあった時のISBN拾い（確定後の画像はGetItemsでやる想定）
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
  if (!AMAZON_ACCESS_KEY || !AMAZON_SECRET_KEY || !AMAZON_PARTNER_TAG) {
    return { skipped: true, reason: "missing_paapi_secrets" };
  }

  const host = "webservices.amazon.co.jp";
  const region = "us-west-2";
  const service = "ProductAdvertisingAPI";
  const endpoint = `https://${host}/paapi5/searchitems`;

  const bodyObj = {
    Keywords: keywords,
    SearchIndex: "Books",
    ItemCount: 10,
    PartnerTag: AMAZON_PARTNER_TAG,
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
  const canonicalQuerystring = "";
  const canonicalHeaders =
    `content-encoding:amz-1.0\ncontent-type:application/json; charset=utf-8\nhost:${host}\nx-amz-date:${xAmzDate}\nx-amz-target:com.amazon.paapi5.v1.ProductAdvertisingAPIv1.SearchItems\n`;
  const signedHeaders = "content-encoding;content-type;host;x-amz-date;x-amz-target";
  const payloadHash = awsHash(body);

  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuerystring,
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

  const kDate = awsHmac(`AWS4${AMAZON_SECRET_KEY}`, dateStamp);
  const kRegion = awsHmac(kDate, region);
  const kService = awsHmac(kRegion, service);
  const kSigning = awsHmac(kService, "aws4_request");
  const signature = crypto
    .createHmac("sha256", kSigning)
    .update(stringToSign, "utf8")
    .digest("hex");

  const authorizationHeader =
    `${algorithm} Credential=${AMAZON_ACCESS_KEY}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const r = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-encoding": "amz-1.0",
      "content-type": "application/json; charset=utf-8",
      host,
      "x-amz-date": xAmzDate,
      "x-amz-target": "com.amazon.paapi5.v1.ProductAdvertisingAPIv1.SearchItems",
      Authorization: authorizationHeader,
    },
    body,
  });

  const text = await r.text();
  if (!r.ok) return { error: true, status: r.status, body: text.slice(0, 800) };
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

async function amazonFallback({ seriesKey }) {
  const tries = [`${seriesKey} 1`, `${seriesKey} （1）`];
  const all = [];

  for (const keywords of tries) {
    const res = await paapiSearchItems({ keywords });
    if (res?.skipped) return { skipped: true, reason: res.reason };
    if (res?.error) {
      all.push({ query: keywords, error: true, status: res.status, body: res.body });
      continue;
    }

    const items = res?.json?.SearchResult?.Items || [];
    for (const it of items) {
      const title = it?.ItemInfo?.Title?.DisplayValue || "";
      const asin = it?.ASIN || null;
      const isbn13 = extractIsbn13FromPaapiItem(it);
      const image = it?.Images?.Primary?.Large?.URL || null;
      const amazonDp = it?.DetailPageURL || null;

      const score = scoreCandidate({ title, isbn13 }) + (image ? 5 : 0);
      all.push({
        source: "amazon_paapi_search",
        query: keywords,
        title,
        asin,
        isbn13,
        image,
        amazonDp,
        score,
        reason: "paapi_search",
      });
    }

    await sleep(800);
  }

  const filtered = all.filter((c) => !isLikelySingleEpisode(c.title));
  return { candidates: filtered.length ? filtered : all, tried: tries };
}

/**
 * -----------------------
 * MAIN
 * -----------------------
 * 誤confirmed潰しの要点：
 * - NDLは「entry内でISBNが取れた」＋「タイトルが1巻っぽい」を必須にする
 *   （これで“適当なISBN拾って全部confirmed”が消える）
 */
async function main() {
  const seeds = await loadJson(SEEDS_PATH, { items: [] });
  const seedItems = Array.isArray(seeds?.items) ? seeds.items : [];

  const confirmed = [];
  const todo = [];
  const debug = [];

  for (const s of seedItems) {
    const seriesKey = norm(s?.seriesKey);
    if (!seriesKey) continue;

    // 1) NDL(open)
    let ndl = null;
    try {
      ndl = await ndlSearchOpen({ seriesKey });
    } catch (e) {
      ndl = { error: true, message: String(e?.message || e) };
    }

    const ndlCands = ndl?.candidates || [];
    const ndlBest = pickBestCandidate(ndlCands);

    // ★誤confirmed潰し：NDLは「ISBNあり」かつ「1巻っぽいタイトル」を必須
    const ndlOk =
      !!ndlBest?.isbn13 &&
      isVol1Like(ndlBest.title) &&
      !isLikelySingleEpisode(ndlBest.title) &&
      (ndlBest.score ?? 0) >= 110;

    if (ndlOk) {
      confirmed.push({
        seriesKey,
        author: norm(s?.author) || null,
        vol1: {
          title: ndlBest.title,
          isbn13: ndlBest.isbn13,
          image: null,    // 確定ISBN → PA-API GetItemsで後段
          amazonDp: null, // 同上
          source: "ndl_open",
        },
      });
      debug.push({ seriesKey, ndl });
      await sleep(300);
      continue;
    }

    // 2) 漏れは Amazon PA-API SearchItems で ISBN拾い
    const amz = await amazonFallback({ seriesKey });
    const amzCands = amz?.candidates || [];
    const amzBest = pickBestCandidate(amzCands);

    const best = amzBest || ndlBest || null;
    const bestScore = best?.score ?? 0;

    const amzOk =
      !!best?.isbn13 &&
      isVol1Like(best.title) &&
      !isLikelySingleEpisode(best.title) &&
      bestScore >= 110;

    if (amzOk) {
      confirmed.push({
        seriesKey,
        author: norm(s?.author) || null,
        vol1: {
          title: best.title,
          isbn13: best.isbn13,
          image: null, // 確定ISBN → PA-API GetItemsで後段
          amazonDp: best.amazonDp || null,
          source: best.source,
        },
      });
      debug.push({ seriesKey, ndl, amazon: { tried: amz?.tried, best: amzBest } });
    } else {
      todo.push({
        seriesKey,
        author: norm(s?.author) || null,
        reason: best
          ? `not_confirmed(score=${bestScore}, isbn13=${!!best?.isbn13})`
          : "no_candidate",
        best: best
          ? {
              source: best.source,
              score: bestScore,
              title: best.title || null,
              asin: best.asin || null,
              isbn13: best.isbn13 || null,
              query: best.query || (ndl?.query ?? null),
            }
          : null,
      });
      debug.push({ seriesKey, ndl, amazon: amz });
    }

    await sleep(400);
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

  console.log(`[lane2] seeds=${seedItems.length} confirmed=${confirmed.length} todo=${todo.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
