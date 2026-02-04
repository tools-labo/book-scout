// scripts/manga/patch_work_amazon.mjs （全差し替え）
// works.json の asin / amazonUrl を「素の dp URL」に正規化する
// 参照元: data/manga/items_master.json（volumeHint=1 の asin を優先）

import fs from "node:fs/promises";

const CAT = process.env.CAT || "manga";
const base = `data/${CAT}`;

const worksPath = `${base}/works.json`;
const itemsPath = `${base}/items_master.json`;

const toDpUrl = (asin) => (asin ? `https://www.amazon.co.jp/dp/${asin}` : null);

function extractAsinFromUrl(url) {
  const s = String(url || "");
  // /dp/ASIN
  let m = s.match(/\/dp\/([A-Z0-9]{10})/i);
  if (m) return m[1].toUpperCase();
  // /gp/product/ASIN
  m = s.match(/\/gp\/product\/([A-Z0-9]{10})/i);
  if (m) return m[1].toUpperCase();
  return null;
}

const works = JSON.parse(await fs.readFile(worksPath, "utf8"));
const items = JSON.parse(await fs.readFile(itemsPath, "utf8"));

// workKey -> asin（volume 1 / main を優先）
const asinByWork = new Map();
for (const it of items) {
  if (!it) continue;
  if (it.seriesType !== "main") continue;
  if (it.volumeHint !== 1) continue;
  if (!it.workKey) continue;

  const asin =
    (it.asin && String(it.asin).trim()) ||
    extractAsinFromUrl(it.amazonUrl);

  if (asin && !asinByWork.has(it.workKey)) {
    asinByWork.set(it.workKey, asin);
  }
}

let updated = 0;

for (const [wk, w] of Object.entries(works)) {
  const fromItems = asinByWork.get(wk) || null;

  // 既存workのasin/amazonUrlからも拾う（保険）
  const fromWorkAsin = w?.asin ? String(w.asin).trim() : null;
  const fromWorkUrl = extractAsinFromUrl(w?.amazonUrl);

  const asin = (fromItems || fromWorkAsin || fromWorkUrl || null);

  const nextAsin = asin || null;
  const nextUrl = asin ? toDpUrl(asin) : null;

  const changed =
    (w?.asin || null) !== nextAsin ||
    (w?.amazonUrl || null) !== nextUrl;

  if (changed) {
    works[wk] = {
      ...w,
      asin: nextAsin,
      amazonUrl: nextUrl,
    };
    updated++;
  }
}

await fs.writeFile(worksPath, JSON.stringify(works, null, 2));
console.log(`[patch_work_amazon] updated=${updated}`);
