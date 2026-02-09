// scripts/lane2/build_lane2.mjs
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const SEEDS_PATH = "data/lane2/seeds.json";
const OUT_SERIES = "data/lane2/series.json";
const OUT_TODO = "data/lane2/todo.json";
const OUT_DEBUG = "data/lane2/debug_candidates.json";

// env名は AMZ_* に統一
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

/** -----------------------
 * title heuristics
 * ---------------------- */
function isLikelySingleEpisode(title) {
  const t = norm(title);
  return /第\s*\d+\s*話/.test(t) || /分冊|単話|話売り|Kindle版|電子版/.test(t);
}
function isSetLike(title) {
  const t = norm(title);
  return /(\d+\s*-\s*\d+巻)|(巻\s*セット)|(\d+巻\s*セット)|セット|まとめ売り/.test(t);
}
function isExtraBookLike(title) {
  const t = norm(title);
  return /総集編|公式ファンブック|特装版|限定版|ガイド|画集|副読本|ポスター|キャラクターブック|ムック|図録/i.test(t);
}
function isVol1Like(title) {
  const t = norm(title);

  // 「1-11巻」みたいなセット検知は別で落とすので、ここでは "巻" or "(1)" を強めに見る
  if (/（\s*1\s*）/.test(t)) return true;
  if (/第\s*1\s*巻/.test(t)) return true;
  if (/(^|[^0-9])1\s*巻/.test(t)) return true;
  if (/Vol\.?\s*1/i.test(t)) return true;

  return false;
}

function scoreCandidate({ title, isbn13, seriesKey, author, creator }) {
  let score = 0;
  const t = norm(title);
  if (!t) return 0;

  if (isbn13) score += 70;

  if (seriesKey && normLoose(t).includes(normLoose(seriesKey))) score += 30;

  if (isVol1Like(t)) score += 35;

  if (author && creator) {
    const a = normLoose(author);
    const c = normLoose(creator);
    if (a && c && c.includes(a)) score += 15;
  }

  if (isLikelySingleEpisode(t)) score -= 80;
  if (isSetLike(t)) score -= 120;
  if (isExtraBookLike(t)) score -= 60;
  if (/FULL\s*COLOR|フルカラー|バイリンガル/i.test(t)) score -= 25;

  return score;
}
function pickBest(cands) {
  if (!cands.length) return null;
  cands.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  return cands[0];
}
function dpFromAsin(asin) {
  if (!asin) return null;
  const a = String(asin).trim().toUpperCase();
  // JP Books は ASIN=ISBN10(数字10桁) も普通にある
  if (!/^[A-Z0-9]{10}$/.test(a)) return null;

  // 可能なら tag を付ける（PA-APIの DetailPageURL が返るならそれ優先で使う）
  if (AMZ_PARTNER_TAG) return `https://www.amazon.co.jp/dp/${a}?tag=${encodeURIComponent(AMZ_PARTNER_TAG)}`;
  return `https://www.amazon.co.jp/dp/${a}`;
}

/** -----------------------
 * NDL Search OpenSearch
 * ---------------------- */
async function ndlOpensearch({ seriesKey, author }) {
  // NDL-OPAC 系に寄せる（open はノイズ混入しやすい）
  const dpid = "iss-ndl-opac";

  // qで広く取って、item内整合（title/creator/isbn）で落とす
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

    // item内からISBN(13)っぽいものだけ拾う
    const isbn13 = (block.match(/97[89]\d{10}/g) || [])[0] || null;

    if (!t || isLikelySingleEpisode(t) || isSetLike(t)) {
      dropped++;
      continue;
    }

    // “シリーズ名が入ってない”候補は危険なので落とす
    const hasSeries = normLoose(t).includes(normLoose(seriesKey));
    if (!hasSeries) {
      dropped++;
      continue;
    }

    const score = scoreCandidate({ title: t, isbn13, seriesKey, author, creator });
    cands.push({
      source: "ndl_opensearch",
      title: t,
      creator: creator || null,
      isbn13,
      score,
      detailUrl: null,
    });
  }

  return { query: `${seriesKey} 1`, url, returned: items.length, candidates: cands, dropped, titleSamples };
}

/** -----------------------
 * Amazon PA-API (AWS SigV4)
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

function paapiSignedFetch({ path: apiPath, bodyObj }) {
  if (!AMZ_ACCESS_KEY || !AMZ_SECRET_KEY || !AMZ_PARTNER_TAG) {
    return Promise.resolve({ skipped: true, reason: "missing_paapi_secrets" });
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
    `content-encoding:amz-1.0\ncontent-type:application/json; charset=utf-8\nhost:${host}\nx-amz-date:${xAmzDate}\nx-amz-target:com.amazon.paapi5.v1.ProductAdvertisingAPIv1.${apiPath === "/paapi5/getitems" ? "GetItems" : "SearchItems"}\n`;
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

  return fetch(endpoint, {
    method: "POST",
    headers: {
      "content-encoding": "amz-1.0",
      "content-type": "application/json; charset=utf-8",
      host,
      "x-amz-date": xAmzDate,
      "x-amz-target":
        apiPath === "/paapi5/getitems"
          ? "com.amazon.paapi5.v1.ProductAdvertisingAPIv1.GetItems"
          : "com.amazon.paapi5.v1.ProductAdvertisingAPIv1.SearchItems",
      Authorization: authorizationHeader,
    },
    body,
  });
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

  const r = await paapiSignedFetch({ path: "/paapi5/searchitems", bodyObj });
  if (r?.skipped) return r;

  const text = await r.text();
  if (!r.ok) return { error: true, status: r.status, body: text.slice(0, 1200) };
  return { ok: true, json: JSON.parse(text) };
}

/**
 * GetItems:
 * 重要：Resources に DetailPageURL は入れない（入れると ValidationException になる） [oai_citation:1‡webservices.amazon.co.jp](https://webservices.amazon.co.jp/paapi5/documentation/get-items.html)
 */
async function paapiGetItems({ asin }) {
  const bodyObj = {
    ItemIds: [asin],
    PartnerTag: AMZ_PARTNER_TAG,
    PartnerType: "Associates",
    // DetailPageURL は Resources に指定しない
    Resources: [
      "ItemInfo.Title",
      "ItemInfo.ExternalIds",
      "ItemInfo.ByLineInfo",
      "Images.Primary.Large",
    ],
  };

  const r = await paapiSignedFetch({ path: "/paapi5/getitems", bodyObj });
  if (r?.skipped) return r;

  const text = await r.text();
  if (!r.ok) return { error: true, status: r.status, body: text.slice(0, 1200) };
  return { ok: true, json: JSON.parse(text) };
}

/** -----------------------
 * ExternalId parsing
 * ---------------------- */
function isbn10to13(isbn10) {
  const s = String(isbn10 || "").replace(/[^0-9X]/gi, "");
  if (!/^\d{9}[\dX]$/i.test(s)) return null;

  const core = `978${s.slice(0, 9)}`; // 12桁
  let sum = 0;
  for (let i = 0; i < core.length; i++) {
    const n = Number(core[i]);
    sum += (i % 2 === 0) ? n : n * 3;
  }
  const cd = (10 - (sum % 10)) % 10;
  return `${core}${cd}`;
}

function extractIsbn13(item) {
  // JP Books: EANs に 978... が入ることが多い
  const eans = item?.ItemInfo?.ExternalIds?.EANs?.DisplayValues;
  if (Array.isArray(eans) && eans.length) {
    const v = String(eans[0]).replace(/[^0-9]/g, "");
    if (/^97[89]\d{10}$/.test(v)) return v;
  }

  // たまに ISBNs に 13桁が入るケース
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
function extractAuthor(item) {
  const c = item?.ItemInfo?.ByLineInfo?.Contributors;
  if (Array.isArray(c) && c.length) return c.map((x) => x?.Name).filter(Boolean).join("/");
  const a = item?.ItemInfo?.ByLineInfo?.Manufacturer?.DisplayValue;
  return a || null;
}
function extractImage(item) {
  return item?.Images?.Primary?.Large?.URL || null;
}
function extractDetailUrl(item) {
  // GetItems は DetailPageURL が返る（Resources 指定不要）
  return item?.DetailPageURL || null;
}

/** -----------------------
 * find/confirm
 * ---------------------- */
async function paapiFindByIsbn13(isbn13) {
  const res = await paapiSearchItems({ keywords: isbn13 });
  if (res?.skipped) return { skipped: true, reason: res.reason };
  if (res?.error) return { error: true, status: res.status, body: res.body };

  const items = res?.json?.SearchResult?.Items || [];
  for (const it of items) {
    const got = extractIsbn13(it);
    if (got === isbn13) {
      const asin = it?.ASIN || null;
      return {
        ok: true,
        asin,
        title: extractTitle(it),
        isbn13: got,
        image: extractImage(it),
        amazonDp: extractDetailUrl(it) || dpFromAsin(asin),
      };
    }
  }
  return { ok: true, miss: true, returned: items.length };
}

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
      const isbn13 = extractIsbn13(it);
      const asin = it?.ASIN || null;

      // シリーズ名必須
      if (!normLoose(title).includes(normLoose(seriesKey))) continue;

      // ノイズを強めに落とす
      if (isLikelySingleEpisode(title)) continue;
      if (isSetLike(title)) continue;

      // 1巻っぽさ必須（これがないと副読本/ポスターが残る）
      if (!isVol1Like(title)) continue;

      // 付録/副読本系をさらに落とす
      if (isExtraBookLike(title)) continue;

      const score = scoreCandidate({ title, isbn13, seriesKey, author, creator: null }) + (asin ? 5 : 0);
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

    // 1) NDL
    let ndl;
    try {
      ndl = await ndlOpensearch({ seriesKey, author });
    } catch (e) {
      ndl = { error: String(e?.message || e) };
    }
    one.ndl = ndl;

    const ndlBest = pickBest(ndl?.candidates || []);

    // 2) NDL→PAAPI (ISBN一致で確認＆画像取得)
    if (ndlBest?.isbn13) {
      const pa = await paapiFindByIsbn13(ndlBest.isbn13);
      one.paapiByIsbn = pa;

      if (pa?.ok && !pa?.miss && pa?.isbn13 === ndlBest.isbn13) {
        confirmed.push({
          seriesKey,
          author,
          vol1: {
            title: pa.title || ndlBest.title,
            isbn13: ndlBest.isbn13,
            image: pa.image || null,
            amazonDp: pa.amazonDp || null,
            source: "ndl+paapi",
          },
        });
        debug.push(one);
        await sleep(600);
        continue;
      }

      todo.push({
        seriesKey,
        author,
        reason: pa?.skipped
          ? `ndl_has_isbn_but_paapi_skipped(${pa.reason})`
          : `ndl_has_isbn_but_paapi_no_match`,
        best: {
          source: "ndl_opensearch",
          score: ndlBest.score ?? null,
          title: ndlBest.title ?? null,
          isbn13: ndlBest.isbn13 ?? null,
        },
      });
      debug.push(one);
      await sleep(600);
      continue;
    }

    // 3) NDLダメ → PA-API検索で1巻候補→GetItemsで確定（EAN/ISBN取得＆画像URL取得）
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
        const amazonDp = extractDetailUrl(item) || dpFromAsin(b.asin);

        const titleOk =
          normLoose(title).includes(normLoose(seriesKey)) &&
          isVol1Like(title) &&
          !isLikelySingleEpisode(title) &&
          !isSetLike(title) &&
          !isExtraBookLike(title);

        if (isbn13 && titleOk) {
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

    // だめならtodo
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
