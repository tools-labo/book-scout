// scripts/manga/vol1_backfill_rakuten.mjs （全差し替え）
import fs from "node:fs/promises";

const APP_ID = process.env.RAKUTEN_APP_ID;
if (!APP_ID) {
  console.log("Skip: RAKUTEN_APP_ID not set");
  process.exit(0);
}

const WORKS_PATH = "data/manga/works.json";
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
    t.includes("小説") || // 漫画本編のvol1を取りたいので一旦除外（必要なら後で緩める）
    t.includes("総集編")
  );
};

const hasVol1Marker = (title) => {
  // "1", "１", "(1)", "（1）", "第1巻" などをゆるく拾う
  const t = String(title || "");
  return (
    /(?:^|[^0-9])1(?:[^0-9]|$)/.test(t.replace(/１/g, "1")) ||
    t.includes("（1）") ||
    t.includes("(1)") ||
    t.includes("第1巻") ||
    t.endsWith(" 1") ||
    t.endsWith("１")
  );
};

async function rakutenSearchByTitle(title) {
  const url =
    "https://app.rakuten.co.jp/services/api/BooksBook/Search/20170404" +
    `?applicationId=${encodeURIComponent(APP_ID)}` +
    `&title=${encodeURIComponent(title)}` +
    "&format=json" +
    "&hits=30" +
    "&elements=title,author,publisherName,isbn,itemUrl,largeImageUrl,mediumImageUrl";

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

  // スコア付け：タイトルが作品名に近い + 著者一致が強い
  let best = null;
  let bestScore = -1;

  for (const it of candidates) {
    const tt = normalizeTitle(it.title);
    const aa = normalizeAuthor(it.author);

    let score = 0;

    // 作品名含む（強い）
    if (tt.includes(wt)) score += 50;

    // 作品名の先頭一致（より強い）
    if (tt.startsWith(wt)) score += 30;

    // 著者一致（強い）
    if (wa && aa.includes(wa)) score += 40;

    // 出版社一致は works 側が空の時もあるので弱め（あれば加点）
    // ※必要なら後で追加

    // 「外伝」などが入ってたら除外済みなのでここでは無し

    if (score > bestScore) {
      bestScore = score;
      best = it;
    }
  }

  return best;
}

const main = async () => {
  const works = JSON.parse(await fs.readFile(WORKS_PATH, "utf8"));
  const items = JSON.parse(await fs.readFile(ITEMS_PATH, "utf8"));

  const existsVol1 = new Set(
    items
      .filter((x) => x?.seriesType === "main" && x?.volumeHint === 1 && x?.workKey)
      .map((x) => x.workKey)
  );

  let added = 0;
  let skipped = 0;
  let miss = 0;

  for (const [wk, w] of Object.entries(works)) {
    if (existsVol1.has(wk)) {
      skipped++;
      continue;
    }

    // 作品名 + " 1" で検索（雑にやると外伝が混ざるので除外ロジック必須）
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

    const best = pickBestVol1Candidate(wk, w?.author || "", data?.Items || []);
    if (!best) {
      console.log(`[vol1_backfill] wk="${wk}" -> no_good_candidate`);
      miss++;
      await sleep(200);
      continue;
    }

    // items_master に追加（本編 vol1）
    items.push({
      workKey: wk,
      seriesType: "main",
      title: best.title,
      author: best.author || w?.author || null,
      publisher: best.publisherName || w?.publisher || null,
      isbn13: digits(best.isbn),
      asin: null,
      amazonUrl: null,
      publishedAt: null,
      description: null,
      image: best.largeImageUrl || best.mediumImageUrl || null,
      volumeHint: 1,
      _rep: true,
      rakutenGenreIds: [],
      rakutenGenrePathNames: [],
      anilistId: w?.anilist?.url ? null : null,
      anilistUrl: w?.anilist?.url || null,
      anilistGenres: w?.anilist?.genres || [],
      anilistTags: w?.anilist?.tags || [],
    });

    existsVol1.add(wk);
    added++;
    console.log(`[vol1_backfill] wk="${wk}" -> "${best.title}" isbn=${digits(best.isbn)}`);
    await sleep(220); // API負荷を軽く
  }

  await fs.writeFile(ITEMS_PATH, JSON.stringify(items, null, 2));
  console.log(`vol1_backfill: added=${added} skipped=${skipped} miss=${miss}`);
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
