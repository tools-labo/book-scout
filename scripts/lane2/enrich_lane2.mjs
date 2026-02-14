// scripts/lane2/enrich_lane2.mjs
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const IN_SERIES = "data/lane2/series.json";
const IN_MAG_OVERRIDES = "data/lane2/magazine_overrides.json";

const TAG_JA_MAP = "data/lane2/tag_ja_map.json";
const TAG_HIDE = "data/lane2/tag_hide.json";
const TAG_TODO = "data/lane2/tags_todo.json";

const CACHE_DIR = "data/lane2/cache";
const CACHE_ANILIST = `${CACHE_DIR}/anilist.json`;
const CACHE_WIKI = `${CACHE_DIR}/wiki.json`;
const CACHE_AMZ = `${CACHE_DIR}/amazon.json`;

const OUT_ENRICHED = "data/lane2/enriched.json";
const OUT_MAG_TODO = "data/lane2/magazine_todo.json";

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

function norm(s) {
  return String(s ?? "").trim();
}
function toHalfWidth(s) {
  return String(s ?? "")
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[（]/g, "(")
    .replace(/[）]/g, ")")
    .replace(/[　]/g, " ");
}
function normLoose(s) {
  return norm(s).replace(/\s+/g, "");
}
function uniq(arr) {
  const out = [];
  const seen = new Set();
  for (const x of arr || []) {
    const s = norm(x);
    if (!s) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* -----------------------
 * HTML strip / decode
 * ----------------------- */
function stripHtml(s) {
  const x = String(s ?? "");

  // 1回で &amp;#91; のような「エスケープされた数値参照」もデコードする
  const decodeHtmlEntities = (t) => {
    let y = String(t ?? "");

    // &amp;#91; / &amp;#x5B; を先に処理（重要）
    y = y
      .replace(/&amp;#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
      .replace(/&amp;#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)));

    // 通常の数値参照
    y = y
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
      .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)));

    // 代表的な named entity
    y = y
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");

    return y;
  };

  const t = x
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\u00A0/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return decodeHtmlEntities(t);
}

/* -----------------------
 * Tag dict
 * ----------------------- */
function loadTagMap(tagMapJson) {
  const m = tagMapJson?.map && typeof tagMapJson.map === "object" ? tagMapJson.map : {};
  const out = {};
  for (const [k, v] of Object.entries(m)) {
    const kk = norm(k);
    const vv = norm(v);
    if (!kk || !vv) continue;
    out[kk] = vv;
  }
  return out;
}
function loadHideSet(hideJson) {
  const arr = Array.isArray(hideJson?.hide) ? hideJson.hide : [];
  return new Set(arr.map((x) => norm(x)).filter(Boolean));
}
function applyTagDict({ tagsEn, tagMap, hideSet, todoSet }) {
  const outJa = [];
  const missing = [];
  for (const t of uniq(tagsEn)) {
    if (hideSet.has(t)) continue;
    const ja = tagMap[t];
    if (ja) outJa.push(ja);
    else {
      missing.push(t);
      todoSet.add(t);
    }
  }
  return { tags: uniq(outJa), tags_missing_en: uniq(missing) };
}

/* -----------------------
 * AniList (genres/tags)
 * ----------------------- */
async function fetchAniListBySeriesKey({ seriesKey, cache }) {
  const key = norm(seriesKey);
  if (!key) return { ok: false, reason: "no_seriesKey" };

  if (Object.prototype.hasOwnProperty.call(cache, key)) {
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
          tags { name rank isGeneralSpoiler }
        }
      }
    }
  `;

  const r = await fetch("https://graphql.anilist.co", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "user-agent": "tools-labo/book-scout lane2 anilist",
    },
    body: JSON.stringify({ query, variables: { search: key } }),
  });

  if (!r.ok) {
    cache[key] = null;
    return { ok: false, reason: `anilist_http_${r.status}` };
  }

  const json = await r.json();
  const list = json?.data?.Page?.media;
  if (!Array.isArray(list) || !list.length) {
    cache[key] = null;
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
    if (fmt === "ONE_SHOT") score -= 9999;

    if (Array.isArray(m?.genres) && m.genres.length) score += 10;
    if (Array.isArray(m?.tags) && m.tags.length) score += 10;
    return score;
  }

  const withScore = list.map((m) => ({ m, score: scoreMedia(m) }));
  withScore.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const best = withScore[0]?.m || null;

  cache[key] = best ?? null;
  return { ok: true, data: best, found: !!best };
}

function extractFromAniList(media) {
  if (!media) return { id: null, genres: [], tags: [] };

  const genres = Array.isArray(media?.genres) ? media.genres.filter(Boolean) : [];
  const tags =
    Array.isArray(media?.tags)
      ? media.tags
          .filter((t) => t && t.name && !t.isGeneralSpoiler)
          .sort((a, b) => (b.rank ?? 0) - (a.rank ?? 0))
          .slice(0, 30)
          .map((t) => t.name)
      : [];

  return { id: media?.id ?? null, genres, tags };
}

/* -----------------------
 * Wikipedia (magazine only)
 * ----------------------- */
async function wikiApi(params) {
  const base = "https://ja.wikipedia.org/w/api.php";
  const url = `${base}?${new URLSearchParams({ format: "json", origin: "*", ...params }).toString()}`;
  const r = await fetch(url, { headers: { "user-agent": "tools-labo/book-scout lane2 wiki" } });
  if (!r.ok) throw new Error(`wiki_http_${r.status}`);
  return await r.json();
}
function extractMagazineFromInfoboxHtml(html) {
  const h = String(html ?? "");
  const m =
    h.match(/<th[^>]*>\s*掲載誌\s*<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/) ||
    h.match(/<th[^>]*>\s*連載誌\s*<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/);
  if (!m) return null;

  const text = stripHtml(m[1]);

  // 脚注 [1] 等を除去（→ は残す）
  const cleaned = text
    .replace(/\[\s*\d+\s*\]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  return cleaned || null;
}
function wikiTitleLooksOk({ wikiTitle, seriesKey }) {
  const t = normLoose(toHalfWidth(wikiTitle ?? ""));
  const k = normLoose(toHalfWidth(seriesKey ?? ""));
  if (!t || !k) return false;
  return t === k || t.includes(k) || k.includes(t);
}

async function fetchWikiMagazineBySeriesKey({ seriesKey, cache }) {
  const key = norm(seriesKey);
  if (!key) return { ok: false, reason: "no_seriesKey" };

  if (Object.prototype.hasOwnProperty.call(cache, key)) {
    const c = cache[key];
    if (c && wikiTitleLooksOk({ wikiTitle: c?.title, seriesKey: key })) {
      return { ok: true, data: c, cached: true };
    }
  }

  let search;
  try {
    search = await wikiApi({
      action: "query",
      list: "search",
      srsearch: key,
      srlimit: "5",
      srprop: "snippet",
    });
  } catch {
    cache[key] = null;
    return { ok: false, reason: "wiki_search_error" };
  }

  const results = Array.isArray(search?.query?.search) ? search.query.search : [];
  if (!results.length) {
    cache[key] = null;
    return { ok: true, data: null, found: false };
  }

  const bestHit =
    results.find((x) => wikiTitleLooksOk({ wikiTitle: x?.title, seriesKey: key })) || null;

  if (!bestHit?.pageid) {
    cache[key] = null;
    return { ok: true, data: null, found: false };
  }

  let pageHtml = null;
  try {
    const p = await wikiApi({
      action: "parse",
      pageid: String(bestHit.pageid),
      prop: "text",
      redirects: "1",
    });
    pageHtml = p?.parse?.text?.["*"] ?? null;
  } catch {
    pageHtml = null;
  }

  const magazine = extractMagazineFromInfoboxHtml(pageHtml);
  const out = { pageid: bestHit.pageid, title: bestHit.title || null, magazine: magazine || null };
  cache[key] = out;

  return { ok: true, data: out, found: true };
}

/* -----------------------
 * Amazon PA-API (GetItems)
 * - no scraping
 * - cache by ASIN
 * ----------------------- */
function hmac(key, data, enc = null) {
  return crypto.createHmac("sha256", key).update(data, "utf8").digest(enc || undefined);
}
function sha256Hex(s) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}
function toAmzDate(d = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  const yyyy = d.getUTCFullYear();
  const mm = pad(d.getUTCMonth() + 1);
  const dd = pad(d.getUTCDate());
  const hh = pad(d.getUTCHours());
  const mi = pad(d.getUTCMinutes());
  const ss = pad(d.getUTCSeconds());
  return {
    amzDate: `${yyyy}${mm}${dd}T${hh}${mi}${ss}Z`,
    dateStamp: `${yyyy}${mm}${dd}`,
  };
}
function signKey(secretKey, dateStamp, region, service) {
  const kDate = hmac("AWS4" + secretKey, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}

async function paapiPost({ host, region, accessKey, secretKey, target, path: apiPath, payload }) {
  const service = "ProductAdvertisingAPI";
  const endpoint = `https://${host}${apiPath}`;

  const { amzDate, dateStamp } = toAmzDate(new Date());
  const contentType = "application/json; charset=utf-8";

  const canonicalUri = apiPath;
  const canonicalQuery = "";
  const canonicalHeaders =
    `content-encoding:amz-1.0\n` +
    `content-type:${contentType}\n` +
    `host:${host}\n` +
    `x-amz-date:${amzDate}\n` +
    `x-amz-target:${target}\n`;
  const signedHeaders = "content-encoding;content-type;host;x-amz-date;x-amz-target";
  const payloadHash = sha256Hex(payload);

  const canonicalRequest = [
    "POST",
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const algorithm = "AWS4-HMAC-SHA256";
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    algorithm,
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const signingKey = signKey(secretKey, dateStamp, region, service);
  const signature = hmac(signingKey, stringToSign, "hex");

  const authorization =
    `${algorithm} ` +
    `Credential=${accessKey}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, ` +
    `Signature=${signature}`;

  const r = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-encoding": "amz-1.0",
      "content-type": contentType,
      host,
      "x-amz-date": amzDate,
      "x-amz-target": target,
      Authorization: authorization,
    },
    body: payload,
  });

  const txt = await r.text();
  let json = null;
  try {
    json = JSON.parse(txt);
  } catch {
    json = null;
  }
  if (!r.ok) {
    return { ok: false, status: r.status, json, text: txt };
  }
  return { ok: true, status: r.status, json };
}

function extractPaapiItem(item) {
  if (!item) return null;

  const dp = item?.DetailPageURL ?? null;

  const img =
    item?.Images?.Primary?.Large?.URL ||
    item?.Images?.Primary?.Medium?.URL ||
    item?.Images?.Primary?.Small?.URL ||
    null;

  const title =
    item?.ItemInfo?.Title?.DisplayValue ||
    item?.ItemInfo?.Title?.Value ||
    null;

  const publisher =
    item?.ItemInfo?.ByLineInfo?.Publisher?.DisplayValue ||
    item?.ItemInfo?.ManufactureInfo?.Manufacturer?.DisplayValue ||
    null;

  const contributors = Array.isArray(item?.ItemInfo?.ByLineInfo?.Contributors)
    ? item.ItemInfo.ByLineInfo.Contributors
    : [];

  const author = contributors
    .map((c) => c?.Name)
    .filter(Boolean)
    .join(" / ") || null;

  const releaseDate =
    item?.ItemInfo?.ContentInfo?.PublicationDate?.DisplayValue ||
    item?.ItemInfo?.ContentInfo?.PublicationDate?.Value ||
    null;

  return {
    amazonDp: dp,
    image: img,
    title,
    publisher,
    author,
    releaseDate,
  };
}

async function fetchPaapiByAsins({ asins, cache, creds }) {
  const want = [];
  for (const asin of asins) {
    if (!asin) continue;
    if (Object.prototype.hasOwnProperty.call(cache, asin)) continue;
    want.push(asin);
  }
  if (!want.length) return;

  if (!creds?.enabled) {
    for (const asin of want) cache[asin] = null;
    return;
  }

  const host = creds.host;
  const region = creds.region;

  // 10件ずつ
  for (let i = 0; i < want.length; i += 10) {
    const chunk = want.slice(i, i + 10);

    const payloadObj = {
      ItemIds: chunk,
      PartnerTag: creds.partnerTag,
      PartnerType: "Associates",
      Marketplace: "www.amazon.co.jp",
      Resources: [
        "Images.Primary.Large",
        "Images.Primary.Medium",
        "Images.Primary.Small",
        "ItemInfo.Title",
        "ItemInfo.ByLineInfo",
        "ItemInfo.ContentInfo",
        "ItemInfo.ManufactureInfo",
      ],
    };

    const res = await paapiPost({
      host,
      region,
      accessKey: creds.accessKey,
      secretKey: creds.secretKey,
      target: "com.amazon.paapi5.v1.ProductAdvertisingAPIv1.GetItems",
      path: "/paapi5/getitems",
      payload: JSON.stringify(payloadObj),
    });

    if (!res.ok) {
      // 失敗した塊は null で埋める（落ちない運用）
      for (const asin of chunk) cache[asin] = null;
    } else {
      const items = res.json?.ItemsResult?.Items || [];
      const map = new Map(items.map((it) => [it?.ASIN, it]));
      for (const asin of chunk) {
        const it = map.get(asin) || null;
        cache[asin] = it ? extractPaapiItem(it) : null;
      }
    }

    await sleep(350); // 連打防止
  }
}

/* -----------------------
 * main
 * ----------------------- */
async function main() {
  const seriesJson = await loadJson(IN_SERIES, { version: 1, updatedAt: "", total: 0, items: [] });
  const items = Array.isArray(seriesJson?.items) ? seriesJson.items : [];

  const magOvJson = await loadJson(IN_MAG_OVERRIDES, { version: 1, updatedAt: "", items: {} });
  const magOverrides = magOvJson?.items && typeof magOvJson.items === "object" ? magOvJson.items : {};

  const cacheAniList = (await loadJson(CACHE_ANILIST, {})) || {};
  const cacheWiki = (await loadJson(CACHE_WIKI, {})) || {};
  const cacheAmz = (await loadJson(CACHE_AMZ, {})) || {};

  const tagMapJson = await loadJson(TAG_JA_MAP, { version: 1, updatedAt: "", map: {} });
  const tagMap = loadTagMap(tagMapJson);

  const hideJson = await loadJson(TAG_HIDE, { version: 1, updatedAt: "", hide: [] });
  const hideSet = loadHideSet(hideJson);

  const todoJson = await loadJson(TAG_TODO, { version: 1, updatedAt: "", tags: [] });
  const todoSet = new Set((todoJson?.tags || []).map((x) => norm(x)).filter(Boolean));

  // magazine todo（積み上げ）
  const magTodoPrev = await loadJson(OUT_MAG_TODO, { version: 1, updatedAt: "", items: [] });
  const magTodoSet = new Set((magTodoPrev?.items || []).map((x) => norm(x)).filter(Boolean));

  // PA-API creds
  const accessKey = norm(process.env.AMZ_ACCESS_KEY);
  const secretKey = norm(process.env.AMZ_SECRET_KEY);
  const partnerTag = norm(process.env.AMZ_PARTNER_TAG);

  const creds = {
    enabled: !!(accessKey && secretKey && partnerTag),
    accessKey,
    secretKey,
    partnerTag,
    host: norm(process.env.AMZ_HOST) || "webservices.amazon.co.jp",
    region: norm(process.env.AMZ_REGION) || "us-west-2",
  };

  // series.json を安定整列（表示＆後続処理のブレ防止）
  const sorted = items
    .map((x) => ({ ...x, seriesKey: norm(x?.seriesKey) }))
    .filter((x) => x.seriesKey)
    .sort((a, b) => a.seriesKey.localeCompare(b.seriesKey));

  // 先に ASIN 一覧を集めて PA-API をまとめて引く（キャッシュ前提）
  const asins = sorted.map((x) => norm(x?.vol1?.asin)).filter(Boolean);
  await fetchPaapiByAsins({ asins, cache: cacheAmz, creds });

  const enriched = [];
  let ok = 0;
  let ng = 0;

  for (const x of sorted) {
    const seriesKey = norm(x?.seriesKey);
    const v = x?.vol1 || {};

    const amazonUrl = norm(v?.amazonUrl) || null;
    const isbn13 = norm(v?.isbn13) || null;
    const asin = norm(v?.asin) || null;

    // 連載誌：manual override（magazine_overrides） > wiki
    const manualMag = norm(magOverrides?.[seriesKey]?.magazine) || null;

    let wikiMag = null;
    let wikiTitle = null;
    if (!manualMag) {
      const wk = await fetchWikiMagazineBySeriesKey({ seriesKey, cache: cacheWiki });
      wikiMag = wk?.ok ? (wk?.data?.magazine ?? null) : null;
      wikiTitle = wk?.ok ? (wk?.data?.title ?? null) : null;
    }
    const magazine = manualMag || wikiMag || null;

    // anilist
    const an = await fetchAniListBySeriesKey({ seriesKey, cache: cacheAniList });
    const anx = an?.ok ? extractFromAniList(an.data) : { id: null, genres: [], tags: [] };
    const applied = applyTagDict({ tagsEn: anx.tags, tagMap, hideSet, todoSet });

    // amazon PA-API（キャッシュ）
    const amz = asin ? (cacheAmz?.[asin] ?? null) : null;

    // title は manual を尊重。無ければPA-APIで補完。
    const manualTitle = norm(v?.title) || null;
    const title = manualTitle || norm(amz?.title) || null;

    // synopsis は manual のみ（運用方針）
    const synopsis = norm(v?.synopsis) || null;

    // 追加で欲しい表示項目
    const image = norm(amz?.image) || null;
    const publisher = norm(amz?.publisher) || null;
    const author = norm(amz?.author) || null;
    const releaseDate = norm(amz?.releaseDate) || null;
    const amazonDp = norm(amz?.amazonDp) || null;

    if (!magazine) magTodoSet.add(seriesKey);
    else magTodoSet.delete(seriesKey);

    enriched.push({
      seriesKey,
      vol1: {
        amazonUrl,
        amazonDp,     // ★追加（フロント用：1巻の詳細ページURL）
        isbn13,
        asin,

        title,
        synopsis,

        image,        // ★追加
        publisher,    // ★追加
        author,       // ★追加
        releaseDate,  // ★追加

        magazine,
        magazineSource: manualMag ? "manual_override" : (wikiMag ? "wikipedia" : null),
        wikiTitle,

        anilistId: anx.id,
        genres: uniq(anx.genres),
        tags_en: uniq(anx.tags),
        tags: applied.tags,
        tags_missing_en: applied.tags_missing_en,

        source: "enrich(wiki(mag)+anilist+tagdict+hide+magazine_overrides+paapi)",
      },
      meta: x?.meta || null,
    });

    ok++;
    await sleep(250); // AniList/Wiki の負荷を軽く
  }

  await saveJson(TAG_TODO, {
    version: 1,
    updatedAt: nowIso(),
    tags: Array.from(todoSet).sort((a, b) => a.localeCompare(b)),
  });

  await saveJson(OUT_MAG_TODO, {
    version: 1,
    updatedAt: nowIso(),
    total: Array.from(magTodoSet).length,
    items: Array.from(magTodoSet).sort((a, b) => a.localeCompare(b)),
  });

  await saveJson(OUT_ENRICHED, {
    updatedAt: nowIso(),
    total: sorted.length,
    ok,
    ng,
    items: enriched,
  });

  await saveJson(CACHE_ANILIST, cacheAniList);
  await saveJson(CACHE_WIKI, cacheWiki);
  await saveJson(CACHE_AMZ, cacheAmz);

  console.log(`[lane2:enrich] total=${sorted.length} ok=${ok} ng=${ng} -> ${OUT_ENRICHED}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
