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

function isLikelySingleEpisode(title) {
  const t = norm(title);
  return /第\s*\d+\s*話/.test(t) || /分冊|単話|話売り|Kindle版|電子版|デジタル版/.test(t);
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
function isBoxSetLike(title) {
  const t = norm(title);
  return /セット|全巻|まとめ|1-\d+巻|新品セット/.test(t);
}
function isDerivativeLike(title) {
  const t = norm(title);
  return /小説|文庫|ファンブック|ガイド|画集|キャラクターブック|ＥＰＩＳＯＤＥ|スピンオフ|FULL\s*COLOR|フルカラー|バイリンガル/.test(
    t
  );
}

function scoreCandidate({ title, isbn13, seriesKey, author, creator }) {
  let score = 0;
  const t = norm(title);
  if (!t) return 0;

  if (isbn13) score += 70;

  // シリーズ名を含む（必須級）
  if (seriesKey && normLoose(t).includes(normLoose(seriesKey))) score += 30;

  // 1巻っぽい
  if (isVol1Like(t)) score += 25;

  // 作者一致（NDL側のcreatorが取れた時だけ加点）
  if (author && creator) {
    const a = normLoose(author);
    const c = normLoose(creator);
    if (a && c && c.includes(a)) score += 15;
  }

  // ノイズ抑制
  if (isLikelySingleEpisode(t)) score -= 80;
  if (isBoxSetLike(t)) score -= 60;
  if (isDerivativeLike(t)) score -= 45;

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
  if (!/^[A-Z0-9]{10}$/.test(a)) return null;
  return `https://www.amazon.co.jp/dp/${a}`;
}

function isbn10to13(isbn10) {
  const x = String(isbn10 ?? "").replace(/[^0-9X]/gi, "");
  if (!/^\d{9}[\dX]$/.test(x)) return null;
  const base = "978" + x.slice(0, 9);
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    const n = Number(base[i]);
    sum += i % 2 === 0 ? n : n * 3;
  }
  const check = (10 - (sum % 10)) % 10;
  return base + String(check);
}

/**
 * -----------------------
 * NDL Search OpenSearch
 * -----------------------
 * 重要：
 * - NDLの例は q= ではなく title= を使っている  [oai_citation:1‡国立国会図書館サーチ（NDLサーチ）](https://ndlsearch.ndl.go.jp/en/help/api/specifications)
 * - dpid は iss-ndl-opac に固定（提供DBを絞る）
 */
async function ndlOpensearch({ seriesKey, author }) {
  const dpid = "iss-ndl-opac";
  const cnt = 30;

  // q は効かない/ノイズが出るケースがあるので title を使う
  const title = encodeURIComponent(seriesKey);
  const url = `https://ndlsearch.ndl.go.jp/api/opensearch?dpid=${encodeURIComponent(
    dpid
  )}&cnt=${cnt}&title=${title}`;

  const r = await fetch(url, { headers: { "user-agent": "tools-labo/book-scout lane2" } });
  if (!r.ok) throw new Error(`NDL HTTP ${r.status}`);
  const xml = await r.text();

  const itemBlocks = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].map((m) => m[1]);

  const cands = [];
  let dropped = 0;
  const titleSamples = [];

  for (const block of itemBlocks) {
    const t = (block.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? "")
      .replace(/&amp;/g, "&")
      .trim();

    if (titleSamples.length < 5 && t) titleSamples.push(t);

    const creator =
      (block.match(/<(dc:creator|creator)>([\s\S]*?)<\/\1>/i)?.[2] ?? "").trim() || null;

    // item内ISBN（13桁）だけ拾う
    const isbn13 = (block.match(/97[89]\d{10}/g) || [])[0] || null;

    // 基本条件
    if (!t) {
      dropped++;
      continue;
    }
    if (isLikelySingleEpisode(t) || isBoxSetLike(t) || isDerivativeLike(t)) {
      dropped++;
      continue;
    }

    // “シリーズ名を含む” を必須
    if (!normLoose(t).includes(normLoose(seriesKey))) {
      dropped++;
      continue;
    }

    // 1巻っぽさも必須（NDLは巻表記が揺れるので、ここは厳しすぎると落ちる。最低限）
    if (!isVol1Like(t) && !/１|1/.test(t)) {
      dropped++;
      continue;
    }

    const score = scoreCandidate({ title: t, isbn13, seriesKey, author, creator });

    cands.push({
      source: "ndl_opensearch",
      title: t,
      creator,
      isbn13,
      score,
    });
  }

  return {
    query: { title: seriesKey },
    url,
    returned: itemBlocks.length,
    candidates: cands,
    dropped,
    titleSamples,
  };
}

/**
 * -----------------------
 * Amazon PA-API
 * -----------------------
 * 方針：
 * - SearchItemsで候補ASINを決める
 * - そのASINを GetItems で取り直して ISBN/画像を確定
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
  return { amzDate: `${y}${m}${day}T${hh}${mm}${ss}Z`, dateStamp: `${y}${m}${day}` };
}

function signedFetch({ target, uri, bodyObj }) {
  if (!AMZ_ACCESS_KEY || !AMZ_SECRET_KEY || !AMZ_PARTNER_TAG) {
    return { skipped: true, reason: "missing_paapi_secrets" };
  }

  const host = "webservices.amazon.co.jp";
  const region = "us-west-2";
  const service = "ProductAdvertisingAPI";
  const endpoint = `https://${host}${uri}`;
  const body = JSON.stringify(bodyObj);

  const { amzDate: xAmzDate, dateStamp } = amzDate();

  const method = "POST";
  const canonicalUri = uri;
  const canonicalQuerystring = "";
  const canonicalHeaders =
    `content-encoding:amz-1.0\ncontent-type:application/json; charset=utf-8\nhost:${host}\nx-amz-date:${xAmzDate}\nx-amz-target:${target}\n`;
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
      "x-amz-target": target,
      Authorization: authorizationHeader,
    },
    body,
  });
}

async function paapiSearchItems({ keywords }) {
  const req = {
    target: "com.amazon.paapi5.v1.ProductAdvertisingAPIv1.SearchItems",
    uri: "/paapi5/searchitems",
    bodyObj: {
      Keywords: keywords,
      SearchIndex: "Books",
      ItemCount: 10,
      PartnerTag: AMZ_PARTNER_TAG,
      PartnerType: "Associates",
      Resources: ["ItemInfo.Title", "ItemInfo.ExternalIds", "ItemInfo.ByLineInfo", "Images.Primary.Large"],
    },
  };

  const r = await signedFetch(req);
  if (r?.skipped) return r;

  const text = await r.text();
  if (!r.ok) return { error: true, status: r.status, body: text.slice(0, 1200) };
  return { ok: true, json: JSON.parse(text) };
}

async function paapiGetItems({ asin }) {
  const req = {
    target: "com.amazon.paapi5.v1.ProductAdvertisingAPIv1.GetItems",
    uri: "/paapi5/getitems",
    bodyObj: {
      ItemIds: [asin],
      PartnerTag: AMZ_PARTNER_TAG,
      PartnerType: "Associates",
      Resources: ["ItemInfo.Title", "ItemInfo.ExternalIds", "ItemInfo.ByLineInfo", "Images.Primary.Large"],
    },
  };

  const r = await signedFetch(req);
  if (r?.skipped) return r;

  const text = await r.text();
  if (!r.ok) return { error: true, status: r.status, body: text.slice(0, 1200) };
  return { ok: true, json: JSON.parse(text) };
}

function extractTitle(item) {
  return item?.ItemInfo?.Title?.DisplayValue || "";
}
function extractIsbn13(item) {
  const vals = item?.ItemInfo?.ExternalIds?.ISBN?.DisplayValues;
  if (Array.isArray(vals) && vals.length) {
    const v = String(vals[0]).replace(/[^0-9]/g, "");
    if (/^97[89]\d{10}$/.test(v)) return v;
  }
  // EANが入るケースもある
  const ean = item?.ItemInfo?.ExternalIds?.EANs?.DisplayValues?.[0];
  if (ean && /^97[89]\d{10}$/.test(String(ean).replace(/[^0-9]/g, ""))) return String(ean).replace(/[^0-9]/g, "");
  return null;
}

async function paapiSearchVol1({ seriesKey, author }) {
  const tries = [`${seriesKey} 1`, `${seriesKey} （1）`];
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
      const asin = it?.ASIN || null;

      if (!title || !asin) continue;

      // シリーズ名必須
      if (!normLoose(title).includes(normLoose(seriesKey))) continue;

      // 単話/セット/派生は落とす
      if (isLikelySingleEpisode(title) || isBoxSetLike(title) || isDerivativeLike(title)) continue;

      // 1巻らしさ必須
      if (!isVol1Like(title)) continue;

      // ISBN13はSearchItemsだと取れないことがあるので、ISBN10(数値ASIN)から推定も持つ
      const isbn13 = extractIsbn13(it);
      const isbn13Guess = !isbn13 && /^\d{10}$/.test(String(asin)) ? isbn10to13(asin) : null;

      const score = scoreCandidate({ title, isbn13: isbn13 || isbn13Guess, seriesKey, author, creator: null }) + 5;

      cands.push({ source: "paapi_search", query: q, title, asin, isbn13, isbn13Guess, score });
    }

    const best = pickBest(cands);
    results.push({ query: q, ok: true, returned: items.length, best, candidatesAll: cands });
    await sleep(900);
  }

  const bests = results.map((x) => x.best).filter(Boolean);
  const best = pickBest(bests);

  return { tried: tries, results, best };
}

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

    // 1) NDL（title=で引く）
    let ndl;
    try {
      ndl = await ndlOpensearch({ seriesKey, author });
    } catch (e) {
      ndl = { error: String(e?.message || e) };
    }
    one.ndl = ndl;

    const ndlBest = pickBest(ndl?.candidates || []);

    // 2) NDLでISBNが取れたら、そのISBNでPA-API “GetItems”に行きたいが、
    //    PA-APIはISBNでGetItemsできないので、まずSearchItemsでISBNをKeywordsにしてASINを拾う
    if (ndlBest?.isbn13) {
      const paS = await paapiSearchItems({ keywords: ndlBest.isbn13 });
      one.paapiSearchByIsbn = paS;

      if (paS?.ok) {
        const items = paS?.json?.SearchResult?.Items || [];
        const exact = items.find((it) => extractIsbn13(it) === ndlBest.isbn13);
        const asin = exact?.ASIN || null;

        if (asin) {
          const paG = await paapiGetItems({ asin });
          one.paapiGetByAsin = paG;

          if (paG?.ok) {
            const got = paG?.json?.ItemsResult?.Items?.[0];
            const title = extractTitle(got);
            const isbn13 = extractIsbn13(got) || ndlBest.isbn13;
            const image = got?.Images?.Primary?.Large?.URL || null;

            // 最終安全：シリーズ名+1巻らしさ
            const titleOk =
              normLoose(title).includes(normLoose(seriesKey)) &&
              isVol1Like(title) &&
              !isLikelySingleEpisode(title) &&
              !isBoxSetLike(title) &&
              !isDerivativeLike(title);

            if (isbn13 === ndlBest.isbn13 && titleOk) {
              confirmed.push({
                seriesKey,
                author,
                vol1: {
                  title: title || ndlBest.title,
                  isbn13,
                  image,
                  amazonDp: dpFromAsin(asin),
                  source: "ndl+paapi(getitems)",
                },
              });
              debug.push(one);
              await sleep(700);
              continue;
            }
          }
        }
      }

      // NDLはあるがPA-APIで確証取れない → todo（誤confirmed防止）
      todo.push({
        seriesKey,
        author,
        reason: paS?.skipped
          ? `ndl_has_isbn_but_paapi_skipped(${paS.reason})`
          : "ndl_has_isbn_but_paapi_no_match",
        best: {
          source: "ndl_opensearch",
          score: ndlBest.score ?? null,
          title: ndlBest.title ?? null,
          isbn13: ndlBest.isbn13 ?? null,
        },
      });
      debug.push(one);
      await sleep(700);
      continue;
    }

    // 3) NDLでISBNが取れない → PA-API検索 → ベストASIN → GetItemsでISBN/画像確定
    const paSearch = await paapiSearchVol1({ seriesKey, author });
    one.paapiSearch = paSearch;

    const b = paSearch?.best;
    if (b?.asin) {
      const paG = await paapiGetItems({ asin: b.asin });
      one.paapiGet = paG;

      if (paG?.ok) {
        const got = paG?.json?.ItemsResult?.Items?.[0];
        const title = extractTitle(got);
        const isbn13 = extractIsbn13(got) || b.isbn13Guess || null;
        const image = got?.Images?.Primary?.Large?.URL || null;

        const titleOk =
          normLoose(title).includes(normLoose(seriesKey)) &&
          isVol1Like(title) &&
          !isLikelySingleEpisode(title) &&
          !isBoxSetLike(title) &&
          !isDerivativeLike(title);

        if (isbn13 && titleOk) {
          confirmed.push({
            seriesKey,
            author,
            vol1: {
              title,
              isbn13,
              image,
              amazonDp: dpFromAsin(b.asin),
              source: "paapi(getitems)",
            },
          });
          debug.push(one);
          await sleep(700);
          continue;
        }
      }
    }

    todo.push({
      seriesKey,
      author,
      reason: paSearch?.skipped ? `paapi_skipped(${paSearch.reason})` : "no_confirmed_isbn",
      best: b
        ? {
            source: "paapi_search",
            score: b.score ?? 0,
            title: b.title ?? null,
            asin: b.asin ?? null,
            isbn13: b.isbn13 ?? null,
            isbn13Guess: b.isbn13Guess ?? null,
            query: b.query ?? null,
          }
        : { source: "none", score: 0, title: null, asin: null, isbn13: null, query: null },
    });
    debug.push(one);
    await sleep(700);
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
