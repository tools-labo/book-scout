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
  return /第\s*\d+\s*話/.test(t) || /分冊|単話|話売り|Kindle版|電子版/i.test(t);
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

function scoreCandidate({ title, isbn13, seriesKey, author, creator }) {
  let score = 0;
  const t = norm(title);
  if (!t) return 0;

  // ISBNが同一item内で取れてる時点で強い
  if (isbn13) score += 70;

  // シリーズ名を含む（強い）
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
  if (isLikelySingleEpisode(t)) score -= 60;
  if (/総集編|公式ファンブック|特装版|限定版|ガイド|画集|FULL\s*COLOR/i.test(t)) score -= 30;

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
  // PA-APIのASINは10桁英数(B0..等)だが、日本の紙ISBN10っぽい数字がASINに来るケースもある。
  // dpは素直に入れる（Amazon側が解釈する）。
  if (!/^[A-Z0-9]{10}$/.test(a) && !/^[0-9]{10}$/.test(a)) return null;
  return `https://www.amazon.co.jp/dp/${a}`;
}

/**
 * -----------------------
 * NDL Search OpenSearch
 * -----------------------
 * 「提供DB固定」+「item内結合」だけ採用（誤confirmed潰し）
 */
async function ndlOpensearch({ seriesKey, author }) {
  const dpid = "iss-ndl-opac";
  const q = encodeURIComponent(`${seriesKey} 1`);
  const url = `https://ndlsearch.ndl.go.jp/api/opensearch?dpid=${encodeURIComponent(dpid)}&cnt=20&q=${q}`;

  const r = await fetch(url, { headers: { "user-agent": "tools-labo/book-scout lane2" } });
  if (!r.ok) throw new Error(`NDL HTTP ${r.status}`);

  const xml = await r.text();

  // itemごとに切って、そのitem内からtitle/creator/isbnを取る
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1]);

  const cands = [];
  let dropped = 0;

  for (const block of items) {
    const t = (block.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? "")
      .replace(/&amp;/g, "&")
      .trim();

    const creator = (block.match(/<(dc:creator|creator)>([\s\S]*?)<\/\1>/i)?.[2] ?? "").trim();

    // ISBNは「そのitem内」で拾う（全体から拾って当てるのは禁止）
    const isbn13 = (block.match(/(97[89]\d{10})/g) || [])[0] || null;

    if (!t || isLikelySingleEpisode(t)) {
      dropped++;
      continue;
    }

    // シリーズ名を含まない候補は危ないので落とす（誤confirmed対策）
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

  return { query: `${seriesKey} 1`, url, returned: items.length, candidates: cands, dropped };
}

/**
 * -----------------------
 * Amazon PA-API (Signer + Requests)
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
  return { amzDate: `${y}${m}${day}T${hh}${mm}${ss}Z`, dateStamp: `${y}${m}${day}` };
}

function signedPaapiRequest({ target, uri, bodyObj }) {
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

  return {
    skipped: false,
    endpoint,
    body,
    headers: {
      "content-encoding": "amz-1.0",
      "content-type": "application/json; charset=utf-8",
      host,
      "x-amz-date": xAmzDate,
      "x-amz-target": target,
      Authorization: authorizationHeader,
    },
  };
}

async function paapiSearchItems({ keywords }) {
  const signed = signedPaapiRequest({
    target: "com.amazon.paapi5.v1.ProductAdvertisingAPIv1.SearchItems",
    uri: "/paapi5/searchitems",
    bodyObj: {
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
    },
  });

  if (signed?.skipped) return signed;

  const r = await fetch(signed.endpoint, { method: "POST", headers: signed.headers, body: signed.body });
  const text = await r.text();
  if (!r.ok) return { error: true, status: r.status, body: text.slice(0, 1200) };
  return { ok: true, json: JSON.parse(text) };
}

async function paapiGetItems({ asins }) {
  const list = Array.isArray(asins) ? asins.filter(Boolean) : [];
  if (!list.length) return { error: true, status: 400, body: "missing asins" };

  const signed = signedPaapiRequest({
    target: "com.amazon.paapi5.v1.ProductAdvertisingAPIv1.GetItems",
    uri: "/paapi5/getitems",
    bodyObj: {
      ItemIds: list,
      ItemIdType: "ASIN",
      PartnerTag: AMZ_PARTNER_TAG,
      PartnerType: "Associates",
      Resources: [
        "ItemInfo.Title",
        "ItemInfo.ExternalIds",
        "ItemInfo.ByLineInfo",
        "Images.Primary.Large",
        "DetailPageURL",
      ],
    },
  });

  if (signed?.skipped) return signed;

  const r = await fetch(signed.endpoint, { method: "POST", headers: signed.headers, body: signed.body });
  const text = await r.text();
  if (!r.ok) return { error: true, status: r.status, body: text.slice(0, 1200) };
  return { ok: true, json: JSON.parse(text) };
}

function extractIsbn13(item) {
  // SearchItems側は ExternalIds.ISBN が入るケースがある
  const vals = item?.ItemInfo?.ExternalIds?.ISBN?.DisplayValues;
  if (Array.isArray(vals) && vals.length) {
    const v = String(vals[0]).replace(/[^0-9]/g, "");
    if (/^97[89]\d{10}$/.test(v)) return v;
  }
  return null;
}
function extractEan13FromGet(item) {
  // GetItems側は ExternalIds.EANs に13桁が入る（ログでもここが確定根拠）
  const vals = item?.ItemInfo?.ExternalIds?.EANs?.DisplayValues;
  if (Array.isArray(vals) && vals.length) {
    const v = String(vals[0]).replace(/[^0-9]/g, "");
    if (/^97[89]\d{10}$/.test(v)) return v;
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

/**
 * -----------------------
 * PA-API Search Vol1 (ASINを拾う)
 * -----------------------
 * SearchItemsでISBN13が取れないケースがある（Kindle/紙の混在や表示都合）。
 * そこで「ASINを拾って GetItems でEAN(=ISBN13)確定」に進めるため、
 * best は asin を必須にし、isbn13 は任意にする。
 */
function isExcludedDerivedTitle(title) {
  const t = norm(title);
  // ここは“強めに”落とす（ブルーロックは派生が多い）
  return /小説|novel|episode\s*凪|エピソード\s*凪|ファンブック|劇場版|キャラクターブック/i.test(t);
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
    const candidatesAll = [];
    let best = null;

    for (const it of items) {
      const title = extractTitle(it);
      const isbn13 = extractIsbn13(it); // 取れればラッキー
      const asin = it?.ASIN || null;

      if (!title || !asin) continue;

      // シリーズ名は必須（誤確定の主因なので固定）
      if (!normLoose(title).includes(normLoose(seriesKey))) continue;

      // 明確な単話は落とす
      if (isLikelySingleEpisode(title)) continue;

      // 露骨な派生だけ落とす（誤confirmed防止）
      if (isExcludedDerivedTitle(title)) continue;
      if (/総集編|公式ファンブック|特装版|限定版|ガイド|画集/i.test(title)) continue;

      // 1巻っぽさは要求（ここを緩めると誤確定の温床）
      if (!isVol1Like(title)) continue;

      // スコア：ASINがある時点でGetItemsに進めるので、ISBN13は必須にしない
      const score = scoreCandidate({ title, isbn13, seriesKey, author, creator: null }) + 10;

      const cand = { source: "paapi_search", query: q, title, asin, isbn13: isbn13 || null, score };
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

/**
 * -----------------------
 * main
 * -----------------------
 * “誤confirmed潰し”のルール：
 * 1) NDL候補は item内結合（title/creator/isbnが同じitem）だけを採用
 * 2) NDL採用時は、PA-APIで ISBN一致を確認できたら confirmed（画像もそこで取る）
 * 3) NDLが取れない場合は、PA-API検索で ASIN を拾い、GetItems の EAN(=ISBN13) で確定してから confirmed
 */
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

    // 2) NDL→PAAPI(ISBN一致で確認＆画像取得)
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

      // NDLはあるがPA-APIで確証取れない → todo（誤confirmed防止）
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

    // 3) NDLダメ → PA-API検索でASIN拾う → GetItems(EAN=ISBN13)で確定
    const paSearch = await paapiSearchVol1({ seriesKey, author });
    one.paapiSearch = paSearch;

    const b = paSearch?.best;
    if (b?.asin) {
      const paGet = await paapiGetItems({ asins: [b.asin] });
      one.paapiGet = paGet;

      if (paGet?.ok) {
        const item = paGet?.json?.ItemsResult?.Items?.[0] || null;
        const gotTitle = item ? extractTitle(item) : null;
        const gotIsbn13 = item ? extractEan13FromGet(item) : null;
        const gotImage = item ? extractImage(item) : null;
        const gotDp = item?.DetailPageURL || dpFromAsin(b.asin) || null;

        // 確定条件：EANが取れていて、タイトルにシリーズ名が含まれていて、1巻っぽい、派生除外
        if (gotIsbn13 && gotTitle) {
          const titleOk =
            normLoose(gotTitle).includes(normLoose(seriesKey)) &&
            isVol1Like(gotTitle) &&
            !isLikelySingleEpisode(gotTitle) &&
            !isExcludedDerivedTitle(gotTitle) &&
            !/総集編|公式ファンブック|特装版|限定版|ガイド|画集/i.test(gotTitle);

          if (titleOk) {
            confirmed.push({
              seriesKey,
              author,
              vol1: {
                title: gotTitle,
                isbn13: String(gotIsbn13),
                image: gotImage || null,
                amazonDp: gotDp,
                source: "paapi_search+getitems",
              },
            });
            debug.push(one);
            await sleep(600);
            continue;
          }
        }
      }
    }

    // だめならtodo
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
            query: b.query ?? null,
          }
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
