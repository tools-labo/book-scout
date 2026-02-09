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
function toHalfWidth(s) {
  return String(s ?? "")
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[（]/g, "(")
    .replace(/[）]/g, ")")
    .replace(/[　]/g, " ");
}
function normalizeNdlXmlText(s) {
  return String(s ?? "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function titleHasSeries(title, seriesKey) {
  const t = normLoose(title);
  const s = normLoose(seriesKey);
  if (!t || !s) return false;
  return t.includes(s);
}
function isVol1Like(title) {
  const t = toHalfWidth(norm(title));
  if (/\(\s*1\s*\)/.test(t)) return true;
  if (/第\s*1\s*巻/.test(t)) return true;
  return /\b1\b/.test(t);
}

/**
 * 派生を弾く（タイトルだけで安全側に）
 */
function isDerivedEdition(title) {
  const t = toHalfWidth(norm(title)).toLowerCase();

  if (/全巻|巻セット|セット|box|ボックス|まとめ買い/.test(t)) return true;

  if (
    /ファンブック|副読本|ガイド|ムック|設定資料|資料集|キャラクターブック|bible|図録|公式/.test(
      t
    )
  )
    return true;

  if (/episode|外伝|番外編|スピンオフ|side\s*story/.test(t)) return true;

  if (/小説|ノベライズ|文庫/.test(t)) return true;

  if (/full\s*color|フルカラー|カラー|selection/.test(t)) return true;

  if (
    /バイリンガル|bilingual|デラックス|deluxe|英語版|翻訳|korean|韓国語|中国語|台湾|français|french|german|deutsch/.test(
      t
    )
  )
    return true;

  if (/単話|分冊|話売り|第\s*\d+\s*話/.test(t)) return true;

  if (/ポスター|画集|原画集|イラストブック|設定集|ビジュアルブック/.test(t)) return true;

  return false;
}

/**
 * “本線1巻” 判定（タイトルベース）
 */
function isMainlineVol1ByTitle(title, seriesKey) {
  const t = toHalfWidth(norm(title));
  const s = toHalfWidth(norm(seriesKey));
  if (!t || !s) return false;
  if (!titleHasSeries(t, s)) return false;
  if (!isVol1Like(t)) return false;
  if (isDerivedEdition(t)) return false;

  const idx = t.indexOf(s);
  if (idx >= 0) {
    const rest = t.slice(idx + s.length);
    if (/^\s*[-ー–—]\s*(episode|外伝)/i.test(rest)) return false;
  }
  return true;
}

/**
 * NDLは volume タグが取れることがあるので併用
 */
function isVol1FromTitleOrVolume(title, volume) {
  if (volume === 1) return true;
  return isVol1Like(title);
}

/**
 * スコアは “補助”
 * 最終確定は mainline guard を通したものだけ
 */
function scoreCandidate({ title, isbn13, seriesKey, volume }) {
  let score = 0;
  const t = norm(title);
  if (!t) return 0;

  if (isbn13) score += 80;
  if (seriesKey && titleHasSeries(t, seriesKey)) score += 40;

  if (volume === 1) score += 40;
  if (isVol1Like(t)) score += 25;

  if (isDerivedEdition(t)) score -= 1000;

  if (seriesKey && isMainlineVol1ByTitle(t, seriesKey)) score += 500;

  return score;
}

function pickBest(cands, seriesKey) {
  if (!cands.length) return null;

  const withIdx = cands.map((c, i) => ({ ...c, __i: i }));
  withIdx.sort((a, b) => {
    const sa = a.score ?? 0;
    const sb = b.score ?? 0;
    if (sb !== sa) return sb - sa;

    const am = seriesKey && isMainlineVol1ByTitle(a.title || "", seriesKey) ? 1 : 0;
    const bm = seriesKey && isMainlineVol1ByTitle(b.title || "", seriesKey) ? 1 : 0;
    if (bm !== am) return bm - am;

    const av = a.volume === 1 ? 1 : 0;
    const bv = b.volume === 1 ? 1 : 0;
    if (bv !== av) return bv - av;

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
 * NDL OpenSearch（公式APIのみ）
 * ----------------------- */

function extractNdlVolume(block) {
  const raw =
    block.match(/<dcndl:volume[^>]*>([\s\S]*?)<\/dcndl:volume>/i)?.[1] ??
    block.match(/<volume[^>]*>([\s\S]*?)<\/volume>/i)?.[1] ??
    "";
  const s = toHalfWidth(normalizeNdlXmlText(raw));
  const m = s.match(/(\d+)/);
  return m ? Number(m[1]) : null;
}

function extractNdlIsbn13(block) {
  const m = block.match(/(?:urn:isbn:)?(97[89]\d{10})/i);
  return m ? m[1] : null;
}

async function ndlOpensearch({ seriesKey, author, useCreator }) {
  const base = "https://iss.ndl.go.jp/api/opensearch";
  const params = new URLSearchParams();
  params.set("title", String(seriesKey));
  if (useCreator && author) params.set("creator", String(author));
  params.set("cnt", "50");
  const url = `${base}?${params.toString()}`;

  const r = await fetch(url, { headers: { "user-agent": "tools-labo/book-scout lane2" } });
  if (!r.ok) throw new Error(`NDL HTTP ${r.status}`);
  const xml = await r.text();

  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1]);

  const cands = [];
  let dropped = 0;
  const titleSamples = [];
  const volumeSamples = [];

  for (const block of items) {
    const titleRaw = block.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? "";
    const title = normalizeNdlXmlText(titleRaw);
    if (title && titleSamples.length < 5) titleSamples.push(title);

    const volume = extractNdlVolume(block);
    if (volume != null && volumeSamples.length < 5) volumeSamples.push(volume);

    const isbn13 = extractNdlIsbn13(block);

    if (!title) {
      dropped++;
      continue;
    }
    if (!titleHasSeries(title, seriesKey)) {
      dropped++;
      continue;
    }
    if (isDerivedEdition(title)) {
      dropped++;
      continue;
    }
    if (!isVol1FromTitleOrVolume(title, volume)) {
      dropped++;
      continue;
    }

    const score = scoreCandidate({ title, isbn13, seriesKey, volume });
    cands.push({ source: "ndl_opensearch", title, isbn13, volume, score });
  }

  return {
    url,
    mode: useCreator ? "title_creator" : "title_only",
    returned: items.length,
    candidates: cands,
    dropped,
    titleSamples,
    volumeSamples,
  };
}

/* -----------------------
 * Amazon PA-API（公式APIのみ）
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
function extractTitle(item) {
  return item?.ItemInfo?.Title?.DisplayValue || "";
}
function extractImage(item) {
  return item?.Images?.Primary?.Large?.URL || null;
}

/**
 * PA-API search（“本線1巻” だけ候補化）
 */
async function paapiSearchMainlineVol1({ seriesKey }) {
  const tries = [
    `${seriesKey} (1)`,
    `${seriesKey}（1）`,
    `${seriesKey} 1`,
    `${seriesKey} 1 コミックス`,
    `${seriesKey} 1 (コミックス)`,
  ];

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

      // ★事故防止：本線1巻だけ
      if (!isMainlineVol1ByTitle(title, seriesKey)) continue;

      const score = scoreCandidate({ title, isbn13, seriesKey, volume: null }) + (asin ? 5 : 0);
      cands.push({ source: "paapi_search", query: q, title, isbn13, asin, score });
    }

    const best = pickBest(cands, seriesKey);
    results.push({ query: q, ok: true, returned: items.length, best, candidatesAll: cands });
    await sleep(900);
  }

  const bests = results.map((x) => x.best).filter(Boolean);
  const best = pickBest(bests, seriesKey);
  return { tried: tries, results, best };
}

/* -----------------------
 * seed hint（任意）
 * ----------------------- */

function parseSeedHint(seed) {
  const vol1Isbn10 = norm(seed?.vol1Isbn10 || "");
  const vol1Isbn13 = norm(seed?.vol1Isbn13 || "");
  const vol1Asin = norm(seed?.vol1Asin || "");

  return {
    vol1Isbn10: vol1Isbn10 || null,
    vol1Isbn13: vol1Isbn13 || null,
    vol1Asin: vol1Asin || null,
  };
}

async function resolveBySeedHint({ seedHint, seriesKey }) {
  const debug = {
    used: true,
    hintAsin: seedHint.vol1Asin,
    hintIsbn10: seedHint.vol1Isbn10,
    hintIsbn13: seedHint.vol1Isbn13,
    resolvedBy: null,
    title: null,
    isbn13: null,
    asin: null,
  };

  if (seedHint.vol1Asin) {
    const pa = await paapiGetItems({ itemIds: [seedHint.vol1Asin] });
    debug.paapiGetAsin = pa;
    if (pa?.ok) {
      const item = pa?.json?.ItemsResult?.Items?.[0] || null;
      const title = extractTitle(item);
      const isbn13 = extractIsbn13(item);
      if (title && isbn13 && isMainlineVol1ByTitle(title, seriesKey)) {
        debug.resolvedBy = "getitems_asin";
        debug.title = title;
        debug.isbn13 = isbn13;
        debug.asin = seedHint.vol1Asin;
        return { ok: true, item, title, isbn13, asin: seedHint.vol1Asin, image: extractImage(item) || null, debug };
      }
    } else if (pa?.skipped) {
      return { ok: false, reason: `paapi_skipped(${pa.reason})`, debug };
    }
  }

  if (seedHint.vol1Isbn10) {
    const pa = await paapiGetItems({ itemIds: [seedHint.vol1Isbn10] });
    debug.paapiGet10 = pa;
    if (pa?.ok) {
      const item = pa?.json?.ItemsResult?.Items?.[0] || null;
      const title = extractTitle(item);
      const isbn13 = extractIsbn13(item);
      const asin = item?.ASIN || seedHint.vol1Isbn10;
      if (title && isbn13 && isMainlineVol1ByTitle(title, seriesKey)) {
        debug.resolvedBy = "getitems10";
        debug.title = title;
        debug.isbn13 = isbn13;
        debug.asin = asin;
        return { ok: true, item, title, isbn13, asin, image: extractImage(item) || null, debug };
      }
    } else if (pa?.skipped) {
      return { ok: false, reason: `paapi_skipped(${pa.reason})`, debug };
    }
  }

  if (seedHint.vol1Isbn13) {
    const s = await paapiSearchItems({ keywords: seedHint.vol1Isbn13 });
    debug.paapiSearch13 = s;
    if (s?.ok) {
      const items = s?.json?.SearchResult?.Items || [];
      const hit =
        items.find((it) => {
          const title = extractTitle(it);
          const isbn13 = extractIsbn13(it);
          return isbn13 === seedHint.vol1Isbn13 && isMainlineVol1ByTitle(title, seriesKey);
        }) || null;

      if (hit?.ASIN) {
        const g = await paapiGetItems({ itemIds: [hit.ASIN] });
        debug.paapiGetFrom13 = g;
        if (g?.ok) {
          const item = g?.json?.ItemsResult?.Items?.[0] || null;
          const title = extractTitle(item);
          const isbn13 = extractIsbn13(item);
          const asin = item?.ASIN || hit.ASIN;
          if (title && isbn13 && isMainlineVol1ByTitle(title, seriesKey)) {
            debug.resolvedBy = "isbn13_search_then_getitems";
            debug.title = title;
            debug.isbn13 = isbn13;
            debug.asin = asin;
            return { ok: true, item, title, isbn13, asin, image: extractImage(item) || null, debug };
          }
        }
      }
    } else if (s?.skipped) {
      return { ok: false, reason: `paapi_skipped(${s.reason})`, debug };
    }
  }

  return { ok: false, reason: "seed_hint_unresolved", debug };
}

/* -----------------------
 * main
 * ----------------------- */
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

    const seedHint = parseSeedHint(s);
    const hasHint = !!(seedHint.vol1Asin || seedHint.vol1Isbn10 || seedHint.vol1Isbn13);
    if (hasHint) {
      one.seedHint = seedHint;
      const r = await resolveBySeedHint({ seedHint, seriesKey });
      one.seedHintResult = r?.ok
        ? {
            ok: true,
            confirmed: {
              seriesKey,
              author,
              vol1: {
                title: r.title,
                isbn13: r.isbn13,
                image: r.image,
                amazonDp: dpFromAsinOrIsbn(r.asin || r.isbn13),
                source: r.debug?.resolvedBy ? `seed_hint(${r.debug.resolvedBy})+mainline_guard` : "seed_hint+mainline_guard",
              },
            },
            debug: r.debug,
          }
        : { ok: false, reason: r.reason, debug: r.debug };

      if (r?.ok) {
        confirmed.push({
          seriesKey,
          author,
          vol1: {
            title: r.title,
            isbn13: r.isbn13,
            image: r.image,
            amazonDp: dpFromAsinOrIsbn(r.asin || r.isbn13),
            source: r.debug?.resolvedBy ? `seed_hint(${r.debug.resolvedBy})+mainline_guard` : "seed_hint+mainline_guard",
          },
        });
        debug.push(one);
        await sleep(600);
        continue;
      }
    }

    let ndl = null;
    try {
      ndl = await ndlOpensearch({ seriesKey, author, useCreator: true });
    } catch (e) {
      ndl = { error: String(e?.message || e) };
    }
    one.ndl = ndl;

    let ndlTitleOnly = null;
    if (!ndl?.candidates?.length) {
      try {
        ndlTitleOnly = await ndlOpensearch({ seriesKey, author, useCreator: false });
      } catch (e) {
        ndlTitleOnly = { error: String(e?.message || e) };
      }
      one.ndlTitleOnly = ndlTitleOnly;
    }

    const ndlCandidates = [...(ndl?.candidates || []), ...(ndlTitleOnly?.candidates || [])];

    const ndlBest = pickBest(ndlCandidates, seriesKey);

    if (ndlBest) {
      if (!isMainlineVol1ByTitle(ndlBest.title, seriesKey)) {
        one.ndlBestRejected = { reason: "final_title_guard_failed", best: ndlBest };
      } else {
        const pa = await paapiSearchItems({ keywords: ndlBest.isbn13 || `${seriesKey} (1)` });
        one.paapiProbe = pa;

        let image = null;
        let isbn13 = ndlBest.isbn13 || null;
        let asin = null;

        if (pa?.ok) {
          const items = pa?.json?.SearchResult?.Items || [];
          const hit =
            items.find((it) => {
              const t = extractTitle(it);
              return isMainlineVol1ByTitle(t, seriesKey);
            }) || null;

          if (hit) {
            asin = hit.ASIN || null;
            image = extractImage(hit) || null;
            isbn13 = extractIsbn13(hit) || isbn13;
          }
        }

        if (!isbn13) {
          todo.push({
            seriesKey,
            author,
            reason: "ndl_best_but_no_isbn13_after_probe",
            best: ndlBest,
          });
          debug.push(one);
          await sleep(600);
          continue;
        }

        confirmed.push({
          seriesKey,
          author,
          vol1: {
            title: ndlBest.title,
            isbn13,
            image,
            amazonDp: dpFromAsinOrIsbn(asin || isbn13),
            source: "ndl(opensearch)+paapi_probe+mainline_guard",
          },
        });
        debug.push(one);
        await sleep(600);
        continue;
      }
    }

    const paSearch = await paapiSearchMainlineVol1({ seriesKey });
    one.paapiSearch = paSearch;

    const b = paSearch?.best;
    if (!b?.asin) {
      todo.push({
        seriesKey,
        author,
        reason: paSearch?.skipped ? `paapi_skipped(${paSearch.reason})` : "no_mainline_vol1_candidate",
        best: b || null,
      });
      debug.push(one);
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
      debug.push(one);
      await sleep(600);
      continue;
    }

    const item = get?.json?.ItemsResult?.Items?.[0] || null;
    const title = extractTitle(item) || b.title || "";
    const isbn13 = extractIsbn13(item) || b.isbn13 || null;

    if (!isMainlineVol1ByTitle(title, seriesKey) || !isbn13) {
      todo.push({
        seriesKey,
        author,
        reason: !isbn13 ? "paapi_getitems_no_ean" : "final_guard_failed",
        best: b,
      });
      debug.push(one);
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
