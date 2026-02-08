// scripts/lane2/build_lane2.mjs
import crypto from "node:crypto";
import { loadJson, saveJson, nowIso, norm } from "./util.mjs";

const SEEDS_PATH = "data/lane2/seeds.json";
const OUT_SERIES = "data/lane2/series.json";
const OUT_TODO = "data/lane2/todo.json";
const OUT_DEBUG = "data/lane2/debug_candidates.json";

const AMAZON_ACCESS_KEY = process.env.AMAZON_ACCESS_KEY || "";
const AMAZON_SECRET_KEY = process.env.AMAZON_SECRET_KEY || "";
const AMAZON_PARTNER_TAG = process.env.AMAZON_PARTNER_TAG || "";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function hasPaapi() {
  return !!(AMAZON_ACCESS_KEY && AMAZON_SECRET_KEY && AMAZON_PARTNER_TAG);
}

function isLikelySingleEpisode(title) {
  const t = norm(title);
  return (
    /第\s*\d+\s*話/.test(t) ||
    (/(\(\s*\d+\s*\)\s*$)/.test(t) && /話/.test(t)) ||
    /分冊|単話|話売り|Kindle版|電子版/.test(t)
  );
}

function isVol1Like(title) {
  const t = norm(title);
  return (
    /（\s*1\s*）/.test(t) ||
    /第\s*1\s*巻/.test(t) ||
    /Vol\.?\s*1/i.test(t) ||
    // “ 1 ” が他の数字とくっついてないこと（雑だけど強め）
    /(^|[^0-9])1([^0-9]|$)/.test(t)
  );
}

function scoreCandidate({ seriesKey, title, isbn13 }) {
  let score = 0;
  const t = norm(title);
  if (!t) return 0;

  // “シリーズ名が含まれる”を強めに評価
  if (t.includes(seriesKey)) score += 60;

  // ISBNが取れてるのは超重要
  if (isbn13) score += 80;

  // 1巻っぽさ
  if (isVol1Like(t)) score += 30;

  // ノイズを落とす
  if (isLikelySingleEpisode(t)) score -= 80;
  if (/FULL\s*COLOR/i.test(t)) score -= 25;
  if (/総集編|公式ファンブック|特装版|限定版|ガイド|画集/.test(t)) score -= 60;
  if (/OpenSearch/i.test(t) || /国立国会図書館サーチ/i.test(t)) score -= 200; // ←今回の事故タイトルを確実に落とす

  return score;
}

function pickBest(cands) {
  if (!cands.length) return null;
  cands.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  return cands[0];
}

/**
 * -----------------------
 * NDL OpenSearch（申請不要枠）
 * 重要：entry/item単位で title と ISBN を結び付ける
 * -----------------------
 */
function extractIsbn13sFromText(s) {
  return [...String(s || "").matchAll(/97[89]\d{10}/g)].map((m) => m[0]);
}

// Atom(<entry>) / RSS(<item>) 両対応の“雑だけど安全寄り”パース
function parseEntriesFromOpenSearchXml(xml) {
  const out = [];

  const entryBlocks = [...xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/g)].map((m) => m[1]);
  const itemBlocks = [...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/g)].map((m) => m[1]);

  const blocks = entryBlocks.length ? entryBlocks : itemBlocks;

  for (const b of blocks) {
    const titleMatch = b.match(/<title>([\s\S]*?)<\/title>/i);
    const titleRaw = titleMatch ? titleMatch[1] : "";
    const title = titleRaw
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .trim();

    // identifierっぽいところ全体からISBN拾う
    const isbn13s = extractIsbn13sFromText(b);
    const uniq = [...new Set(isbn13s)];

    out.push({ title, isbn13s: uniq });
  }

  return out;
}

async function ndlSearchOpen({ seriesKey }) {
  const q = encodeURIComponent(`${seriesKey} 1`);
  const url = `https://ndlsearch.ndl.go.jp/api/opensearch?dpid=open&count=20&q=${q}`;

  const r = await fetch(url, { headers: { "user-agent": "tools-labo/book-scout lane2" } });
  if (!r.ok) throw new Error(`NDL HTTP ${r.status}`);

  const xml = await r.text();
  const entries = parseEntriesFromOpenSearchXml(xml);

  const candidates = [];
  for (const e of entries) {
    // entryごとにISBN紐付け（複数あるなら最初の1つを候補にするが、スコアで落とす）
    const isbn13 = e.isbn13s[0] || null;
    const title = e.title;

    if (!title) continue;

    const score = scoreCandidate({ seriesKey, title, isbn13 });
    candidates.push({
      source: "ndl_open",
      title,
      isbn13,
      score,
      reason: isbn13 ? "isbn_in_same_entry" : "no_isbn_in_entry",
    });
  }

  return { query: `${seriesKey} 1`, url, candidates, entriesSample: entries.slice(0, 5) };
}

/**
 * -----------------------
 * Amazon PA-API（SearchItems）
 * - “ISBNで検索して一致確認”に使う
 * - 画像もここで取れる（PA-API経由なのでクリーン）
 * -----------------------
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
  if (!hasPaapi()) {
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
  const canonicalHeaders =
    `content-encoding:amz-1.0\ncontent-type:application/json; charset=utf-8\nhost:${host}\nx-amz-date:${xAmzDate}\nx-amz-target:com.amazon.paapi5.v1.ProductAdvertisingAPIv1.SearchItems\n`;
  const signedHeaders = "content-encoding;content-type;host;x-amz-date;x-amz-target";
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

  const kDate = awsHmac(`AWS4${AMAZON_SECRET_KEY}`, dateStamp);
  const kRegion = awsHmac(kDate, region);
  const kService = awsHmac(kRegion, service);
  const kSigning = awsHmac(kService, "aws4_request");
  const signature = crypto.createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");

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
  if (!r.ok) {
    return { error: true, status: r.status, body: text.slice(0, 800) };
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

function dpUrlFromDetailPageURL(url) {
  return url || null;
}

/**
 * 安全策（誤confirmed潰し）
 * - NDLで得たISBNを Amazon PA-API で “ISBN検索” し直す
 * - PA-API側でも同じISBNが出たら「確定」とする
 */
async function verifyByAmazonIsbn({ seriesKey, isbn13 }) {
  const res = await paapiSearchItems({ keywords: isbn13 });
  if (res?.skipped) return { skipped: true, reason: res.reason };
  if (res?.error) return { error: true, status: res.status, body: res.body };

  const items = res?.json?.SearchResult?.Items || [];
  const cands = [];

  for (const it of items) {
    const title = it?.ItemInfo?.Title?.DisplayValue || "";
    const gotIsbn = extractIsbn13FromPaapiItem(it);
    const image = it?.Images?.Primary?.Large?.URL || null;
    const amazonDp = dpUrlFromDetailPageURL(it?.DetailPageURL || null);

    // 一致確認：ISBNが同じ かつ シリーズ名が入ってる（強制）
    if (gotIsbn !== isbn13) continue;
    if (!title.includes(seriesKey)) continue;

    // 1巻っぽさも見る（完璧じゃないが誤確定を下げる）
    const score = scoreCandidate({ seriesKey, title, isbn13: gotIsbn }) + (image ? 5 : 0);

    cands.push({
      source: "amazon_paapi_isbn_verify",
      title,
      isbn13: gotIsbn,
      image,
      amazonDp,
      score,
    });
  }

  const best = pickBest(cands);
  return { ok: true, candidates: cands, best };
}

async function main() {
  const seeds = await loadJson(SEEDS_PATH, { items: [] });
  const seedItems = Array.isArray(seeds?.items) ? seeds.items : [];

  const confirmed = [];
  const todo = [];
  const debug = [];

  for (const s of seedItems) {
    const seriesKey = norm(s?.seriesKey);
    if (!seriesKey) continue;

    const author = norm(s?.author) || null;

    // 1) NDL(Open)候補
    let ndl;
    try {
      ndl = await ndlSearchOpen({ seriesKey });
    } catch (e) {
      ndl = { error: true, message: String(e?.message || e) };
    }

    const ndlCands = Array.isArray(ndl?.candidates) ? ndl.candidates : [];
    const ndlFiltered = ndlCands.filter((c) => !!c.isbn13 && !isLikelySingleEpisode(c.title));
    const ndlBest = pickBest(ndlFiltered);

    // NDLで“ISBN候補”が取れても、Amazonで一致確認できない限り確定しない（安全策）
    if (ndlBest?.isbn13) {
      const verify = await verifyByAmazonIsbn({ seriesKey, isbn13: ndlBest.isbn13 });

      if (verify?.ok && verify?.best) {
        confirmed.push({
          seriesKey,
          author,
          vol1: {
            title: verify.best.title,
            isbn13: ndlBest.isbn13,
            image: verify.best.image ?? null,
            amazonDp: verify.best.amazonDp ?? null,
            source: "ndl_open+amazon_verify",
          },
        });
        debug.push({ seriesKey, ndlBest, ndl, amazonVerify: verify });
        await sleep(350);
        continue;
      }

      // PA-APIが無い or 確認失敗 → todoへ（安全優先）
      todo.push({
        seriesKey,
        author,
        reason: verify?.skipped
          ? `ndl_has_isbn_but_paapi_skipped(${verify.reason})`
          : `ndl_has_isbn_but_not_verified`,
        best: {
          source: "ndl_open",
          score: ndlBest.score ?? null,
          title: ndlBest.title ?? null,
          isbn13: ndlBest.isbn13 ?? null,
        },
      });
      debug.push({ seriesKey, ndlBest, ndl, amazonVerify: verify });
      await sleep(350);
      continue;
    }

    // 2) NDLですらISBN候補が無い → todo
    todo.push({
      seriesKey,
      author,
      reason: ndl?.error ? `ndl_error(${ndl.message})` : "ndl_no_isbn_candidate",
      best: null,
    });
    debug.push({ seriesKey, ndl });
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

  console.log(`[lane2] seeds=${seedItems.length} confirmed=${confirmed.length} todo=${todo.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
