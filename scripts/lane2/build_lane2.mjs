// scripts/lane2/build_lane2.mjs
import fs from "node:fs/promises";
import crypto from "node:crypto";

const SEEDS_PATH = "data/lane2/seeds.json";
const OUT_SERIES = "data/lane2/series.json";
const OUT_TODO = "data/lane2/todo.json";
const OUT_DEBUG = "data/lane2/debug_candidates.json";

// ★ Secrets名に合わせて AMZ_* を読む（ここ重要）
const AMZ_ACCESS_KEY = process.env.AMZ_ACCESS_KEY || "";
const AMZ_SECRET_KEY = process.env.AMZ_SECRET_KEY || "";
const AMZ_PARTNER_TAG = process.env.AMZ_PARTNER_TAG || "";

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

// -----------------------
// 文字一致（誤confirmed潰し用）
// -----------------------
function normalizeForMatch(s) {
  return norm(s)
    .toLowerCase()
    .replaceAll("　", " ")
    .replace(/\s+/g, " ")
    .replace(/[‐-‒–—−]/g, "-")
    .replace(/[！!？?。．・:：（）\(\)\[\]【】]/g, "")
    .trim();
}
function titleMatchesSeries(title, seriesKey) {
  const t = normalizeForMatch(title);
  const k = normalizeForMatch(seriesKey);
  if (!t || !k) return false;

  // “完全一致”までは求めないが、シリーズ名が含まれる/近いことを最低条件にする
  if (t.includes(k)) return true;

  // 先頭20文字くらい一致でもOK（派生タイトルにも耐性）
  const a = t.slice(0, 20);
  const b = k.slice(0, 20);
  return a && b && (a.includes(b) || b.includes(a));
}

function isLikelySingleEpisode(title) {
  const t = norm(title);
  return (
    /第\s*\d+\s*話/.test(t) ||
    (/話/.test(t) && /\(\s*\d+\s*\)\s*$/.test(t)) ||
    /分冊|単話|話売り|Kindle版|電子版/.test(t)
  );
}
function isVol1Like(title) {
  const t = norm(title);
  return /（\s*1\s*）/.test(t) || /第\s*1\s*巻/.test(t) || /Vol\.?\s*1/i.test(t) || /[^0-9]1[^0-9]/.test(` ${t} `);
}

// -----------------------
// NDL OpenSearch（open）
// -----------------------
async function ndlSearchOpen({ seriesKey }) {
  const q = encodeURIComponent(`${seriesKey} 1`);
  const url = `https://ndlsearch.ndl.go.jp/api/opensearch?dpid=open&count=20&q=${q}`;

  const r = await fetch(url, { headers: { "user-agent": "tools-labo/book-scout lane2" } });
  if (!r.ok) throw new Error(`NDL HTTP ${r.status}`);
  const xml = await r.text();

  // ISBN13っぽいものを抽出（複数出る前提）
  const isbns = [...xml.matchAll(/97[89]\d{10}/g)].map((m) => m[0]);
  const uniq = [...new Set(isbns)];

  // タイトルも抽出（デバッグ用）
  const titles = [...xml.matchAll(/<title>([^<]+)<\/title>/g)]
    .map((m) => m[1])
    .filter((t) => t && t !== "openSearch results")
    .slice(0, 20);

  return { query: `${seriesKey} 1`, url, rawIsbns: uniq.slice(0, 50), rawTitles: titles };
}

// -----------------------
// Amazon PA-API（SearchItems）
// ※ “検証”用途：Keywords に ISBN を入れて引く
// -----------------------
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
    ItemCount: 10,
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
      "x-amz-target": "com.amazon.paapi5.v1.ProductAdvertisingAPIv1.SearchItems",
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

function pickPaapiVerifiedVol1({ seriesKey, ndlIsbns, paapiItemsByIsbn }) {
  // “NDL ISBN → PAAPIで同一ISBNが返る” ものだけ候補にする（誤confirmed潰しの本丸）
  const candidates = [];

  for (const isbn of ndlIsbns) {
    const pack = paapiItemsByIsbn.get(isbn);
    if (!pack?.ok) continue;

    for (const it of pack.items) {
      const title = it?.ItemInfo?.Title?.DisplayValue || "";
      const isbn13 = extractIsbn13FromPaapiItem(it);
      const image = it?.Images?.Primary?.Large?.URL || null;
      const dp = it?.DetailPageURL || null;

      if (!isbn13 || isbn13 !== isbn) continue; // ★ ここで“同一ISBN”を強制
      if (!titleMatchesSeries(title, seriesKey)) continue;
      if (isLikelySingleEpisode(title)) continue;
      if (!isVol1Like(title)) continue; // ★ 巻1っぽさも最低条件に

      candidates.push({ isbn13, title, image, amazonDp: dp, source: "ndl_open+paapi_verify" });
    }
  }

  // 単純に最初の1件でOK（ここは将来スコアリング拡張してもいい）
  return candidates[0] || null;
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

    // 1) NDL open で ISBN候補を集める（確定はしない）
    let ndl;
    try {
      ndl = await ndlSearchOpen({ seriesKey });
    } catch (e) {
      ndl = { error: true, message: String(e?.message || e), rawIsbns: [], rawTitles: [] };
    }

    const ndlIsbns = Array.isArray(ndl?.rawIsbns) ? ndl.rawIsbns : [];
    const ndlHasIsbn = ndlIsbns.length > 0;

    // 2) NDLで拾った ISBN を “PA-APIで検証”
    const paapiItemsByIsbn = new Map();

    let paapiSkipped = null;
    if (!AMZ_ACCESS_KEY || !AMZ_SECRET_KEY || !AMZ_PARTNER_TAG) {
      paapiSkipped = "missing_paapi_secrets";
    } else {
      for (const isbn of ndlIsbns.slice(0, 12)) {
        const res = await paapiSearchItems({ keywords: isbn });
        if (res?.skipped) {
          paapiSkipped = res.reason;
          break;
        }
        if (res?.error) {
          paapiItemsByIsbn.set(isbn, { ok: false, error: { status: res.status, body: res.body } });
          await sleep(600);
          continue;
        }
        const items = res?.json?.SearchResult?.Items || [];
        paapiItemsByIsbn.set(isbn, { ok: true, items });
        await sleep(600);
      }
    }

    const verified = pickPaapiVerifiedVol1({ seriesKey, ndlIsbns, paapiItemsByIsbn });

    if (verified) {
      confirmed.push({
        seriesKey,
        author: norm(s?.author) || null,
        vol1: {
          title: verified.title,
          isbn13: verified.isbn13,
          image: verified.image || null,
          amazonDp: verified.amazonDp || null,
          source: verified.source,
        },
      });

      debug.push({
        seriesKey,
        ndl,
        paapi: {
          skipped: paapiSkipped,
          checkedIsbns: ndlIsbns.slice(0, 12),
          notes: "confirmed only when PA-API returns the same ISBN and title matches series",
        },
        verified,
      });

      continue;
    }

    // confirmedできない → todo
    let reason = `not_confirmed(ndlIsbn=${ndlHasIsbn}, paapiSkipped=${paapiSkipped || "no"})`;
    if (!ndlHasIsbn) reason = "not_confirmed(ndl_no_isbn)";
    if (paapiSkipped) reason = `not_confirmed(paapi_skipped=${paapiSkipped}, ndlIsbn=${ndlHasIsbn})`;

    // todoに残す “best” はデバッグ用に NDLの先頭ISBNだけ入れておく
    todo.push({
      seriesKey,
      author: norm(s?.author) || null,
      reason,
      best: ndlHasIsbn
        ? { source: "ndl_open", title: (ndl?.rawTitles?.[0] ?? null), isbn13: ndlIsbns[0] }
        : null,
    });

    // debugに詳細を残す（PA-APIのHTTPエラー本文もここに入る）
    const paapiDebug = {};
    for (const [isbn, pack] of paapiItemsByIsbn.entries()) {
      if (pack.ok) {
        paapiDebug[isbn] = {
          ok: true,
          sampleTitles: (pack.items || []).slice(0, 3).map((it) => it?.ItemInfo?.Title?.DisplayValue || null),
          sampleIsbns: (pack.items || []).slice(0, 3).map((it) => extractIsbn13FromPaapiItem(it)),
        };
      } else {
        paapiDebug[isbn] = { ok: false, error: pack.error };
      }
    }

    debug.push({
      seriesKey,
      ndl,
      paapi: { skipped: paapiSkipped, byIsbn: paapiDebug },
    });
  }

  await saveJson(OUT_SERIES, {
    updatedAt: nowIso(),
    total: seedItems.length,
    confirmed: confirmed.length,
    todo: todo.length,
    items: confirmed,
  });
  await saveJson(OUT_TODO, { updatedAt: nowIso(), total: todo.length, items: todo });
  await saveJson(OUT_DEBUG, { updatedAt: nowIso(), items: debug });

  console.log(`[lane2] seeds=${seedItems.length} confirmed=${confirmed.length} todo=${todo.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
