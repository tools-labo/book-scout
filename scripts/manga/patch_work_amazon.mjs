// scripts/manga/patch_work_amazon.mjs （全差し替え）
import fs from "node:fs/promises";

const WORKS_PATH = "data/manga/works.json";
const ITEMS_PATH = "data/manga/items_master.json";

const isValidDpUrl = (u) =>
  typeof u === "string" &&
  u.startsWith("https://www.amazon.co.jp/dp/") &&
  !u.includes("ASIN_HERE");

const normalizeDpUrl = (asinOrUrl) => {
  if (!asinOrUrl) return null;

  const s = String(asinOrUrl).trim();

  // URLからASIN抜く（/dp/ASIN 形式だけ対応）
  const m = s.match(/^https:\/\/www\.amazon\.co\.jp\/dp\/([A-Z0-9]{10}|[0-9]{9}X|[0-9]{10})(?:[/?].*)?$/i);
  if (m) return `https://www.amazon.co.jp/dp/${m[1]}`;

  // ASIN単体（ISBN10含む）を dp にする
  const asin = s.toUpperCase().replace(/[^0-9A-Z]/g, "");
  if (!asin) return null;
  if (/^[A-Z0-9]{10}$/.test(asin)) return `https://www.amazon.co.jp/dp/${asin}`;

  return null;
};

const same = (a, b) => (a ?? null) === (b ?? null);

const main = async () => {
  const works = JSON.parse(await fs.readFile(WORKS_PATH, "utf8"));
  const items = JSON.parse(await fs.readFile(ITEMS_PATH, "utf8"));

  // workKey -> vol1 item（asin優先）
  const vol1ByWork = new Map();

  for (const it of items) {
    if (!it || it.seriesType !== "main") continue;
    if (it.volumeHint !== 1) continue;
    const wk = it.workKey;
    if (!wk) continue;

    const dp = normalizeDpUrl(it.asin || it.amazonUrl);
    if (!dp) continue; // asin取れてないなら採用しない（巻ズレ防止）

    // 既にあれば維持（どれもvol1なので先勝ちでOK）
    if (!vol1ByWork.has(wk)) {
      vol1ByWork.set(wk, { asin: String(it.asin || "").trim() || null, amazonUrl: dp });
    }
  }

  let updated = 0;
  let cleared = 0;

  for (const [wk, w] of Object.entries(works)) {
    const curUrl = w?.amazonUrl ?? null;
    const curAsin = w?.asin ?? null;

    // 1) 壊れURLを掃除
    const curInvalid =
      curUrl &&
      (!isValidDpUrl(curUrl) || curUrl.includes("ASIN_HERE"));

    // 2) 正しいvol1があるならそれに統一
    const vol1 = vol1ByWork.get(wk) || null;

    if (vol1) {
      const nextUrl = vol1.amazonUrl;
      const nextAsin = (vol1.asin && String(vol1.asin).trim()) || null;

      const changed = curInvalid || !same(curUrl, nextUrl) || !same(curAsin, nextAsin);
      if (changed) {
        w.amazonUrl = nextUrl;
        w.asin = nextAsin;
        updated++;
      }
      continue;
    }

    // 3) vol1が無い作品は「巻ズレ回避」でAmazonリンクを消す（準備中）
    if (curUrl || curAsin) {
      w.amazonUrl = null;
      w.asin = null;
      cleared++;
    }
  }

  await fs.writeFile(WORKS_PATH, JSON.stringify(works, null, 2));
  console.log(`[patch_work_amazon] updated=${updated} cleared=${cleared}`);
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
