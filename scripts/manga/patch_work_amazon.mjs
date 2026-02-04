// scripts/manga/patch_work_amazon.mjs （全差し替え）

import fs from "node:fs/promises";

const CAT = process.env.CAT || "manga";
const worksPath = `data/${CAT}/works.json`;

function normalizeAmazonUrl({ asin, amazonUrl }) {
  const a = String(asin || "").trim();
  if (a) return `https://www.amazon.co.jp/dp/${encodeURIComponent(a)}`;

  const u = String(amazonUrl || "").trim();
  if (!u) return null;

  try {
    const url = new URL(u);
    // /dp/ASIN を抽出できるなら dp 直リンクに統一
    const m = url.pathname.match(/\/dp\/([A-Z0-9]{10})/i);
    if (m) return `https://www.amazon.co.jp/dp/${m[1].toUpperCase()}`;
    // それ以外はクエリ除去したURLを返す（最低限タグは消える）
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

const works = JSON.parse(await fs.readFile(worksPath, "utf8"));

let updated = 0;
for (const [wk, w] of Object.entries(works)) {
  const next = normalizeAmazonUrl({ asin: w?.asin, amazonUrl: w?.amazonUrl });
  const cur = w?.amazonUrl ?? null;
  if (next !== cur) {
    w.amazonUrl = next;
    updated++;
  }
}

await fs.writeFile(worksPath, JSON.stringify(works, null, 2));
console.log(`[patch_work_amazon] updated=${updated}`);
