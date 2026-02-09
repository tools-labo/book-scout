// scripts/lane2/build_lane2.mjs
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const SEEDS_PATH = "data/lane2/seeds.json";
const OUT_SERIES = "data/lane2/series.json";
const OUT_TODO = "data/lane2/todo.json";
const OUT_DEBUG = "data/lane2/debug_candidates.json";
const DERIVED_WORDS_PATH = "data/lane2/derived_words.json";

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
function toHalfWidth(s) {
  return String(s ?? "")
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[（]/g, "(")
    .replace(/[）]/g, ")")
    .replace(/[　]/g, " ");
}

function titleHasSeries(title, seriesKey) {
  const t = normLoose(title);
  const s = normLoose(seriesKey);
  if (!t || !s) return false;
  return t.includes(s);
}

function isVol1Like(title) {
  const t = toHalfWidth(norm(title));
  return /\(\s*1\s*\)/.test(t) || /第\s*1\s*巻/.test(t) || /\b1\b/.test(t);
}

/* -----------------------
 * derived words (externalized)
 * ----------------------- */
function listToRegex(list) {
  const arr = Array.isArray(list) ? list.filter(Boolean).map((x) => String(x)) : [];
  if (!arr.length) return null;
  // 大文字小文字を吸収したいものは、事前に両方入れる運用にする（JSON側で）
  const escaped = arr.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(escaped.join("|"), "i");
}

async function loadDerivedWords() {
  const d = await loadJson(DERIVED_WORDS_PATH, {});
  return {
    raw: d,
    reSets: listToRegex(d.sets),
    reNonMain: listToRegex(d.nonMain),
    reSpinoff: listToRegex(d.spinoff),
    reNovel: listToRegex(d.novel),
    reColor: listToRegex(d.color),
    reLangDeluxe: listToRegex(d.langDeluxe),
    reSerialDigital: listToRegex(d.serialDigital),
    reArtPoster: listToRegex(d.artPoster),
  };
}

/**
 * 派生/別商品を弾く（JSONで運用）
 */
function isDerivedEdition(title, derived) {
  const t = toHalfWidth(norm(title));

  if (derived?.reSets && derived.reSets.test(t)) return true;
  if (derived?.reNonMain && derived.reNonMain.test(t)) return true;
  if (derived?.reSpinoff && derived.reSpinoff.test(t)) return true;
  if (derived?.reNovel && derived.reNovel.test(t)) return true;
  if (derived?.reColor && derived.reColor.test(t)) return true;
  if (derived?.reLangDeluxe && derived.reLangDeluxe.test(t)) return true;
  if (derived?.reSerialDigital && derived.reSerialDigital.test(t)) return true;
  if (derived?.reArtPoster && derived.reArtPoster.test(t)) return true;

  // “第◯話”みたいなのはJSONに含めづらいので固定で弾く
  if (/第\s*\d+\s*話/.test(t)) return true;

  return false;
}

/**
 * “本線1巻” 判定
 */
function isMainlineVol1(title, seriesKey, derived) {
  const t = toHalfWidth(norm(title));
  const s = toHalfWidth(norm(seriesKey));
  if (!t || !s) return false;
  if (!titleHasSeries(t, s)) return false;
  if (!isVol1Like(t)) return false;
  if (isDerivedEdition(t, derived)) return false;

  // シリーズ名の直後が EPISODE/外伝 なら本線じゃない
  const idx = t.indexOf(s);
  if (idx >= 0) {
    const rest = t.slice(idx + s.length);
    if (/^\s*[-ー–—]\s*(episode|外伝)/i.test(rest)) return false;
  }
  return true;
}

/**
 * スコアは補助。確定は mainline を通したものだけ。
 */
function scoreCandidate({ title, isbn13, seriesKey, derived }) {
  let score = 0;
  const t = norm(title);
  if (!t) return 0;

  if (isbn13) score += 80;
  if (seriesKey && titleHasSeries(t, seriesKey)) score += 40;
  if (isVol1Like(t)) score += 25;

  if (isDerivedEdition(t, derived)) score -= 1000;
  if (seriesKey && isMainlineVol1(t, seriesKey, derived)) score += 500;

  return score;
}

function pickBest(cands, seriesKey, derived) {
  if (!cands.length) return null;

  const withIdx = cands.map((c, i) => ({ ...c, __i: i }));
  withIdx.sort((a, b) => {
    const sa = a.score ?? 0;
    const sb = b.score ?? 0;
    if (sb !== sa) return sb - sa;

    const am = seriesKey && isMainlineVol1(a.title || "", seriesKey, derived) ? 1 : 0;
    const bm = seriesKey && isMainlineVol1(b.title || "", seriesKey, derived) ? 1 : 0;
    if (bm !== am) return bm - am;

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
 * NDL OpenSearch (no scraping)
 * - dpid固定をやめて検索母集団を広げる
 * ----------------------- */
async function ndlOpensearch({ seriesKey, derived }) {
  const q = encodeURIComponent(`${seriesKey} 1`);
  const url = `https://ndlsearch.ndl.go.jp/api/opensearch?cnt=20&q=${q}`;

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

    // item内のISBN13拾い（雑にでも良い）
    const isbn13 = (block.match(/(97[89]\d{10})/g) || [])[0] || null;

    if (!title) {
      dropped++;
      continue;
    }
    if (!titleHasSeries(title, seriesKey)) {
      dropped++;
      continue;
    }
    if (!isMainlineVol1(title, seriesKey, derived)) {
      dropped++;
      continue;
    }

    const score = scoreCandidate({ title, isbn13, seriesKey, derived });
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

async function paapiGetItems({ itemIds }) {
  // PA-API GetItems の ItemIds は ASIN を想定（BooksではISBN10が通ることがある）
  return paapiRequest({
    target: "com.amazon.paapi5.v1.ProductAdvertisingAPIv1.GetItems",
    pathUri: "/paapi5/getitems",
    bodyObj: {
      ItemIds: itemIds,
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
function extractIsbn10(item) {
  const isbns = item?.ItemInfo?.ExternalIds?.ISBNs?.DisplayValues;
  if (Array.isArray(isbns) && isbns.length) {
    const v = String(isbns[0]).replace(/[^0-9]/g, "");
    if (/^\d{10}$/.test(v)) return v;
  }
  return null;
}
function extractTitle(item) {
  return item?.ItemInfo?.Title?.DisplayValue || "";
}
function extractImage(item) {
  return item?.Images?.Primary?.Large?.URL || null;
}

async function paapiSearchMainlineVol1({ seriesKey, derived }) {
  const tries = [`${seriesKey} (1)`, `${seriesKey}（1）`, `${seriesKey} 1`, `${seriesKey} 1 コミックス`, `${seriesKey} 1 (コミックス)`];

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
      if (!isMainlineVol1(title, seriesKey, derived)) continue;

      const score = scoreCandidate({ title, isbn13, seriesKey, derived }) + (asin ? 5 : 0);
      cands.push({ source: "paapi_search", query: q, title, isbn13, asin, score });
    }

    const best = pickBest(cands, seriesKey, derived);
    results.push({ query: q, ok: true, returned: items.length, best, candidatesAll: cands });
    await sleep(900);
  }

  const bests = results.map((x) => x.best).filter(Boolean);
  const best = pickBest(bests, seriesKey, derived);
  return { tried: tries, results, best };
}

/**
 * seedHint 解決器：
 * - isbn10/asin → GetItems で直取り
 * - isbn13 → SearchItems(ISBN13) → best の asin を GetItems
 */
async function resolveBySeedHint({ seriesKey, author, hint, derived }) {
  const hintAsin = norm(hint?.vol1Asin || "") || null;
  const hintIsbn10 = norm(hint?.vol1Isbn10 || "") || null;
  const hintIsbn13 = norm(hint?.vol1Isbn13 || "") || null;

  const debug = { used: true, hintAsin, hintIsbn10, hintIsbn13 };

  // 1) isbn10 / asin は GetItems
  if (hintIsbn10 || hintAsin) {
    const id = hintIsbn10 || hintAsin;
    const get = await paapiGetItems({ itemIds: [id] });
    debug.paapiGet10 = get;

    if (!get?.ok) {
      return { used: true, ok: false, reason: get?.skipped ? `paapi_skipped(${get.reason})` : `paapi_getitems_error(${get?.status ?? "unknown"})`, debug };
    }

    const item = get?.json?.ItemsResult?.Items?.[0] || null;
    const title = extractTitle(item);
    const isbn13 = extractIsbn13(item);
    const isbn10 = extractIsbn10(item);
    const asin = item?.ASIN || null;

    if (!title || !isMainlineVol1(title, seriesKey, derived) || !isbn13) {
      return { used: true, ok: false, reason: !isbn13 ? "seed_hint_getitems_no_ean" : "seed_hint_final_guard_failed", debug };
    }

    return {
      used: true,
      ok: true,
      confirmed: {
        seriesKey,
        author,
        vol1: {
          title,
          isbn13,
          image: extractImage(item) || null,
          amazonDp: dpFromAsinOrIsbn(asin || isbn10 || isbn13),
          source: "seed_hint(id10_or_asin_getitems)+mainline_guard",
        },
      },
      debug: { ...debug, resolvedBy: "getitems10_or_asin", title, isbn13, asin },
    };
  }

  // 2) isbn13 は SearchItems → GetItems
  if (hintIsbn13) {
    const s = await paapiSearchItems({ keywords: hintIsbn13 });
    debug.paapiSearch13 = s;

    if (!s?.ok) {
      return { used: true, ok: false, reason: s?.skipped ? `paapi_skipped(${s.reason})` : `paapi_searchitems_error(${s?.status ?? "unknown"})`, debug };
    }

    const items = s?.json?.SearchResult?.Items || [];
    const cands = [];
    for (const it of items) {
      const title = extractTitle(it);
      const asin = it?.ASIN || null;
      const isbn13 = extractIsbn13(it);
      if (!asin) continue;
      if (!isMainlineVol1(title, seriesKey, derived)) continue;
      const score = scoreCandidate({ title, isbn13, seriesKey, derived }) + 10;
      cands.push({ source: "paapi_search(isbn13)", query: hintIsbn13, title, isbn13, asin, score });
    }

    const best = pickBest(cands, seriesKey, derived);
    debug.bestFromIsbn13Search = best;

    if (!best?.asin) {
      return { used: true, ok: false, reason: "seed_hint_isbn13_no_mainline_hit", debug };
    }

    const get = await paapiGetItems({ itemIds: [best.asin] });
    debug.paapiGetFromIsbn13 = get;

    if (!get?.ok) {
      return { used: true, ok: false, reason: get?.skipped ? `paapi_skipped(${get.reason})` : `paapi_getitems_error(${get?.status ?? "unknown"})`, debug };
    }

    const item = get?.json?.ItemsResult?.Items?.[0] || null;
    const title = extractTitle(item) || best.title || "";
    const isbn13 = extractIsbn13(item) || best.isbn13 || null;

    if (!isMainlineVol1(title, seriesKey, derived) || !isbn13) {
      return { used: true, ok: false, reason: !isbn13 ? "seed_hint_isbn13_getitems_no_ean" : "seed_hint_isbn13_final_guard_failed", debug };
    }

    return {
      used: true,
      ok: true,
      confirmed: {
        seriesKey,
        author,
        vol1: {
          title,
          isbn13,
          image: extractImage(item) || null,
          amazonDp: dpFromAsinOrIsbn(best.asin),
          source: "seed_hint(isbn13_search_then_getitems)+mainline_guard",
        },
      },
      debug: { ...debug, resolvedBy: "isbn13_search_then_getitems", title, isbn13, asin: best.asin },
    };
  }

  return { used: false, ok: false, reason: "no_hint" };
}

/* -----------------------
 * main
 * ----------------------- */
async function main() {
  const seeds = await loadJson(SEEDS_PATH, { items: [] });
  const seedItems = Array.isArray(seeds?.items) ? seeds.items : [];
  const derived = await loadDerivedWords();

  const confirmed = [];
  const todo = [];
  const debugAll = [];

  for (const s of seedItems) {
    const seriesKey = norm(s?.seriesKey);
    const author = norm(s?.author) || null;
    if (!seriesKey) continue;

    const one = { seriesKey };

    // 0) seedHint（任意）
    const seedHint = s?.vol1 || null;
    if (seedHint && (seedHint.vol1Asin || seedHint.vol1Isbn10 || seedHint.vol1Isbn13)) {
      one.seedHint = {
        vol1Isbn10: seedHint.vol1Isbn10 || null,
        vol1Isbn13: seedHint.vol1Isbn13 || null,
        vol1Asin: seedHint.vol1Asin || null,
      };

      const r = await resolveBySeedHint({ seriesKey, author, hint: seedHint, derived });
      one.seedHintResult = r;

      if (r?.ok && r?.confirmed) {
        confirmed.push(r.confirmed);
        debugAll.push(one);
        await sleep(600);
        continue;
      }
      // hint失敗しても通常ルートへ落とす（ただしデバッグは残す）
    }

    // 1) NDL（本線1巻だけ候補化）
    let ndl;
    try {
      ndl = await ndlOpensearch({ seriesKey, derived });
    } catch (e) {
      ndl = { error: String(e?.message || e) };
    }
    one.ndl = ndl;

    const ndlBest = pickBest(ndl?.candidates || [], seriesKey, derived);

    // NDLで本線1巻が取れたら、PA-APIで画像/ISBN補完
    if (ndlBest) {
      const pa = await paapiSearchItems({ keywords: ndlBest.isbn13 || `${seriesKey} (1)` });
      one.paapiProbe = pa;

      let image = null;
      let isbn13 = ndlBest.isbn13 || null;
      let asin = null;

      if (pa?.ok) {
        const items = pa?.json?.SearchResult?.Items || [];
        const hit = items.find((it) => {
          const t = extractTitle(it);
          return isMainlineVol1(t, seriesKey, derived);
        });
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
      debugAll.push(one);
      await sleep(600);
      continue;
    }

    // 2) PA-API検索（本線1巻だけ候補化）
    const paSearch = await paapiSearchMainlineVol1({ seriesKey, derived });
    one.paapiSearch = paSearch;

    const b = paSearch?.best;
    if (!b?.asin) {
      todo.push({
        seriesKey,
        author,
        reason: paSearch?.skipped ? `paapi_skipped(${paSearch.reason})` : "no_mainline_vol1_candidate",
        best: b || null,
      });
      debugAll.push(one);
      await sleep(600);
      continue;
    }

    const get = await paapiGetItems({ itemIds: [b.asin] });
    one.paapiGet = get;

    if (!get?.ok) {
      todo.push({
        seriesKey,
        author,
        reason: get?.skipped ? `paapi_skipped(${get.reason})` : `paapi_getitems_error(${get?.status ?? "unknown"})`,
        best: b,
      });
      debugAll.push(one);
      await sleep(600);
      continue;
    }

    const item = get?.json?.ItemsResult?.Items?.[0] || null;
    const title = extractTitle(item) || b.title || "";
    const isbn13 = extractIsbn13(item) || b.isbn13 || null;

    if (!isMainlineVol1(title, seriesKey, derived) || !isbn13) {
      todo.push({
        seriesKey,
        author,
        reason: !isbn13 ? "paapi_getitems_no_ean" : "final_guard_failed",
        best: b,
      });
      debugAll.push(one);
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
    debugAll.push(one);
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
    derivedWords: derived?.raw || {},
    items: debugAll,
  });

  console.log(`[lane2] seeds=${seedItems.length} confirmed=${confirmed.length} todo=${todo.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
