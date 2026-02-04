// scripts/manga/patch_work_amazon.mjs
import fs from "node:fs/promises";

const WORKS_PATH = "data/manga/works.json";
const ITEMS_PATH = "data/manga/items_master.json";

const digits = (s) => String(s || "").replace(/\D/g, "");

function extractAsinFromUrl(url) {
  const s = String(url || "");
  // /dp/ASIN  or /gp/product/ASIN
  let m = s.match(/\/dp\/([A-Z0-9]{10})/i);
  if (m) return m[1].toUpperCase();
  m = s.match(/\/gp\/product\/([A-Z0-9]{10})/i);
  if (m) return m[1].toUpperCase();
  return null;
}

function normalizeAmazonUrl(asin) {
  if (!asin) return null;
  return `https://www.amazon.co.jp/dp/${asin}`;
}

// 「代表巻」を選ぶ：基本は1巻、無ければ最小巻、無理ならnull
function pickRepresentativeItem(items) {
  const cand = items
    .filter((x) => x && x.seriesType === "main")
    .map((x) => ({
      x,
      v: Number.isFinite(Number(x.volumeHint)) ? Number(x.volumeHint) : Infinity,
    }))
    .filter((o) => o.v !== Infinity)
    .sort((a, b) => a.v - b.v)
    .map((o) => o.x);

  // 1巻（asin or amazonUrl があるもの）
  const vol1 = cand.find((x) => x.volumeHint === 1 && (x.asin || x.amazonUrl));
  if (vol1) return vol1;

  // 最小巻（asin or amazonUrl があるもの）
  const first = cand.find((x) => x.asin || x.amazonUrl);
  if (first) return first;

  return null;
}

const works = JSON.parse(await fs.readFile(WORKS_PATH, "utf8"));
const items = JSON.parse(await fs.readFile(ITEMS_PATH, "utf8"));

const byWork = new Map();
for (const it of items) {
  if (!it?.workKey) continue;
  if (!byWork.has(it.workKey)) byWork.set(it.workKey, []);
  byWork.get(it.workKey).push(it);
}

let updated = 0;
let cleared = 0;

for (const [workKey, w] of Object.entries(works)) {
  const arr = byWork.get(workKey) || [];
  const rep = pickRepresentativeItem(arr);

  if (!rep) {
    // 代表が取れないなら消す（ASIN_HEREみたいな壊れURLを出さない）
    if (w.asin || w.amazonUrl) {
      w.asin = null;
      w.amazonUrl = null;
      cleared++;
      updated++;
    }
    continue;
  }

  // asin を優先。無ければURLから抜く
  let asin = (rep.asin || "").trim();
  if (!asin) asin = extractAsinFromUrl(rep.amazonUrl);

  // asinが確定できないなら出さない
  const nextAsin = asin || null;
  const nextUrl = asin ? normalizeAmazonUrl(asin) : null;

  const changed = (w.asin || null) !== nextAsin || (w.amazonUrl || null) !== nextUrl;
  if (changed) {
    w.asin = nextAsin;
    w.amazonUrl = nextUrl;
    updated++;
  }
}

await fs.writeFile(WORKS_PATH, JSON.stringify(works, null, 2));
console.log(`[patch_work_amazon] updated=${updated} cleared=${cleared}`);
