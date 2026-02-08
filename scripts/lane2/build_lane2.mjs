// scripts/lane2/build_lane2.mjs
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const SEEDS_PATH = "data/lane2/seeds.json";
const OUT_SERIES = "data/lane2/series.json";
const OUT_TODO = "data/lane2/todo.json";
const OUT_DEBUG = "data/lane2/debug_candidates.json";

// ★ Secrets名（ユーザー指定）
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
  // “ざっくり比較”用（全角/半角等まではやらない、まずは軽く）
  return norm(s).toLowerCase();
}

function isLikelySingleEpisode(title) {
  const t = norm(title);
  return (
    /第\s*\d+\s*話/.test(t) ||
    (/(\(\s*\d+\s*\))\s*$/.test(t) && /話/.test(t)) ||
    /分冊|単話|話売り|Kindle版|電子版/.test(t)
  );
}

function isVol1Like(title) {
  const t = norm(title);
  return (
    /（\s*1\s*）/.test(t) ||
    /第\s*1\s*巻/.test(t) ||
    /Vol\.?\s*1/i.test(t) ||
    // “1”単体は誤爆しやすいので弱め（前後が数字でない）
    /(^|[^0-9])1([^0-9]|$)/.test(t)
  );
}

function scoreCandidate({ seriesKey, title, isbn13, source }) {
  let score = 0;
  const t = norm(title);
  if (!t) return 0;

  if (isbn13) score += 60;
  if (isVol1Like(t)) score += 30;

  // シリーズ名を含むか（最重要）
  const sk = normLoose(seriesKey);
  if (sk && normLoose(t).includes(sk)) score += 40;
  else score -= 50;

  // ノイズ除外
  if (isLikelySingleEpisode(t)) score -= 80;
  if (/総集編|公式ファンブック|特装版|限定版|ガイド|画集/.test(t)) score -= 60;
  if (/FULL\s*COLOR/i.test(t)) score -= 20;

  // NDLは雑に広く出るので、NDL由来は“過信しない”
  if (source === "ndl_open") score -= 5;

  return score;
}

function pickBest(cands) {
  if (!cands.length) return null;
  cands.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  return cands[0];
}

/**
 * -----------------------
 * NDL Search (OpenSearch / dpid=open)
 * -----------------------
 * 重要: XML全体から拾うのではなく、<item>単位で title と isbn を同じ塊から取る
 */
function decodeXml(s) {
  return String(s ?? "")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");
}

function extractTag(text, tag) {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = text.match(re);
  return m ? decodeXml(m[1]).trim() : null;
}

function extractIsbns(text) {
  const hits = [...String(text ?? "").matchAll(/97[89]\d{10}/g)].map((m) => m[0]);
  return [...new Set(hits)];
}

async function ndlSearchOpen({ seriesKey }) {
  const q = encodeURIComponent(`${seriesKey} 1`);
  const url = `https://ndlsearch.ndl.go.jp/api/opensearch?dpid=open&count=20&q=${q}`;

  const r = await fetch(url, {
    headers: { "user-agent": "tools-labo/book-scout lane2" },
  });
  if (!r.ok) throw new Error(`NDL HTTP ${r.status}`);
  const xml = await r.text();

  // RSSの <item> を拾う（OpenSearchはRSS風）
  const itemBlocks = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].map((m) => m[1]);

  const candidates = [];
  for (const block of itemBlocks) {
    const title = extractTag(block, "title") || "";
    // isbnは item 内（identifier/description等）から拾う
    const isbns = extractIsbns(block);
    for (const isbn13 of isbns.slice(0, 2)) {
      const score = scoreCandidate({ seriesKey, title, isbn13, source: "ndl_open" });
      candidates.push({
        source: "ndl_open",
        title,
        isbn13,
        score,
        detailUrl: extractTag(block, "link") || null,
        reason: "ndl_item_pair",
      });
    }
  }

  // seriesKeyを含まない候補は基本捨てる（安全）
  const safe = candidates.filter((c) => normLoose(c.title).includes(normLoose(seriesKey)));
  return {
    query: `${seriesKey} 1`,
    url,
    candidates: safe,
    dropped: candidates.length - safe.length,
  };
}

/**
 * -----------------------
 * Amazon PA-API (GetItems / SearchItems)
 * -----------------------
 * 重要: ここが “照合して確定する”本丸
 */
function awsHmac(key, data) {
  return crypto.createHmac("sha256", key).update(data, "utf8").digest();
}
function awsHashHex(data) {
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
  return { xAmzDate: `${y}${m}${day}T${hh}${mm}${ss}Z`, dateStamp: `${y}${m}${day}` };
}

function canUsePaapi() {
  return !!(AMZ_ACCESS_KEY && AMZ_SECRET_KEY && AMZ_PARTNER_TAG);
}

// PA-APIは全リージョン us-east-1 が基本（公式サンプル準拠）
const PAAPI_HOST = "webservices.amazon.co.jp";
const PAAPI_REGION = "us-east-1";
const PAAPI_SERVICE = "ProductAdvertisingAPI";

async function paapiPost({ path, target, bodyObj }) {
  const body = JSON.stringify(bodyObj);
  const endpoint = `https://${PAAPI_HOST}${path}`;

  const { xAmzDate, dateStamp } = amzDate();
  const method = "POST";

  const canonicalUri = path;
  const canonicalQuerystring = "";

  const canonicalHeaders =
    `content-encoding:amz-1.0\ncontent-type:application/json; charset=utf-8\nhost:${PAAPI_HOST}\nx-amz-date:${xAmzDate}\nx-amz-target:${target}\n`;

  const signedHeaders = "content-encoding;content-type;host;x-amz-date;x-amz-target";
  const payloadHash = awsHashHex(body);

  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuerystring,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const algorithm = "AWS4-HMAC-SHA256";
  const credentialScope = `${dateStamp}/${PAAPI_REGION}/${PAAPI_SERVICE}/aws4_request`;

  const stringToSign = [
    algorithm,
    xAmzDate,
    credentialScope,
    awsHashHex(canonicalRequest),
  ].join("\n");

  const kDate = awsHmac(`AWS4${AMZ_SECRET_KEY}`, dateStamp);
  const kRegion = awsHmac(kDate, PAAPI_REGION);
  const kService = awsHmac(kRegion, PAAPI_SERVICE);
  const kSigning = awsHmac(kService, "aws4_request");
  const signature = crypto.createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");

  const authorizationHeader =
    `${algorithm} Credential=${AMZ_ACCESS_KEY}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const r = await fetch(endpoint, {
    method,
    headers: {
      "content-encoding": "amz-1.0",
      "content-type": "application/json; charset=utf-8",
      host: PAAPI_HOST,
      "x-amz-date": xAmzDate,
      "x-amz-target": target,
      Authorization: authorizationHeader,
    },
    body,
  });

  const text = await r.text();
  if (!r.ok) {
    return { ok: false, status: r.status, body: text.slice(0, 1200) };
  }
  return { ok: true, json: JSON.parse(text) };
}

function getFirstIsbn13FromItem(item) {
  const vals = item?.ItemInfo?.ExternalIds?.ISBN?.DisplayValues;
  if (Array.isArray(vals) && vals.length) {
    const v = String(vals[0]).replace(/[^0-9X]/gi, "");
    if (/^97[89]\d{10}$/.test(v)) return v;
  }
  return null;
}

function getTitleFromItem(item) {
  return item?.ItemInfo?.Title?.DisplayValue || "";
}

function getImageFromItem(item) {
  return item?.Images?.Primary?.Large?.URL || null;
}

function getDpFromItem(item) {
  return item?.DetailPageURL || null;
}

function titleMatchesSeries({ seriesKey, title }) {
  const sk = normLoose(seriesKey);
  const t = normLoose(title);
  return sk && t.includes(sk);
}

function isSafeVol1Title(title) {
  if (!title) return false;
  if (isLikelySingleEpisode(title)) return false;
  if (!isVol1Like(title)) return false;
  return true;
}

async function paapiGetByIsbn(isbn13) {
  // ★ Resourcesは「配列」で渡す（join禁止）
  const bodyObj = {
    ItemIdType: "ISBN",
    ItemIds: [isbn13],
    PartnerTag: AMZ_PARTNER_TAG,
    PartnerType: "Associates",
    Resources: [
      "ItemInfo.Title",
      "ItemInfo.ExternalIds",
      "Images.Primary.Large",
      "DetailPageURL",
    ],
  };

  return await paapiPost({
    path: "/paapi5/getitems",
    target: "com.amazon.paapi5.v1.ProductAdvertisingAPIv1.GetItems",
    bodyObj,
  });
}

async function paapiSearchItems(keywords) {
  const bodyObj = {
    Keywords: keywords,
    SearchIndex: "Books",
    ItemCount: 10,
    PartnerTag: AMZ_PARTNER_TAG,
    PartnerType: "Associates",
    Resources: [
      "ItemInfo.Title",
      "ItemInfo.ExternalIds",
      "Images.Primary.Large",
      "DetailPageURL",
    ],
  };

  return await paapiPost({
    path: "/paapi5/searchitems",
    target: "com.amazon.paapi5.v1.ProductAdvertisingAPIv1.SearchItems",
    bodyObj,
  });
}

/**
 * -----------------------
 * 確定ロジック（誤confirmed防止）
 * -----------------------
 * 1) NDLで候補ISBNを最大N個出す
 * 2) PA-API(GetItems by ISBN)で “タイトル照合 + 1巻っぽさ” を満たしたら確定
 * 3) だめなら PA-API(SearchItems) で拾って同じ基準で確定
 */
async function confirmFromNdlThenPaapi({ seriesKey, author, ndl }) {
  const debug = { ndl, paapi: { triedIsbns: [], getitems: {} } };

  const ndlCands = Array.isArray(ndl?.candidates) ? ndl.candidates : [];
  // スコア高い順に上位だけ（叩きすぎ防止）
  ndlCands.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const top = ndlCands.slice(0, 4);

  if (!canUsePaapi()) {
    return {
      ok: false,
      reason: "paapi_skipped(missing_secrets)",
      best: top[0] || null,
      debug,
    };
  }

  for (const c of top) {
    if (!c?.isbn13) continue;

    debug.paapi.triedIsbns.push(c.isbn13);

    // 429対策：1回ごとに待つ
    await sleep(1100);

    const res = await paapiGetByIsbn(c.isbn13);
    debug.paapi.getitems[c.isbn13] = res.ok ? { ok: true } : { ok: false, status: res.status, body: res.body };

    if (!res.ok) continue;

    const item = res?.json?.ItemsResult?.Items?.[0];
    const title = getTitleFromItem(item);
    const isbn = getFirstIsbn13FromItem(item) || c.isbn13;
    const image = getImageFromItem(item);
    const amazonDp = getDpFromItem(item);

    // ★照合条件（ここが安全策の本体）
    if (!titleMatchesSeries({ seriesKey, title })) continue;
    if (!isSafeVol1Title(title)) continue;

    return {
      ok: true,
      confirmed: {
        seriesKey,
        author,
        vol1: {
          title,
          isbn13: isbn,
          image: image || null,
          amazonDp: amazonDp || null,
          source: "ndl_open+paapi_getitems",
        },
      },
      debug,
    };
  }

  return {
    ok: false,
    reason: "ndl_candidates_not_verified_by_paapi",
    best: top[0] || null,
    debug,
  };
}

async function confirmFromPaapiSearch({ seriesKey, author }) {
  const debug = { search: { tried: [], results: [] } };

  if (!canUsePaapi()) {
    return { ok: false, reason: "paapi_skipped(missing_secrets)", best: null, debug };
  }

  const tries = [`${seriesKey} 1`, `${seriesKey} （1）`];
  debug.search.tried = tries;

  for (const q of tries) {
    await sleep(1100);

    const res = await paapiSearchItems(q);
    if (!res.ok) {
      debug.search.results.push({ query: q, ok: false, status: res.status, body: res.body });
      continue;
    }

    const items = res?.json?.SearchResult?.Items || [];
    for (const it of items) {
      const title = getTitleFromItem(it);
      const isbn = getFirstIsbn13FromItem(it);
      const image = getImageFromItem(it);
      const amazonDp = getDpFromItem(it);

      const score = scoreCandidate({ seriesKey, title, isbn13: isbn, source: "amazon_paapi_search" }) + (image ? 5 : 0);

      debug.search.results.push({
        query: q,
        title,
        isbn13: isbn || null,
        amazonDp: amazonDp || null,
        score,
      });
    }

    // ベストを選ぶ
    const cands = debug.search.results
      .filter((x) => x && x.title && titleMatchesSeries({ seriesKey, title: x.title }) && isSafeVol1Title(x.title) && x.isbn13);

    cands.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    const best = cands[0] || null;

    if (best) {
      return {
        ok: true,
        confirmed: {
          seriesKey,
          author,
          vol1: {
            title: best.title,
            isbn13: best.isbn13,
            image: null,      // “画像はISBN確定後GetItems”で取りたいならここはnullでもOK
            amazonDp: best.amazonDp || null,
            source: "paapi_search",
          },
        },
        debug,
      };
    }
  }

  return { ok: false, reason: "paapi_search_no_verified_candidate", best: null, debug };
}

async function main() {
  const seeds = await loadJson(SEEDS_PATH, { items: [] });
  const seedItems = Array.isArray(seeds?.items) ? seeds.items : [];

  const confirmed = [];
  const todo = [];
  const debugOut = [];

  for (const s of seedItems) {
    const seriesKey = norm(s?.seriesKey);
    if (!seriesKey) continue;
    const author = norm(s?.author) || null;

    // 1) NDLで候補取得（item単位でペア抽出）
    let ndl;
    try {
      ndl = await ndlSearchOpen({ seriesKey });
    } catch (e) {
      ndl = { error: true, message: String(e?.message || e), candidates: [] };
    }

    // 2) NDL候補をPA-APIで照合して確定（※ここが誤confirmed防止の核）
    const r1 = await confirmFromNdlThenPaapi({ seriesKey, author, ndl });
    debugOut.push({ seriesKey, step: "ndl_then_paapi", ...r1.debug });

    if (r1.ok) {
      confirmed.push(r1.confirmed);
      continue;
    }

    // 3) だめならPA-API SearchItemsで拾って確定
    const r2 = await confirmFromPaapiSearch({ seriesKey, author });
    debugOut.push({ seriesKey, step: "paapi_search", ...r2.debug });

    if (r2.ok) {
      confirmed.push(r2.confirmed);
      continue;
    }

    // 4) todoへ（安全側）
    todo.push({
      seriesKey,
      author,
      reason: `not_confirmed(${r1.reason}; ${r2.reason})`,
      best: r1.best
        ? { source: r1.best.source, score: r1.best.score ?? null, title: r1.best.title ?? null, isbn13: r1.best.isbn13 ?? null }
        : null,
    });
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

  await saveJson(OUT_DEBUG, { updatedAt: nowIso(), items: debugOut });

  console.log(`[lane2] seeds=${seedItems.length} confirmed=${confirmed.length} todo=${todo.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
