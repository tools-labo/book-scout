// scripts/manga/patch_work_amazon.mjs （全差し替え）
import fs from "node:fs/promises";

const WORKS_PATH = "data/manga/works.json";
const ITEMS_PATH = "data/manga/items_master.json";

// dpリンクだけ許可（クエリ/アフィは後で正規化して落とす）
const isValidDpUrl = (u) =>
  typeof u === "string" &&
  u.startsWith("https://www.amazon.co.jp/dp/") &&
  !u.includes("ASIN_HERE");

const normalizeDpUrl = (asinOrUrl) => {
  if (!asinOrUrl) return null;
  const s = String(asinOrUrl).trim();

  // URLからASIN抜く（/dp/ASIN のみ対応）
  const m = s.match(
    /^https:\/\/www\.amazon\.co\.jp\/dp\/([A-Z0-9]{10}|[0-9]{9}X|[0-9]{10})(?:[/?].*)?$/i
  );
  if (m) return `https://www.amazon.co.jp/dp/${m[1].toUpperCase()}`;

  // ASIN単体（ISBN10含む）を dp にする
  const asin = s.toUpperCase().replace(/[^0-9A-Z]/g, "");
  if (/^[A-Z0-9]{10}$/.test(asin)) return `https://www.amazon.co.jp/dp/${asin}`;

  return null;
};

// タイトルから巻数を推定（1巻チェック用）
// 例: "ONE PIECE 1", "葬送のフリーレン（15）", "○○ 7 -..." などを想定
function parseVolumeFromTitle(title) {
  const t = String(title || "").trim();

  // （15） / (15)
  let m = t.match(/[（(]\s*(\d{1,3})\s*[)）]/);
  if (m) return Number(m[1]);

  // 末尾の " 114" / " 7" / "　47"（半角/全角スペース混在）
  m = t.match(/[\s　]+(\d{1,3})\s*$/);
  if (m) return Number(m[1]);

  // " 7 -" みたいなケース（BORUTO... 7 -TWO...）
  m = t.match(/[\s　]+(\d{1,3})\s*[-－—]/);
  if (m) return Number(m[1]);

  return null;
}

const same = (a, b) => (a ?? null) === (b ?? null);

const main = async () => {
  const works = JSON.parse(await fs.readFile(WORKS_PATH, "utf8"));
  const items = JSON.parse(await fs.readFile(ITEMS_PATH, "utf8"));

  // workKey -> vol1 item（asin優先）
  const vol1ByWork = new Map();

  for (const it of items) {
    if (!it || it.seriesType !== "main") continue;

    const wk = it.workKey;
    if (!wk) continue;

    // 重要：volumeHintが壊れてても「タイトルから巻数を見て 1 だけ許可」
    const vHint = Number(it.volumeHint);
    const vTitle = parseVolumeFromTitle(it.title);

    // “1巻っぽい”判定：
    // - volumeHint が 1、または title から 1 が取れる
    // - ただし title から 2以上が取れてしまうなら絶対に弾く（巻ズレ防止）
    if (vTitle != null && vTitle !== 1) continue;
    if (!(vHint === 1 || vTitle === 1)) continue;

    const dp = normalizeDpUrl(it.asin || it.amazonUrl);
    if (!dp) continue; // asin取れてないなら採用しない（巻ズレ防止）

    if (!vol1ByWork.has(wk)) {
      const asin = String(it.asin || "").trim() || null;
      vol1ByWork.set(wk, { asin, amazonUrl: dp });
    }
  }

  let updated = 0;
  let cleared = 0;

  for (const [wk, w] of Object.entries(works)) {
    const curUrl = w?.amazonUrl ?? null;
    const curAsin = w?.asin ?? null;

    const curInvalid = curUrl && (!isValidDpUrl(curUrl) || curUrl.includes("ASIN_HERE"));

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

    // vol1が無い作品は「巻ズレ回避」でAmazonリンクを消す
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
