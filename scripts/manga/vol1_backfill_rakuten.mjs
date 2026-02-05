// scripts/manga/vol1_backfill_rakuten.mjs （全差し替え）
import fs from "node:fs/promises";

const APP_ID = process.env.RAKUTEN_APP_ID;
if (!APP_ID) {
  console.log("Skip: RAKUTEN_APP_ID not set");
  process.exit(0);
}

const SERIES_PATH = "data/manga/series_master.json";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const digits = (s) => String(s || "").replace(/\D/g, "");

const norm = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/[【】\[\]（）()]/g, " ")
    .replace(/[：:・\u3000]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

function parseVolHint(title) {
  const t = String(title || "")
    .replace(/１/g, "1")
    .replace(/２/g, "2")
    .replace(/３/g, "3")
    .replace(/４/g, "4")
    .replace(/５/g, "5")
    .replace(/６/g, "6")
    .replace(/７/g, "7")
    .replace(/８/g, "8")
    .replace(/９/g, "9")
    .replace(/０/g, "0");

  const m =
    t.match(/[（(]\s*(\d{1,3})\s*[）)]/) ||
    t.match(/第\s*(\d{1,3})\s*巻/) ||
    t.match(/(\d{1,3})\s*巻/) ||
    t.match(/\b(\d{1,3})\b/);
  return m ? Number(m[1]) : null;
}

function isBadTitle(title) {
  const t = norm(title);
  // ズレ源は強めに排除（安全優先）
  return /(外伝|番外編|スピンオフ|spinoff|episode|ep\.|side|short|アンソロジー|短編集|公式|ガイド|guide|ファンブック|キャラクター|データブック|ムック|画集|イラスト|art|visual|原画|設定資料|総集編|完全版|新装版|愛蔵版)/i.test(
    t
  );
}

async function rakutenSearch({ title, author }) {
  const url =
    "https://app.rakuten.co.jp/services/api/BooksBook/Search/20170404" +
    `?applicationId=${encodeURIComponent(APP_ID)}` +
    `&title=${encodeURIComponent(title)}` +
    (author ? `&author=${encodeURIComponent(author)}` : "") +
    "&format=json" +
    "&hits=30" +
    "&elements=title,author,publisherName,isbn,itemUrl,largeImageUrl,mediumImageUrl,smallImageUrl";

  const r = await fetch(url, { headers: { "User-Agent": "book-scout-bot" } });
  if (!r.ok) throw new Error(`Rakuten API HTTP ${r.status}`);
  return await r.json();
}

function pickVol1Candidate(seriesTitle, seriesAuthor, items) {
  const st = norm(seriesTitle);
  const sa = norm(seriesAuthor);

  const list = (items || []).map((x) => x?.Item || x).filter(Boolean);

  // 「巻数=1」以外は採用しない（巻ズレ防止）
  const vol1 = list
    .filter((it) => it.title && it.isbn)
    .filter((it) => digits(it.isbn).length === 13)
    .filter((it) => !isBadTitle(it.title))
    .map((it) => ({ it, vol: parseVolHint(it.title) }))
    .filter(({ vol }) => vol === 1);

  let best = null;
  let bestScore = -1;

  for (const { it } of vol1) {
    const tt = norm(it.title);
    const aa = norm(it.author);

    let score = 0;

    // タイトル一致（強）
    if (st && tt.includes(st)) score += 60;
    if (st && tt.startsWith(st)) score += 30;

    // 著者一致（中〜強）
    if (sa && aa.includes(sa)) score += 35;

    // 1巻っぽさ（微）
    score += 10;

    if (score > bestScore) {
      bestScore = score;
      best = it;
    }
  }

  // 一致が弱いものは不採用（誤爆防止）
  if (!best || bestScore < 60) return null;
  return best;
}

async function main() {
  const seriesRaw = JSON.parse(await fs.readFile(SERIES_PATH, "utf8"));

  // series_master が { anilistId: {...} } 前提。配列でも落ちないよう吸収。
  const seriesMap = Array.isArray(seriesRaw)
    ? Object.fromEntries(
        seriesRaw.map((x) => [
          String(x?.anilistId || x?.seriesKey || x?.titleNative || ""),
          x,
        ])
      )
    : seriesRaw;

  let added = 0;
  let skipped = 0;
  let miss = 0;

  for (const [key, s] of Object.entries(seriesMap)) {
    if (!s) continue;

    const hasVol1 = s?.vol1?.isbn13 && digits(s.vol1.isbn13).length === 13;
    if (hasVol1) {
      skipped++;
      continue;
    }

    const title = s.titleNative || s.titleRomaji || s.title || s.seriesKey || key;
    const author = s.author || "";

    let best = null;

    // まず「タイトル + 著者」で検索（精度優先）
    try {
      const data = await rakutenSearch({ title, author });
      best = pickVol1Candidate(title, author, data?.Items || []);
    } catch (e) {
      console.log(`[vol1_backfill] key="${key}" rakuten_error=${String(e?.message || e)}`);
      miss++;
      await sleep(250);
      continue;
    }

    // ダメなら「著者なし」で再検索（取りこぼし対策）
    if (!best) {
      try {
        const data2 = await rakutenSearch({ title, author: "" });
        best = pickVol1Candidate(title, author, data2?.Items || []);
      } catch {
        // ignore
      }
    }

    if (!best) {
      console.log(`[vol1_backfill] key="${key}" -> no_good_candidate`);
      miss++;
      await sleep(220);
      continue;
    }

    const isbn13 = digits(best.isbn);
    const img =
      best.largeImageUrl || best.mediumImageUrl || best.smallImageUrl || null;

    s.vol1 = {
      ...(s.vol1 || {}),
      isbn13,
      image: s?.vol1?.image || img,
      // description は別工程（fill_series_synopsis.mjs 等）で埋める
    };

    added++;
    console.log(`[vol1_backfill] key="${key}" -> "${best.title}" isbn=${isbn13}`);
    await sleep(220);
  }

  await fs.writeFile(SERIES_PATH, JSON.stringify(seriesMap, null, 2));
  console.log(`vol1_backfill: added=${added} skipped=${skipped} miss=${miss}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
