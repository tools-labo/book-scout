// scripts/lane2/run.mjs
import fs from "node:fs/promises";
import path from "node:path";
import { paapiSearchItems } from "./paapi.mjs";

const DATA_DIR = "data/lane2";
const SEED = "data/seed_series.json";

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

function escNorm(s) {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

function buildKeywordVariants(seriesKey) {
  const s = escNorm(seriesKey);
  // 1巻表記は揺れるので多めに打つ（少数作品で検証しやすい）
  return [
    `${s} 1`,
    `${s} 1巻`,
    `${s} (1)`,
    `${s} （1）`,
    `${s} 第1巻`,
    `${s} 01`,
  ];
}

function extractIsbn13(item) {
  // ItemInfo.ExternalIds.ISBNs.DisplayValues[0] など
  const isbns = item?.ItemInfo?.ExternalIds?.ISBNs?.DisplayValues;
  if (Array.isArray(isbns) && isbns.length) {
    const v = String(isbns[0]).replace(/[^0-9X]/gi, "");
    // ISBN-13優先
    if (/^\d{13}$/.test(v)) return v;
  }
  return null;
}

function extractAsin(item) {
  const asin = item?.ASIN;
  return asin ? String(asin) : null;
}
function extractTitle(item) {
  return item?.ItemInfo?.Title?.DisplayValue ?? null;
}
function extractAuthors(item) {
  const contribs = item?.ItemInfo?.ByLineInfo?.Contributors;
  if (!Array.isArray(contribs)) return [];
  return contribs.map((c) => c?.Name).filter(Boolean).map(String);
}
function extractImage(item) {
  return (
    item?.Images?.Primary?.Medium?.URL ||
    item?.Images?.Primary?.Large?.URL ||
    item?.Images?.Primary?.Small?.URL ||
    null
  );
}

function dpUrlFromAsin(asin) {
  return asin ? `https://www.amazon.co.jp/dp/${asin}` : null;
}

// “1巻っぽさ” スコア
function scoreVol1Candidate({ seriesKey, seedAuthor }, cand) {
  const title = escNorm(cand.title);
  const authors = cand.authors.map(escNorm);
  const sk = escNorm(seriesKey);

  let score = 0;

  // タイトルにシリーズ名が含まれる
  if (title.includes(sk)) score += 30;

  // 1巻表記
  const vol1Hints = ["(1)", "（1）", " 1巻", "第1巻", " 01", "①", "一巻"];
  if (vol1Hints.some((h) => title.includes(h))) score += 50;

  // 著者一致（部分一致でもOK）
  if (seedAuthor) {
    const a = escNorm(seedAuthor);
    if (authors.some((x) => x.includes(a) || a.includes(x))) score += 25;
  }

  // ISBN/画像があると強い
  if (cand.isbn13) score += 20;
  if (cand.image) score += 10;

  // “スピンオフ/外伝/ノベライズ/公式ファンブック”などを落とす（必要に応じて追加）
  const badHints = ["公式ファンブック", "外伝", "スピンオフ", "ノベライズ", "アンソロジー", "特装版"];
  if (badHints.some((h) => title.includes(h))) score -= 40;

  return score;
}

async function main() {
  const accessKey = process.env.AMZ_ACCESS_KEY;
  const secretKey = process.env.AMZ_SECRET_KEY;
  const partnerTag = process.env.AMZ_PARTNER_TAG;

  const host = process.env.AMZ_HOST || "webservices.amazon.co.jp";
  const region = process.env.AMZ_REGION || "us-west-2";
  const marketplace = process.env.AMZ_MARKETPLACE || "www.amazon.co.jp";

  const seeds = await loadJson(SEED, []);
  if (!Array.isArray(seeds) || seeds.length === 0) {
    throw new Error(`seed is empty: ${SEED}`);
  }

  // 取得項目（最小）
  const resources = [
    "ItemInfo.Title",
    "ItemInfo.ByLineInfo",
    "ItemInfo.ExternalIds",
    "Images.Primary.Medium",
  ];

  const confirmed = [];
  const todo = [];
  const debugCandidates = [];

  for (const seed of seeds) {
    const seriesKey = escNorm(seed?.seriesKey);
    if (!seriesKey) continue;

    const seedAuthor = escNorm(seed?.author || "");
    const variants = buildKeywordVariants(seriesKey);

    let best = null;

    for (const q of variants) {
      let json;
      try {
        json = await paapiSearchItems({
          host,
          region,
          marketplace,
          accessKey,
          secretKey,
          partnerTag,
          keywords: q,
          resources,
          searchIndex: "Books",
          itemCount: 10,
        });
      } catch (e) {
        debugCandidates.push({
          seriesKey,
          query: q,
          error: String(e?.message || e),
        });
        continue;
      }

      const items = json?.SearchResult?.Items || [];
      for (const it of items) {
        const cand = {
          seriesKey,
          query: q,
          asin: extractAsin(it),
          isbn13: extractIsbn13(it),
          title: extractTitle(it),
          authors: extractAuthors(it),
          image: extractImage(it),
        };
        cand.amazonDp = dpUrlFromAsin(cand.asin);

        const score = scoreVol1Candidate({ seriesKey, seedAuthor }, cand);
        cand.score = score;

        debugCandidates.push(cand);

        if (!best || score > best.score) best = cand;
      }

      // 早期終了：強い候補が出たら打ち切る（検証しやすい）
      if (best && best.score >= 90) break;
    }

    // 確定条件（厳しめ：ここは調整前提）
    // - score >= 90
    // - isbn13 と image と amazonDp が揃っている
    if (best && best.score >= 90 && best.isbn13 && best.image && best.amazonDp) {
      confirmed.push({
        seriesKey,
        author: seedAuthor || null,
        vol1: {
          isbn13: best.isbn13,
          amazonDp: best.amazonDp,
          image: best.image,
          title: best.title || seriesKey,
        },
        _debug: { score: best.score, query: best.query, asin: best.asin },
      });
    } else {
      todo.push({
        seriesKey,
        author: seedAuthor || null,
        reason: best
          ? `not_confirmed(score=${best.score}, isbn13=${!!best.isbn13}, image=${!!best.image})`
          : "no_candidate",
        best: best ? { score: best.score, query: best.query, title: best.title, asin: best.asin, isbn13: best.isbn13 } : null,
      });
    }
  }

  // 出力
  await saveJson(`${DATA_DIR}/series.json`, {
    updatedAt: new Date().toISOString(),
    total: seeds.length,
    confirmed: confirmed.length,
    todo: todo.length,
    items: confirmed,
  });

  await saveJson(`${DATA_DIR}/todo.json`, {
    updatedAt: new Date().toISOString(),
    total: todo.length,
    items: todo,
  });

  await saveJson(`${DATA_DIR}/debug_candidates.json`, {
    updatedAt: new Date().toISOString(),
    total: debugCandidates.length,
    items: debugCandidates,
  });

  console.log(`[lane2] seeds=${seeds.length} confirmed=${confirmed.length} todo=${todo.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
