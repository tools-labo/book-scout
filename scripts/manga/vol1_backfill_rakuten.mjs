// scripts/manga/vol1_backfill_rakuten.mjs （全差し替え）
// 対象: data/manga/list_items.json の seriesKey だけ
// 目的: items_master.json に「本編 vol1」(volumeHint=1) を追加し、可能なら description(itemCaption) を入れる
import fs from "node:fs/promises";

const APP_ID = process.env.RAKUTEN_APP_ID;
if (!APP_ID) {
  console.log("Skip: RAKUTEN_APP_ID not set");
  process.exit(0);
}

const LIST_PATH = "data/manga/list_items.json";
const ITEMS_PATH = "data/manga/items_master.json";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const digits = (s) => String(s || "").replace(/\D/g, "");

const normalizeTitle = (s) =>
  String(s || "")
    .replace(/[ 　]/g, "")
    .replace(/[（）()\[\]【】]/g, "")
    .toLowerCase();

const normalizeAuthor = (s) =>
  String(s || "")
    .replace(/[ 　]/g, "")
    .replace(/[、,]/g, "")
    .toLowerCase();

const isProbablySpinoff = (title) => {
  const t = String(title || "");
  return (
    t.includes("外伝") ||
    t.includes("スピンオフ") ||
    t.includes("番外編") ||
    t.includes("公式") ||
    t.includes("アンソロジー") ||
    t.includes("キャラクター") ||
    t.includes("ファンブック") ||
    t.includes("設定資料") ||
    t.includes("総集編") ||
    t.includes("画集") ||
    t.includes("ガイド") ||
    t.includes("ムック")
  );
};

const hasVol1Marker = (title) => {
  const t = String(title || "").replace(/１/g, "1");
  return (
    t.includes("（1）") ||
    t.includes("(1)") ||
    t.includes("第1巻") ||
    /(?:^|[^0-9])1(?:[^0-9]|$)/.test(t)
  );
};

async function rakutenSearchByTitle(title) {
  const url =
    "https://app.rakuten.co.jp/services/api/BooksBook/Search/20170404" +
    `?applicationId=${encodeURIComponent(APP_ID)}` +
    `&title=${encodeURIComponent(title)}` +
    "&format=json" +
    "&hits=30" +
    // itemCaption を必ず取る（=description用）
    "&elements=title,author,publisherName,isbn,itemUrl,largeImageUrl,mediumImageUrl,itemCaption";

  const r = await fetch(url, { headers: { "User-Agent": "book-scout-bot" } });
  if (!r.ok) throw new Error(`Rakuten API HTTP ${r.status}`);
  return await r.json();
}

function pickBestVol1Candidate(workTitle, workAuthor, list) {
  const wt = normalizeTitle(workTitle);
  const wa = normalizeAuthor(workAuthor);

  const candidates = (list || [])
    .map((x) => x?.Item || x)
    .filter(Boolean)
    .filter((it) => it.title && it.isbn)
    .filter((it) => digits(it.isbn).length === 13)
    .filter((it) => !isProbablySpinoff(it.title))
    .filter((it) => hasVol1Marker(it.title));

  let best = null;
  let bestScore = -1;

  for (const it of candidates) {
    const tt = normalizeTitle(it.title);
    const aa = normalizeAuthor(it.author);

    let score = 0;
    if (tt.includes(wt)) score += 50;
    if (tt.startsWith(wt)) score += 30;
    if (wa && aa.includes(wa)) score += 40;

    // 余計な混入をさらに落とす（作品名が全然含まれない候補は弱い）
    if (!tt.includes(wt) && !tt.startsWith(wt)) score -= 40;

    if (score > bestScore) {
      bestScore = score;
      best = it;
    }
  }

  return best;
}

const main = async () => {
  const listRaw = JSON.parse(await fs.readFile(LIST_PATH, "utf8"));
  const list = Array.isArray(listRaw) ? listRaw : listRaw.items || [];

  const items = JSON.parse(await fs.readFile(ITEMS_PATH, "utf8"));

  // 既にvol1がある seriesKey を除外
  const existsVol1 = new Set(
    items
      .filter((x) => x?.seriesType === "main" && x?.volumeHint === 1 && x?.workKey)
      .map((x) => x.workKey)
  );

  // 対象 seriesKey は list_items.json のみに固定
  const targets = list
    .map((x) => x?.seriesKey)
    .filter(Boolean)
    .map((s) => String(s));

  let added = 0;
  let skipped = 0;
  let miss = 0;
  let descFilled = 0;

  for (const wk of targets) {
    if (existsVol1.has(wk)) {
      skipped++;
      continue;
    }

    const src = list.find((x) => x?.seriesKey === wk) || {};
    const q = `${wk} 1`;

    let data;
    try {
      data = await rakutenSearchByTitle(q);
    } catch (e) {
      console.log(`[vol1_backfill] wk="${wk}" rakuten_error=${String(e?.message || e)}`);
      miss++;
      await sleep(250);
      continue;
    }

    const best = pickBestVol1Candidate(wk, src?.author || "", data?.Items || []);
    if (!best) {
      console.log(`[vol1_backfill] wk="${wk}" -> no_good_candidate`);
      miss++;
      await sleep(200);
      continue;
    }

    const cap = (best.itemCaption || "").trim() || null;
    if (cap) descFilled++;

    items.push({
      workKey: wk,
      seriesType: "main",
      title: best.title || null,
      author: best.author || src?.author || null,
      publisher: best.publisherName || src?.publisher || null,
      isbn13: digits(best.isbn),
      asin: null,
      amazonUrl: null,
      publishedAt: null,
      description: cap, // ★ここであらすじを入れる
      image: best.largeImageUrl || best.mediumImageUrl || null,
      volumeHint: 1,
      _rep: true,
      rakutenGenreIds: [],
      rakutenGenrePathNames: [],
      anilistId: src?.anilistId ?? null,
      anilistUrl: src?.anilistUrl ?? null,
      anilistGenres: [],
      anilistTags: [],
    });

    existsVol1.add(wk);
    added++;
    console.log(`[vol1_backfill] wk="${wk}" -> "${best.title}" isbn=${digits(best.isbn)} cap=${cap ? "Y" : "N"}`);
    await sleep(220);
  }

  await fs.writeFile(ITEMS_PATH, JSON.stringify(items, null, 2));
  console.log(`vol1_backfill: target=${targets.length} added=${added} skipped=${skipped} miss=${miss} descFilled=${descFilled}`);
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
