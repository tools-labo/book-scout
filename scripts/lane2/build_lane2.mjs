// scripts/lane2/build_lane2.mjs
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const SEEDS_PATH = "data/lane2/seeds.json";
const OUT_SERIES = "data/lane2/series.json";
const OUT_TODO = "data/lane2/todo.json";
const OUT_DEBUG = "data/lane2/debug_candidates.json";

// ★ env名は AMZ_* に統一
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
function toHalfWidthDigits(s) {
  return String(s ?? "")
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[（]/g, "(")
    .replace(/[）]/g, ")")
    .replace(/[　]/g, " ");
}

function isLikelySingleEpisode(title) {
  const t = norm(title);
  return /第\s*\d+\s*話/.test(t) || /分冊|単話|話売り|Kindle版|電子版/.test(t);
}
function isSpinOffLike(title) {
  const t = toHalfWidthDigits(norm(title));
  return /EPISODE|外伝|スピンオフ|番外編|サイドストーリー|SIDE\s*STORY/i.test(t);
}
function isExtraBookLike(title) {
  const t = norm(title);
  return /総集編|公式ファンブック|特装版|限定版|ガイド|画集|副読本|設定資料|ムック|ポスター/i.test(t);
}
function isSetLike(title) {
  const t = norm(title);
  return /全巻|巻セット|セット|BOX|ボックス|まとめ買い/i.test(t);
}
function isColorLike(title) {
  const t = toHalfWidthDigits(norm(title));
  return /FULL\s*COLOR|カラー|SELECTION/i.test(t);
}
function isVol1Like(title) {
  const t0 = toHalfWidthDigits(norm(title));
  // 「(1)」「（1）」に加えて「第1巻」「Vol.1」など
  return (
    /\(\s*1\s*\)/.test(t0) ||
    /（\s*1\s*）/.test(t0) ||
    /第\s*1\s*巻/.test(t0) ||
    /Vol\.?\s*1/i.test(t0)
  );
}
function titleHasSeries(title, seriesKey) {
  const t = normLoose(title);
  const s = normLoose(seriesKey);
  if (!t || !s) return false;
  return t.includes(s);
}
function titleIsSeriesMainlineVol1(title, seriesKey) {
  // 「シリーズ名（1）」や「シリーズ名 (1)」や「シリーズ名 1」を “本線っぽい” として強く評価
  const t = toHalfWidthDigits(norm(title));
  const s = toHalfWidthDigits(norm(seriesKey));
  if (!t || !s) return false;
  if (!t.includes(s)) return false;

  // シリーズ名の直後が「(」「（」「 」あたりなら本線っぽい
  const idx = t.indexOf(s);
  if (idx < 0) return false;
  const rest = t.slice(idx + s.length);

  // 直後に EPISODE/外伝 が来るのは本線じゃない
  if (/^\s*[-ー–—]\s*EPISODE/i.test(rest)) return false;
  if (/^\s*(EPISODE|外伝|スピンオフ|番外編)/i.test(rest)) return false;

  // 直後に巻情報が来てるなら本線優先
  if (/^\s*[\(（]?\s*1\s*[\)）]/.test(rest)) return true;
  if (/^\s*1\b/.test(rest)) return true;
  if (/^\s*第\s*1\s*巻/.test(rest)) return true;

  return false;
}

function scoreCandidate({ title, isbn13, seriesKey, author, creator }) {
  let score = 0;
  const t = norm(title);
  if (!t) return 0;

  // ISBNが取れてる時点で強い（ただし派生/セットは強く落とす）
  if (isbn13) score += 120;

  // シリーズ名を含む
  if (seriesKey && titleHasSeries(t, seriesKey)) score += 40;

  // 本線っぽい(1) を最優先
  if (seriesKey && titleIsSeriesMainlineVol1(t, seriesKey)) score += 120;

  // 1巻っぽい
  if (isVol1Like(t)) score += 40;

  // 作者一致（NDL側のcreatorが取れた時だけ加点）
  if (author && creator) {
    const a = normLoose(author);
    const c = normLoose(creator);
    if (a && c && c.includes(a)) score += 15;
  }

  // ノイズ抑制（強い）
  if (isLikelySingleEpisode(t)) score -= 200;
  if (isSpinOffLike(t)) score -= 220;
  if (isExtraBookLike(t)) score -= 180;
  if (isSetLike(t)) score -= 240;

  // カラー/セレクション系（本線1巻を勝たせたいので強めに落とす）
  if (isColorLike(t)) score -= 120;

  return score;
}

function pickBest(cands, seriesKey) {
  if (!cands.length) return null;

  // 安定ソートのために index を保持
  const withIdx = cands.map((c, i) => ({ ...c, __i: i }));

  withIdx.sort((a, b) => {
    const sa = a.score ?? 0;
    const sb = b.score ?? 0;
    if (sb !== sa) return sb - sa;

    // 同点なら「本線っぽい(1)」を優先
    if (seriesKey) {
      const am = titleIsSeriesMainlineVol1(a.title || "", seriesKey) ? 1 : 0;
      const bm = titleIsSeriesMainlineVol1(b.title || "", seriesKey) ? 1 : 0;
      if (bm !== am) return bm - am;
    }

    // 同点なら短いタイトル（セット/派生が長い傾向）を優先
    const la = (a.title || "").length;
    const lb = (b.title || "").length;
    if (la !== lb) return la - lb;

    // それでも同点なら元順で安定化
    return a.__i - b.__i;
  });

  const { __i, ...best } = withIdx[0];
  return best;
}

function dpFromAsinOrIsbn(asinOrIsbn) {
  if (!asinOrIsbn) return null;
  const a = String(asinOrIsbn).trim();
  // 10桁ASIN または 10桁ISBN / 13桁ISBN は dp に使える
  if (/^[A-Z0-9]{10}$/i.test(a)) return `https://www.amazon.co.jp/dp/${a.toUpperCase()}`;
  if (/^\d{10}$/.test(a)) return `https://www.amazon.co.jp/dp/${a}`;
  if (/^\d{13}$/.test(a)) return `https://www.amazon.co.jp/dp/${a}`;
  return null;
}

/**
 * -----------------------
 * NDL Search OpenSearch
 * -----------------------
 * ★「申請不要・商用OK」枠に寄せるため、提供DBを固定する。
 */
async function ndlOpensearch({ seriesKey, author }) {
  // 重要：提供DBを固定
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
  const titleSamples = [];

  for (const block of items) {
    const t = (block.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? "")
      .replace(/&amp;/g, "&")
      .trim();

    if (t && titleSamples.length < 5) titleSamples.push(t);

    // creatorは dc:creator などを拾う
    const creator = (block.match(/<(dc:creator|creator)>([\s\S]*?)<\/\1>/i)?.[2] ?? "").trim();

    // ★ISBNは「そのitem内」で拾う
    const isbn13 = (block.match(/(97[89]\d{10})/g) || [])[0] || null;

    // 基本条件
    if (!t || isLikelySingleEpisode(t) || isSpinOffLike(t) || isExtraBookLike(t) || isSetLike(t)) {
      dropped++;
      continue;
    }

    // シリーズ名を含まない候補は落とす（誤確定防止）
    if (!titleHasSeries(t, seriesKey)) {
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

/**
 * -----------------------
 * Amazon PA-API (SearchItems / GetItems)
 * -----------------------
 * NOTE:
 * - Resources に DetailPageURL を入れると ValidationException になることがあるので入れない
 * - dp URL は ASIN/ISBN から組み立てる
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

async function paapiGetItems({ asins }) {
  return paapiRequest({
    target: "com.amazon.paapi5.v1.ProductAdvertisingAPIv1.GetItems",
    pathUri: "/paapi5/getitems",
    bodyObj: {
      ItemIds: asins,
      PartnerTag: AMZ_PARTNER_TAG,
      PartnerType: "Associates",
      Resources: ["ItemInfo.Title", "ItemInfo.ExternalIds", "ItemInfo.ByLineInfo", "Images.Primary.Large"],
    },
  });
}

function extractIsbn13(item) {
  // EAN(13) を優先（紙はだいたいここに入る）
  const eans = item?.ItemInfo?.ExternalIds?.EANs?.DisplayValues;
  if (Array.isArray(eans) && eans.length) {
    const v = String(eans[0]).replace(/[^0-9]/g, "");
    if (/^97[89]\d{10}$/.test(v)) return v;
  }
  const isbns = item?.ItemInfo?.ExternalIds?.ISBNs?.DisplayValues;
  if (Array.isArray(isbns) && isbns.length) {
    const v = String(isbns[0]).replace(/[^0-9]/g, "");
    // 10桁→13桁変換はしない（誤確定防止）
    if (/^97[89]\d{10}$/.test(v)) return v;
  }
  const vals = item?.ItemInfo?.ExternalIds?.ISBN?.DisplayValues;
  if (Array.isArray(vals) && vals.length) {
    const v = String(vals[0]).replace(/[^0-9]/g, "");
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
function extractAuthor(item) {
  const c = item?.ItemInfo?.ByLineInfo?.Contributors;
  if (Array.isArray(c) && c.length) return c.map((x) => x?.Name).filter(Boolean).join("/");
  const a = item?.ItemInfo?.ByLineInfo?.Manufacturer?.DisplayValue;
  return a || null;
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
      const image = extractImage(it);
      return {
        ok: true,
        asin,
        title,
        isbn13: got,
        image,
        amazonDp: dpFromAsinOrIsbn(asin),
      };
    }
  }
  return { ok: true, miss: true, returned: items.length };
}

async function paapiSearchVol1({ seriesKey, author }) {
  // 末尾に足す条件は「本線(1)」が出やすいものだけ
  const tries = [
    `${seriesKey} 1`,
    `${seriesKey} （1）`,
    `${seriesKey} 1 金城`, // authorが取れる時もあるけど固定は危ないので軽く
    `${seriesKey} 1 コミックス`,
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
    const candidatesAll = [];
    let best = null;

    for (const it of items) {
      const title = extractTitle(it);
      const isbn13 = extractIsbn13(it);
      const asin = it?.ASIN || null;

      // 安全策：シリーズ名含まないのは落とす
      if (!titleHasSeries(title, seriesKey)) continue;

      // 強い除外（誤確定防止）
      if (isLikelySingleEpisode(title)) continue;
      if (isSpinOffLike(title)) continue;
      if (isExtraBookLike(title)) continue;
      if (isSetLike(title)) continue;

      const score = scoreCandidate({ title, isbn13, seriesKey, author, creator: null }) + (asin ? 5 : 0);
      const cand = { source: "paapi_search", query: q, title, isbn13, asin, score };
      candidatesAll.push(cand);

      if (!best || cand.score > best.score) best = cand;
    }

    // best を tie-break 安定化して取り直し
    best = pickBest(candidatesAll, seriesKey);

    results.push({ query: q, ok: true, returned: items.length, best, candidatesAll });
    await sleep(900);
  }

  const bests = results.map((x) => x.best).filter(Boolean);
  const best = pickBest(bests, seriesKey);
  return { tried: tries, results, best };
}

/**
 * -----------------------
 * main
 * -----------------------
 * “誤confirmed潰し”のルール：
 * 1) NDL候補は item内結合（title/creator/isbnが同じitem）だけを採用
 * 2) NDL採用時は、PA-APIで ISBN一致を確認できたら confirmed（画像もそこで取る）
 * 3) NDLが取れない場合のみ、PA-API検索 → GetItemsでEAN(=ISBN13)取得 → title検証して confirmed
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

    const ndlBest = pickBest(ndl?.candidates || [], seriesKey);

    // 2) NDL→PAAPI(ISBN一致で確認＆画像取得)
    if (ndlBest?.isbn13) {
      const pa = await paapiFindByIsbn13(ndlBest.isbn13);
      one.paapiByIsbn = pa;

      if (pa?.ok && !pa?.miss && pa?.isbn13 === ndlBest.isbn13) {
        // 追加安全：タイトルにシリーズ名＋本線っぽさ
        const titleOk =
          titleHasSeries(pa.title, seriesKey) &&
          titleIsSeriesMainlineVol1(pa.title, seriesKey) &&
          !isSpinOffLike(pa.title) &&
          !isExtraBookLike(pa.title) &&
          !isSetLike(pa.title);

        if (titleOk) {
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

    // 3) NDLダメ → PA-API検索
    const paSearch = await paapiSearchVol1({ seriesKey, author });
    one.paapiSearch = paSearch;

    const b = paSearch?.best;

    // 3-1) bestのASINが取れたら GetItems で EAN(=ISBN13) を回収して確定
    if (b?.asin) {
      const get = await paapiGetItems({ asins: [b.asin] });
      one.paapiGet = get;

      if (get?.ok) {
        const item = get?.json?.ItemsResult?.Items?.[0] || null;
        const title = extractTitle(item) || b.title || "";
        const isbn13 = extractIsbn13(item) || b.isbn13 || null;
        const image = extractImage(item);
        const dp = dpFromAsinOrIsbn(b.asin);

        // 最重要：本線(1)以外は確定させない（ブルーロック事故対策）
        const titleOk =
          titleHasSeries(title, seriesKey) &&
          titleIsSeriesMainlineVol1(title, seriesKey) &&
          isVol1Like(title) &&
          !isLikelySingleEpisode(title) &&
          !isSpinOffLike(title) &&
          !isExtraBookLike(title) &&
          !isSetLike(title) &&
          !isColorLike(title); // FULL COLOR などもここでは防ぐ

        if (isbn13 && titleOk) {
          confirmed.push({
            seriesKey,
            author,
            vol1: {
              title,
              isbn13,
              image: image || null,
              amazonDp: dp || null,
              source: "paapi_search+getitems",
            },
          });
          debug.push(one);
          await sleep(600);
          continue;
        }

        // 紙EANが無い or タイトル検証NG → todo
        todo.push({
          seriesKey,
          author,
          reason: !isbn13 ? "paapi_getitems_no_ean" : "paapi_getitems_title_guard_failed",
          best: {
            source: "paapi_search",
            score: b.score ?? 0,
            title: b.title ?? null,
            asin: b.asin ?? null,
            isbn13: b.isbn13 ?? null,
            query: b.query ?? null,
          },
        });
        debug.push(one);
        await sleep(600);
        continue;
      }

      // GetItems 自体が失敗 → todo
      todo.push({
        seriesKey,
        author,
        reason: get?.skipped ? `paapi_skipped(${get.reason})` : `paapi_getitems_error(${get?.status ?? "unknown"})`,
        best: {
          source: "paapi_search",
          score: b.score ?? 0,
          title: b.title ?? null,
          asin: b.asin ?? null,
          isbn13: b.isbn13 ?? null,
          query: b.query ?? null,
        },
      });
      debug.push(one);
      await sleep(600);
      continue;
    }

    // bestすら出ない → todo
    todo.push({
      seriesKey,
      author,
      reason: paSearch?.skipped ? `paapi_skipped(${paSearch.reason})` : "no_candidate",
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
