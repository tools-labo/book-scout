// scripts/lane2/enrich_lane2.mjs
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const IN_SERIES = "data/lane2/series.json";
const OUT_ENRICHED = "data/lane2/enriched.json";
const OUT_DEBUG = "data/lane2/debug_enrich.json";

// 軽キャッシュ（Actionsでも効く：リポジトリに残る）
const CACHE_DIR = "data/lane2/cache";
const CACHE_OPENBD = `${CACHE_DIR}/openbd.json`;
const CACHE_ANILIST = `${CACHE_DIR}/anilist.json`;
const CACHE_PAAPI = `${CACHE_DIR}/paapi.json`; // ISBN13→ASIN
const CACHE_WIKIDATA = `${CACHE_DIR}/wikidata.json`; // ★追加：Wikidata

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
function uniq(arr) {
  const out = [];
  const seen = new Set();
  for (const x of arr || []) {
    const v = norm(x);
    if (!v) continue;
    const k = v.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out;
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

function stripHtml(s) {
  const x = String(s ?? "");
  return x
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// -----------------------
// 表示用：ジャンル辞書（辞書に無いものは非表示）
// -----------------------
const GENRE_JA = {
  Action: "アクション",
  Adventure: "冒険",
  Comedy: "コメディ",
  Drama: "ドラマ",
  Fantasy: "ファンタジー",
  Horror: "ホラー",
  Mystery: "ミステリー",
  Psychological: "心理",
  Romance: "恋愛",
  "Sci-Fi": "SF",
  "Slice of Life": "日常",
  Sports: "スポーツ",
  Supernatural: "超常",
  Thriller: "サスペンス",
};

// -----------------------
// dp から「10桁ASIN or 13桁ISBN」を安全に取り出す
// -----------------------
function parseAmazonDpId(amazonDp) {
  const u = String(amazonDp ?? "");
  const m = u.match(/\/dp\/([A-Z0-9]{10,13})/i);
  if (!m) return { asin: null, isbn13FromDp: null };

  const id = m[1].toUpperCase();

  if (/^[A-Z0-9]{10}$/.test(id)) return { asin: id, isbn13FromDp: null };
  if (/^\d{13}$/.test(id)) return { asin: null, isbn13FromDp: id };

  return { asin: null, isbn13FromDp: null };
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
  if (!r.ok) return { error: true, status: r.status, body: text.slice(0, 1800) };
  return { ok: true, json: JSON.parse(text) };
}
async function paapiGetItems({ itemIds, resources }) {
  return paapiRequest({
    target: "com.amazon.paapi5.v1.ProductAdvertisingAPIv1.GetItems",
    pathUri: "/paapi5/getitems",
    bodyObj: { ItemIds: itemIds, PartnerTag: AMZ_PARTNER_TAG, PartnerType: "Associates", Resources: resources },
  });
}
async function paapiSearchItems({ keywords, resources, itemCount = 10 }) {
  return paapiRequest({
    target: "com.amazon.paapi5.v1.ProductAdvertisingAPIv1.SearchItems",
    pathUri: "/paapi5/searchitems",
    bodyObj: {
      Keywords: keywords,
      SearchIndex: "Books",
      ItemCount: itemCount,
      PartnerTag: AMZ_PARTNER_TAG,
      PartnerType: "Associates",
      Resources: resources,
    },
  });
}

function extractTitle(item) {
  return item?.ItemInfo?.Title?.DisplayValue || "";
}
function extractImage(item) {
  return item?.Images?.Primary?.Large?.URL || null;
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
function extractPublisher(item) {
  const brand = item?.ItemInfo?.ByLineInfo?.Brand?.DisplayValue || null;
  const manufacturer = item?.ItemInfo?.ByLineInfo?.Manufacturer?.DisplayValue || null;
  return { brand, manufacturer };
}
function extractContributors(item) {
  const arr = item?.ItemInfo?.ByLineInfo?.Contributors;
  if (!Array.isArray(arr)) return [];
  return arr
    .map((x) => ({ name: x?.Name ?? null, role: x?.Role ?? null, roleType: x?.RoleType ?? null }))
    .filter((x) => x.name);
}
function extractReleaseDate(item) {
  const ci = item?.ItemInfo?.ContentInfo;
  const pi = item?.ItemInfo?.ProductInfo;
  const candidates = [
    ci?.PublicationDate?.DisplayValue,
    ci?.ReleaseDate?.DisplayValue,
    pi?.ReleaseDate?.DisplayValue,
    pi?.PublicationDate?.DisplayValue,
  ]
    .map((x) => (x == null ? null : String(x).trim()))
    .filter(Boolean);
  return candidates.length ? candidates[0] : null;
}

function isInvalidResourceError(rawBody) {
  const s = String(rawBody ?? "");
  return s.includes("InvalidParameterValue") && s.includes("provided in the request for Resources is invalid");
}

async function getItemWithResourceProbe({ asin, debugSteps }) {
  const base = ["ItemInfo.Title", "ItemInfo.ByLineInfo", "ItemInfo.ExternalIds", "Images.Primary.Large"];
  const optionalCandidates = ["ItemInfo.ContentInfo", "ItemInfo.ProductInfo", "EditorialReviews", "EditorialReviews.EditorialReview"];

  let okJson = null;
  let okResources = base.slice();

  async function callWithRetry(resources, label) {
    let wait = 900;
    for (let i = 0; i < 4; i++) {
      const res = await paapiGetItems({ itemIds: [asin], resources });
      if (res?.ok) return { ok: true, res };
      if (res?.skipped) return { ok: false, skipped: true, res };
      if (res?.error && res.status === 429) {
        debugSteps.retries = debugSteps.retries || [];
        debugSteps.retries.push({ label, attempt: i + 1, status: 429, waitMs: wait });
        await sleep(wait);
        wait *= 2;
        continue;
      }
      return { ok: false, res };
    }
    return { ok: false, res: { error: true, status: 429, body: "retry_exhausted" } };
  }

  // base
  {
    const got = await callWithRetry(okResources, "base");
    debugSteps.base = got?.res ?? null;
    if (!got?.ok) {
      return {
        ok: false,
        reason: got?.skipped ? `paapi_skipped(${got.res.reason})` : `paapi_getitems_error(${got?.res?.status ?? "unknown"})`,
        raw: got?.res,
      };
    }
    okJson = got.res.json;
  }

  // optional probe
  debugSteps.probe = [];
  for (const opt of optionalCandidates) {
    const trial = okResources.concat([opt]);
    const got = await callWithRetry(trial, `probe:${opt}`);

    if (got?.ok) {
      okResources = trial;
      okJson = got.res.json;
      debugSteps.probe.push({ resource: opt, adopted: true });
      await sleep(650);
      continue;
    }
    if (got?.res?.error && got.res.status === 400 && isInvalidResourceError(got.res.body)) {
      debugSteps.probe.push({ resource: opt, adopted: false, reason: "invalid_resource" });
      await sleep(650);
      continue;
    }
    debugSteps.probe.push({ resource: opt, adopted: false, reason: `error(${got?.res?.status ?? "unknown"})` });
    await sleep(650);
  }

  const item = okJson?.ItemsResult?.Items?.[0] || null;
  if (!item) return { ok: false, reason: "no_item", raw: okJson };

  return { ok: true, item, usedResources: okResources };
}

async function resolveAsinByIsbn13({ isbn13, cache, debugSteps }) {
  const key = norm(isbn13);
  if (!/^97[89]\d{10}$/.test(key)) return { ok: false, reason: "invalid_isbn13" };

  if (cache[key]) {
    debugSteps.paapiResolve = { cached: true, asin: cache[key] };
    return { ok: true, asin: cache[key], cached: true };
  }

  const resources = ["ItemInfo.ExternalIds", "ItemInfo.Title"];
  let wait = 900;

  for (let i = 0; i < 4; i++) {
    const res = await paapiSearchItems({ keywords: key, resources, itemCount: 10 });

    if (res?.skipped) {
      debugSteps.paapiResolve = { cached: false, ok: false, skipped: true, reason: res.reason };
      return { ok: false, reason: `paapi_skipped(${res.reason})` };
    }

    if (res?.error && res.status === 429) {
      debugSteps.retries = debugSteps.retries || [];
      debugSteps.retries.push({ label: "paapi_search_isbn13", attempt: i + 1, status: 429, waitMs: wait });
      await sleep(wait);
      wait *= 2;
      continue;
    }

    if (!res?.ok) {
      debugSteps.paapiResolve = { cached: false, ok: false, status: res?.status ?? "unknown", body: res?.body ?? null };
      return { ok: false, reason: `paapi_search_error(${res?.status ?? "unknown"})` };
    }

    const items = res?.json?.SearchResult?.Items || [];
    const hit =
      items.find((it) => {
        const e = extractIsbn13(it);
        return e === key;
      }) || null;

    const asin = hit?.ASIN || null;
    debugSteps.paapiResolve = { cached: false, ok: true, found: !!asin, returned: items.length, asin };

    if (asin) {
      cache[key] = asin;
      return { ok: true, asin, cached: false };
    }

    return { ok: false, reason: "asin_not_found_by_isbn13" };
  }

  return { ok: false, reason: "paapi_search_retry_exhausted" };
}

/* -----------------------
 * openBD（ISBN→日本語あらすじ等）
 * ----------------------- */
async function fetchOpenBdByIsbn13({ isbn13, cache, debugSteps }) {
  if (!isbn13) return { ok: false, reason: "no_isbn13" };

  if (Object.prototype.hasOwnProperty.call(cache, isbn13)) {
    debugSteps.openbd = { cached: true };
    return { ok: true, data: cache[isbn13], cached: true };
  }

  const url = `https://api.openbd.jp/v1/get?isbn=${encodeURIComponent(isbn13)}`;
  let r;
  try {
    r = await fetch(url, { headers: { "user-agent": "tools-labo/book-scout lane2 openbd" } });
  } catch (e) {
    debugSteps.openbd = { cached: false, ok: false, error: String(e?.message || e) };
    return { ok: false, reason: "openbd_fetch_error" };
  }

  if (!r.ok) {
    debugSteps.openbd = { cached: false, ok: false, status: r.status };
    return { ok: false, reason: `openbd_http_${r.status}` };
  }

  let json;
  try {
    json = await r.json();
  } catch {
    debugSteps.openbd = { cached: false, ok: false, reason: "json_parse_error" };
    return { ok: false, reason: "openbd_json_parse_error" };
  }

  const first = Array.isArray(json) ? json[0] : null;
  cache[isbn13] = first ?? null;

  debugSteps.openbd = { cached: false, ok: true, found: !!first };
  return { ok: true, data: first ?? null, found: !!first };
}
function extractFromOpenBd(openbdObj) {
  if (!openbdObj) return { description: null, pubdate: null, publisher: null };

  const summary = openbdObj?.summary || null;
  const onix = openbdObj?.onix || null;

  const description =
    summary?.description ||
    summary?.content ||
    onix?.CollateralDetail?.TextContent?.[0]?.Text ||
    null;

  const pubdate = summary?.pubdate || null;
  const publisher = summary?.publisher || null;

  return {
    description: description ? stripHtml(description) : null,
    pubdate: pubdate ? String(pubdate).trim() : null,
    publisher: publisher ? String(publisher).trim() : null,
  };
}

/* -----------------------
 * AniList（ジャンルだけ使う：辞書で日本語化、辞書外は捨てる）
 * ----------------------- */
async function fetchAniListBySeriesKey({ seriesKey, cache, debugSteps }) {
  const key = norm(seriesKey);
  if (!key) return { ok: false, reason: "no_seriesKey" };

  if (Object.prototype.hasOwnProperty.call(cache, key)) {
    debugSteps.anilist = { cached: true };
    return { ok: true, data: cache[key], cached: true };
  }

  const query = `
    query ($search: String) {
      Page(perPage: 10) {
        media(search: $search, type: MANGA) {
          id
          title { romaji english native }
          synonyms
          format
          genres
          description(asHtml: false)
        }
      }
    }
  `;

  let r;
  try {
    r = await fetch("https://graphql.anilist.co", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "accept": "application/json",
        "user-agent": "tools-labo/book-scout lane2 anilist",
      },
      body: JSON.stringify({ query, variables: { search: key } }),
    });
  } catch (e) {
    debugSteps.anilist = { cached: false, ok: false, error: String(e?.message || e) };
    return { ok: false, reason: "anilist_fetch_error" };
  }

  if (!r.ok) {
    const text = await r.text().catch(() => "");
    debugSteps.anilist = { cached: false, ok: false, status: r.status, body: text.slice(0, 300) };
    return { ok: false, reason: `anilist_http_${r.status}` };
  }

  let json;
  try {
    json = await r.json();
  } catch {
    debugSteps.anilist = { cached: false, ok: false, reason: "json_parse_error" };
    return { ok: false, reason: "anilist_json_parse_error" };
  }

  const list = json?.data?.Page?.media;
  if (!Array.isArray(list)) {
    cache[key] = null;
    debugSteps.anilist = { cached: false, ok: true, found: false };
    return { ok: true, data: null, found: false };
  }

  const s0 = normLoose(toHalfWidth(key));
  function scoreMedia(m) {
    let score = 0;
    const titles = [
      m?.title?.native,
      m?.title?.romaji,
      m?.title?.english,
      ...(Array.isArray(m?.synonyms) ? m.synonyms : []),
    ]
      .filter(Boolean)
      .map((t) => normLoose(toHalfWidth(t)));

    if (titles.some((t) => t === s0)) score += 1000;
    if (titles.some((t) => t.includes(s0))) score += 300;

    const fmt = String(m?.format || "");
    if (fmt === "MANGA") score += 40;
    if (fmt === "ONE_SHOT") score += 10;

    if (Array.isArray(m?.genres) && m.genres.length) score += 10;
    return score;
  }

  const withScore = list.map((m) => ({ m, score: scoreMedia(m) }));
  withScore.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const best = withScore[0]?.m || null;

  cache[key] = best ?? null;
  debugSteps.anilist = { cached: false, ok: true, found: !!best, pickedScore: withScore[0]?.score ?? null };
  return { ok: true, data: best, found: !!best };
}
function extractGenresFromAniList(media) {
  const genres = Array.isArray(media?.genres) ? media.genres.filter(Boolean) : [];
  // ★辞書にあるものだけ日本語化
  const ja = genres.map((g) => GENRE_JA[g]).filter(Boolean);
  return uniq(ja).slice(0, 6);
}

/* -----------------------
 * Wikidata（日本語ラベルだけで：連載誌 + タグ）
 * スクレイピングなし：Wikidata APIのみ
 * ----------------------- */
async function wikidataSearchJa({ q }) {
  const url = `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(
    q
  )}&language=ja&uselang=ja&format=json&limit=7&origin=*`;
  const r = await fetch(url, { headers: { "user-agent": "tools-labo/book-scout lane2 wikidata" } });
  if (!r.ok) throw new Error(`wikidata_search_http_${r.status}`);
  return await r.json();
}

async function wikidataGetEntities({ ids }) {
  const url = `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${encodeURIComponent(
    ids.join("|")
  )}&props=labels|claims|sitelinks&languages=ja&format=json&origin=*`;
  const r = await fetch(url, { headers: { "user-agent": "tools-labo/book-scout lane2 wikidata" } });
  if (!r.ok) throw new Error(`wikidata_get_http_${r.status}`);
  return await r.json();
}

function pickBestWikidataEntity({ searchJson, seriesKey }) {
  const list = Array.isArray(searchJson?.search) ? searchJson.search : [];
  if (!list.length) return null;

  const s0 = normLoose(toHalfWidth(seriesKey));
  function score(it) {
    let sc = 0;
    const label = norm(it?.label);
    const desc = norm(it?.description);

    const l0 = normLoose(toHalfWidth(label));
    if (l0 === s0) sc += 1000;
    if (l0.includes(s0) || s0.includes(l0)) sc += 300;

    // 作品っぽいdescを少しだけ優遇
    if (/漫画|マンガ|作品|コミック|comic|manga/i.test(desc)) sc += 30;
    return sc;
  }

  const withScore = list.map((it) => ({ it, score: score(it) }));
  withScore.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  return withScore[0]?.it || null;
}

function extractEntityIdsFromClaims(claims, prop) {
  const arr = claims?.[prop];
  if (!Array.isArray(arr)) return [];
  const ids = [];
  for (const c of arr) {
    const v = c?.mainsnak?.datavalue?.value;
    const id = v?.id;
    if (typeof id === "string" && /^Q\d+$/.test(id)) ids.push(id);
  }
  return ids;
}

function isJapaneseLabel(s) {
  const x = norm(s);
  if (!x) return false;
  // ひらがな/カタカナ/漢字が含まれるなら「日本語っぽい」扱いでOK
  return /[\u3040-\u30ff\u3400-\u9fff]/.test(x);
}

function cleanWdTag(s) {
  const x = norm(s);
  if (!x) return null;
  if (x.length > 24) return null;
  if (/^Q\d+$/.test(x)) return null;

  // 露骨に汎用すぎるのは落とす（ノイズ対策）
  const ng = [
    "漫画", "日本の漫画", "作品", "日本の作品", "コミック", "物語",
    "フィクション", "シリーズ", "出版", "出版社"
  ];
  if (ng.includes(x)) return null;

  if (!isJapaneseLabel(x)) return null;
  return x;
}

async function fetchWikidataBySeriesKey({ seriesKey, cache, debugSteps }) {
  const key = norm(seriesKey);
  if (!key) return { ok: false, reason: "no_seriesKey" };

  if (Object.prototype.hasOwnProperty.call(cache, key)) {
    debugSteps.wikidata = { cached: true };
    return { ok: true, data: cache[key], cached: true };
  }

  let searchJson;
  try {
    searchJson = await wikidataSearchJa({ q: key });
  } catch (e) {
    debugSteps.wikidata = { cached: false, ok: false, error: String(e?.message || e) };
    cache[key] = null;
    return { ok: false, reason: "wikidata_search_error" };
  }

  const best = pickBestWikidataEntity({ searchJson, seriesKey: key });
  if (!best?.id) {
    debugSteps.wikidata = { cached: false, ok: true, found: false };
    cache[key] = null;
    return { ok: true, data: null, found: false };
  }

  let entJson;
  try {
    entJson = await wikidataGetEntities({ ids: [best.id] });
  } catch (e) {
    debugSteps.wikidata = { cached: false, ok: false, error: String(e?.message || e) };
    cache[key] = null;
    return { ok: false, reason: "wikidata_get_error" };
  }

  const ent = entJson?.entities?.[best.id] || null;
  if (!ent) {
    debugSteps.wikidata = { cached: false, ok: true, found: false };
    cache[key] = null;
    return { ok: true, data: null, found: false };
  }

  // 取りたいプロパティ
  // - 連載誌: P1433
  // - タグ候補: P136(ジャンル), P921(主題), P840(舞台), P4110(架空世界の舞台 など作品によって), P31(インスタンス)はノイズ出やすいので使わない
  const claims = ent?.claims || {};
  const magIds = extractEntityIdsFromClaims(claims, "P1433");
  const tagIds = uniq([
    ...extractEntityIdsFromClaims(claims, "P136"),
    ...extractEntityIdsFromClaims(claims, "P921"),
    ...extractEntityIdsFromClaims(claims, "P840"),
    ...extractEntityIdsFromClaims(claims, "P2579"), // studied by（たまに主題が混じる）
  ]);

  const needIds = uniq([...magIds, ...tagIds]).filter((x) => /^Q\d+$/.test(x));
  let labels = {};
  if (needIds.length) {
    // wbgetentities は複数 ids をまとめて取れる
    try {
      const chunk = [];
      // URL長対策：最大40個くらいで分割
      for (let i = 0; i < needIds.length; i += 40) chunk.push(needIds.slice(i, i + 40));
      for (const ids of chunk) {
        const jj = await wikidataGetEntities({ ids });
        const ents = jj?.entities || {};
        for (const [id, e] of Object.entries(ents)) {
          const lab = e?.labels?.ja?.value || null;
          if (lab) labels[id] = lab;
        }
        await sleep(200);
      }
    } catch {
      // ラベル取得失敗でも致命ではない
    }
  }

  const magazine = magIds.map((id) => labels[id]).map(cleanWdTag).filter(Boolean)[0] || null;

  const tags = tagIds
    .map((id) => labels[id])
    .map(cleanWdTag)
    .filter(Boolean);

  const out = {
    qid: best.id,
    magazine,
    tags: uniq(tags).slice(0, 12),
  };

  cache[key] = out;
  debugSteps.wikidata = { cached: false, ok: true, found: true, qid: best.id, magazine: !!magazine, tags: out.tags.length };
  return { ok: true, data: out, found: true };
}

/* -----------------------
 * main
 * ----------------------- */
async function main() {
  const series = await loadJson(IN_SERIES, { items: [] });
  const items = Array.isArray(series?.items) ? series.items : [];

  const cacheOpenbd = (await loadJson(CACHE_OPENBD, {})) || {};
  const cacheAniList = (await loadJson(CACHE_ANILIST, {})) || {};
  const cachePaapi = (await loadJson(CACHE_PAAPI, {})) || {};
  const cacheWikidata = (await loadJson(CACHE_WIKIDATA, {})) || {};

  const enriched = [];
  const debug = [];

  let ok = 0;
  let ng = 0;

  for (const x of items) {
    const seriesKey = norm(x?.seriesKey);
    const author = norm(x?.author);
    const lane2Title = x?.vol1?.title ?? null;
    const isbn13 = x?.vol1?.isbn13 ?? null;
    const amazonDp = x?.vol1?.amazonDp ?? null;

    const one = {
      seriesKey,
      author,
      input: { lane2Title, isbn13, amazonDp, source: x?.vol1?.source ?? null },
      steps: {},
      ok: false,
      reason: null,
      output: null,
    };

    // 0) dp から asin / isbn13 を取得
    const parsed = parseAmazonDpId(amazonDp);
    let asin = parsed.asin;
    const isbn13FromDp = parsed.isbn13FromDp;

    // 0.5) dpがISBN13だったら SearchItems で ASIN 解決（EAN一致）
    if (!asin) {
      const targetIsbn13 = isbn13FromDp || isbn13 || null;
      if (targetIsbn13) {
        const stepResolve = {};
        const rr = await resolveAsinByIsbn13({ isbn13: targetIsbn13, cache: cachePaapi, debugSteps: stepResolve });
        one.steps.resolveAsinByIsbn13 = {
          ok: !!rr.ok,
          reason: rr.ok ? null : rr.reason,
          isbn13: targetIsbn13,
          raw: stepResolve.paapiResolve || null,
          retries: stepResolve.retries || null,
        };
        if (rr.ok) asin = rr.asin;
      }
    }

    if (!asin) {
      one.reason = "no_asin_resolved";
      debug.push(one);
      ng++;
      await sleep(350);
      continue;
    }

    // 1) PA-API GetItems（タイトル正、書影、出版社、発売日など）
    const stepPa = {};
    const got = await getItemWithResourceProbe({ asin, debugSteps: stepPa });
    one.steps.getItemByAsin = {
      ok: !!got.ok,
      reason: got.ok ? null : got.reason,
      asin,
      raw: got.ok ? { usedResources: got.usedResources } : got.raw,
      probe: stepPa.probe || null,
      retries: stepPa.retries || null,
    };

    if (!got.ok) {
      one.ok = false;
      one.reason = got.reason;
      debug.push(one);
      ng++;
      await sleep(650);
      continue;
    }

    const item = got.item;

    const paTitle = extractTitle(item) || null;
    const paIsbn13 = extractIsbn13(item) || null;
    const paReleaseDate = extractReleaseDate(item) || null;

    const finalTitle = paTitle || lane2Title || seriesKey || null;

    // 2) openBD（日本語あらすじ本命）
    const stepOpenbd = {};
    const ob = await fetchOpenBdByIsbn13({
      isbn13: paIsbn13 || isbn13 || isbn13FromDp || null,
      cache: cacheOpenbd,
      debugSteps: stepOpenbd,
    });
    one.steps.openbd = stepOpenbd.openbd || null;

    const obx = ob?.ok ? extractFromOpenBd(ob.data) : { description: null, pubdate: null, publisher: null };

    // 3) AniList（ジャンルだけ：辞書にあるものだけ）
    const stepAni = {};
    const an = await fetchAniListBySeriesKey({ seriesKey, cache: cacheAniList, debugSteps: stepAni });
    one.steps.anilist = stepAni.anilist || null;

    const genresJa = an?.ok ? extractGenresFromAniList(an.data) : [];

    // 4) Wikidata（連載誌 + タグ：日本語ラベルだけ）
    const stepWd = {};
    const wd = await fetchWikidataBySeriesKey({ seriesKey, cache: cacheWikidata, debugSteps: stepWd });
    one.steps.wikidata = stepWd.wikidata || null;

    const wdMagazine = wd?.ok ? wd.data?.magazine || null : null;
    const wdTags = wd?.ok ? (Array.isArray(wd.data?.tags) ? wd.data.tags : []) : [];

    // あらすじ：英語は表示しない方針 → openBDのみ採用（無ければ null）
    const finalDescription = obx.description || null;
    const descriptionSource = obx.description ? "openbd" : null;

    const finalReleaseDate = paReleaseDate || obx.pubdate || null;

    const out = {
      seriesKey,
      author,
      vol1: {
        title: finalTitle,
        titleLane2: lane2Title,
        isbn13: paIsbn13 || isbn13 || isbn13FromDp || null,
        asin,
        image: extractImage(item) || null,
        amazonDp: `https://www.amazon.co.jp/dp/${asin}`,
        publisher: extractPublisher(item),
        contributors: extractContributors(item),

        releaseDate: finalReleaseDate,
        description: finalDescription,
        descriptionSource,

        // ★日本語化済みジャンル（辞書内だけ）
        genres: genresJa,

        // ★日本語ラベルだけのタグ（翻訳しない）
        tags: uniq(wdTags).slice(0, 12),

        // ★連載誌（日本語ラベルだけ）
        magazine: wdMagazine,

        meta: {
          wikidataQid: wd?.ok ? wd.data?.qid || null : null,
        },

        source: "enrich(paapi+openbd+anilist_genre+wikidata_tags)",
      },
    };

    one.ok = true;
    one.output = out;
    debug.push(one);
    enriched.push(out);
    ok++;

    await sleep(900);
  }

  await saveJson(OUT_ENRICHED, {
    updatedAt: nowIso(),
    total: items.length,
    enriched: enriched.length,
    items: enriched,
  });

  await saveJson(OUT_DEBUG, {
    updatedAt: nowIso(),
    total: items.length,
    ok,
    ng,
    items: debug,
  });

  await saveJson(CACHE_OPENBD, cacheOpenbd);
  await saveJson(CACHE_ANILIST, cacheAniList);
  await saveJson(CACHE_PAAPI, cachePaapi);
  await saveJson(CACHE_WIKIDATA, cacheWikidata);

  console.log(`[lane2:enrich] total=${items.length} enriched=${enriched.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
