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

// ---- 判定ロジック（安全側） ----
function isLikelySingleEpisode(title) {
  const t = norm(title);
  return /第\s*\d+\s*話/.test(t) || /分冊|単話|話売り|Kindle版|電子版/.test(t);
}
function isVol1Like(title) {
  const t = norm(title);
  return (
    /（\s*1\s*）/.test(t) ||
    /\(\s*1\s*\)/.test(t) ||
    /第\s*1\s*巻/.test(t) ||
    /Vol\.?\s*1/i.test(t) ||
    /(^|[^0-9])1([^0-9]|$)/.test(t)
  );
}
function isSetOrBundle(title) {
  const t = norm(title);
  // “セット” は ISBN が出ない/巻次が崩れることが多いので強制排除
  return /セット|全巻|巻セット|まとめ買い|BOX|ボックス|特装版BOX/i.test(t) || /\b1-\d+\b/.test(t);
}

function scoreCandidate({ title, isbn13, seriesKey, author, creator }) {
  let score = 0;
  const t = norm(title);
  if (!t) return 0;

  if (isbn13) score += 70;

  if (seriesKey && normLoose(t).includes(normLoose(seriesKey))) score += 30;
  if (isVol1Like(t)) score += 25;

  if (author && creator) {
    const a = normLoose(author);
    const c = normLoose(creator);
    if (a && c && c.includes(a)) score += 15;
  }

  if (isLikelySingleEpisode(t)) score -= 60;
  if (isSetOrBundle(t)) score -= 80;
  if (/総集編|公式ファンブック|ガイド|画集|ムック|アンソロジー|完全版|愛蔵版|増補/i.test(t)) score -= 40;
  if (/FULL\s*COLOR/i.test(t)) score -= 20;

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

// ---- ISBN 変換（安全策：ASINが数字10桁のときだけ使う） ----
function calcIsbn13CheckDigit(isbn12) {
  // isbn12: 12桁
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    const d = Number(isbn12[i]);
    if (!Number.isFinite(d)) return null;
    sum += d * (i % 2 === 0 ? 1 : 3);
  }
  const mod = sum % 10;
  const check = (10 - mod) % 10;
  return String(check);
}
function isbn10ToIsbn13(isbn10) {
  const s = String(isbn10 || "").replace(/[^0-9X]/gi, "").toUpperCase();
  if (!/^\d{9}[\dX]$/.test(s)) return null; // ISBN10
  const core9 = s.slice(0, 9);
  const isbn12 = `978${core9}`; // 書籍の一般的変換
  const cd = calcIsbn13CheckDigit(isbn12);
  if (!cd) return null;
  return `${isbn12}${cd}`;
}
function asin10LooksLikeIsbn10(asin) {
  const a = String(asin || "").trim();
  return /^\d{10}$/.test(a);
}

// ---- NDL OpenSearch（item単位でISBN拾い：誤confirmed対策の本丸） ----
async function ndlOpensearch({ seriesKey, author }) {
  const dpid = "iss-ndl-opac";
  const q = encodeURIComponent(`${seriesKey} 1`);
  const url = `https://ndlsearch.ndl.go.jp/api/opensearch?dpid=${encodeURIComponent(dpid)}&cnt=20&q=${q}`;

  const r = await fetch(url, { headers: { "user-agent": "tools-labo/book-scout lane2" } });
  if (!r.ok) throw new Error(`NDL HTTP ${r.status}`);
  const xml = await r.text();

  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].map((m) => m[1]);

  const cands = [];
  let dropped = 0;
  const titleSamples = [];

  for (const block of items) {
    const t = (block.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? "")
      .replace(/&amp;/g, "&")
      .trim();

    const creator =
      (block.match(/<(dc:creator|creator)>([\s\S]*?)<\/\1>/i)?.[2] ?? "").trim();

    // ★ISBNは「そのitem内」で拾う（全体から拾って当てるのは禁止）
    const isbn13 = (block.match(/97[89]\d{10}/g) || [])[0] || null;

    if (titleSamples.length < 5 && t) titleSamples.push(t);

    // 強制排除
    if (!t || isLikelySingleEpisode(t) || isSetOrBundle(t)) {
      dropped++;
      continue;
    }

    // 安全策：シリーズ名が入ってない候補は落とす（誤confirmed潰し）
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
    });
  }

  return {
    query: `${seriesKey} 1`,
    url,
    returned: items.length,
    candidates: cands,
    dropped,
    titleSamples,
  };
}

// ---- PA-API (SearchItems) ----
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
      "ItemInfo.ByLineInfo",
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

  const canonicalRequest = [method, canonicalUri, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");

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
  return null;
}

async function paapiFindByIsbn13(isbn13) {
  const res = await paapiSearchItems({ keywords: isbn13 });
  if (res?.skipped) return { skipped: true, reason: res.reason };
  if (res?.error) return { error: true, status: res.status, body: res.body };

  const items = res?.json?.SearchResult?.Items || [];
  for (const it of items) {
    const got = extractIsbn13(it);
    if (got === isbn13) {
      const asin = it?.ASIN || null;
      const title = extractTitle(it);
      const image = it?.Images?.Primary?.Large?.URL || null;
      return {
        ok: true,
        asin,
        title,
        isbn13: got,
        image,
        amazonDp: dpFromAsin(asin),
      };
    }
  }
  return { ok: true, miss: true, returned: items.length };
}

async function paapiSearchVol1({ seriesKey, author }) {
  const tries = [`${seriesKey} 1`, `${seriesKey} （1）`];
  const results = [];
  const candidatesAll = [];

  for (const q of tries) {
    const res = await paapiSearchItems({ keywords: q });
    if (res?.skipped) return { skipped: true, reason: res.reason };
    if (res?.error) {
      results.push({ query: q, ok: false, status: res.status, body: res.body });
      continue;
    }

    const items = res?.json?.SearchResult?.Items || [];
    let best = null;

    for (const it of items) {
      const title = extractTitle(it);
      const isbn13 = extractIsbn13(it);
      const asin = it?.ASIN || null;

      if (!title) continue;
      if (isLikelySingleEpisode(title)) continue;
      if (isSetOrBundle(title)) continue;
      if (!normLoose(title).includes(normLoose(seriesKey))) continue;

      // ★ISBN13が無い場合、ASINが数字10桁なら ISBN10→13 を “仮ISBN13” として作る（ただし確定は後段の二段確認）
      const isbn13Guess = !isbn13 && asin10LooksLikeIsbn10(asin) ? isbn10ToIsbn13(asin) : null;

      const score = scoreCandidate({
        title,
        isbn13: isbn13 || isbn13Guess,
        seriesKey,
        author,
        creator: null,
      }) + (asin ? 5 : 0);

      const cand = {
        source: "paapi_search",
        query: q,
        title,
        isbn13: isbn13 || null,
        isbn13Guess: isbn13Guess || null,
        asin,
        score,
      };

      candidatesAll.push(cand);
      if (!best || cand.score > best.score) best = cand;
    }

    results.push({ query: q, ok: true, returned: items.length, best });
    await sleep(900);
  }

  const bests = results.map((x) => x.best).filter(Boolean);
  const best = pickBest(bests);

  return { tried: tries, results, best, candidatesAll: candidatesAll.slice(0, 30) };
}

// ---- main：誤confirmed潰し（二段確認固定） ----
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

    // 1) NDL候補（item単位ISBN）
    let ndl;
    try {
      ndl = await ndlOpensearch({ seriesKey, author });
    } catch (e) {
      ndl = { error: String(e?.message || e) };
    }
    one.ndl = ndl;

    const ndlBest = pickBest(ndl?.candidates || []);

    // 2) NDLでISBN13が出た場合 → PA-APIで “ISBN一致” を取れたら confirmed
    if (ndlBest?.isbn13) {
      const pa = await paapiFindByIsbn13(ndlBest.isbn13);
      one.paapiByIsbn = pa;

      if (pa?.ok && !pa?.miss && pa?.isbn13 === ndlBest.isbn13) {
        // 最終安全：タイトルにシリーズ名 + 1巻っぽさ
        const titleOk =
          normLoose(pa.title).includes(normLoose(seriesKey)) &&
          isVol1Like(pa.title) &&
          !isLikelySingleEpisode(pa.title) &&
          !isSetOrBundle(pa.title);

        if (titleOk) {
          confirmed.push({
            seriesKey,
            author,
            vol1: {
              title: pa.title || ndlBest.title,
              isbn13: ndlBest.isbn13,
              image: pa.image || null,
              amazonDp: pa.amazonDp || null,
              source: "ndl+paapi(double_check)",
            },
          });
          debug.push(one);
          await sleep(600);
          continue;
        }
      }

      // NDLはあるが PA-API で一致確認できない → todo（誤confirmed防止）
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

    // 3) NDLが取れない → PA-API検索 →（ISBN13 or ISBN13Guess）→ PA-API(ISBN一致)で二段確認
    const paSearch = await paapiSearchVol1({ seriesKey, author });
    one.paapiSearch = {
      tried: paSearch?.tried,
      results: paSearch?.results,
      best: paSearch?.best,
      candidatesAll: paSearch?.candidatesAll,
    };

    const b = paSearch?.best;

    // “確定に使うISBN候補” は ISBN13優先、無ければ isbn13Guess（ASIN数字10桁変換）
    const isbnCand = b?.isbn13 || b?.isbn13Guess || null;

    if (isbnCand) {
      const pa2 = await paapiFindByIsbn13(isbnCand);
      one.paapiByIsbn2 = pa2;

      if (pa2?.ok && !pa2?.miss && pa2?.isbn13 === isbnCand) {
        const titleOk =
          normLoose(pa2.title).includes(normLoose(seriesKey)) &&
          isVol1Like(pa2.title) &&
          !isLikelySingleEpisode(pa2.title) &&
          !isSetOrBundle(pa2.title);

        if (titleOk) {
          confirmed.push({
            seriesKey,
            author,
            vol1: {
              title: pa2.title,
              isbn13: isbnCand,
              image: pa2.image || null,
              amazonDp: pa2.amazonDp || null,
              source: b?.isbn13 ? "paapi_isbn(double_check)" : "paapi_asin10_to_isbn13(double_check)",
            },
          });
          debug.push(one);
          await sleep(600);
          continue;
        }
      }
    }

    // だめならtodo（誤confirmed防止）
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
        : { source: "none", score: 0, title: null, asin: null, isbn13: null, isbn13Guess: null, query: null },
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
