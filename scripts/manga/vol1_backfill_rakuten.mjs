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
  // 巻ズレ・別冊・解説系を強めに排除（安全優先）
  return /(外伝|番外編|スピンオフ|spinoff|episode|ep\.|side|short|アンソロジー|短編集|公式|ガイド|guide|ファンブック|キャラクター|データブック|ムック|画集|イラスト|art|visual|原画|設定資料|総集編|完全版|新装版|愛蔵版|特装版|限定版)/i.test(
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

  // volume=1 以外は絶対に採用しない（巻ズレ防止）
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
    if (st && tt.includes(st)) score += 60;
    if (st && tt.startsWith(st)) score += 30;
    if (sa && aa.includes(sa)) score += 35;
    score += 10; // vol1限定なので最低加点

    if (score > bestScore) {
      bestScore = score;
      best = it;
    }
  }

  // タイトル一致が弱いものは誤爆の可能性が高いので不採用
  if (!best || bestScore < 60) return null;
  return best;
}

function hasVol1(s) {
  const isbn13 = s?.vol1?.isbn13;
  return isbn13 && digits(isbn13).length === 13;
}

async function main() {
  const root = JSON.parse(await fs.readFile(SERIES_PATH, "utf8"));

  // 期待構造: { meta: {...}, items: { [anilistId]: seriesObj } }
  const itemsMap = root?.items && typeof root.items === "object" ? root.items : null;
  if (!itemsMap) {
    throw new Error(
      `series_master.json format invalid: expected { meta, items }, but got keys=${Object.keys(root || {}).join(",")}`
    );
  }

  let added = 0;
  let skipped = 0;
  let miss = 0;

  for (const [id, s] of Object.entries(itemsMap)) {
    if (!s) continue;

    if (hasVol1(s)) {
      skipped++;
      continue;
    }

    const title = s.titleNative || s.titleRomaji || s.title || s.seriesKey || id;
    const author = s.author || "";

    let best = null;

    // 1) title+author（精度優先）
    try {
      const data = await rakutenSearch({ title, author });
      best = pickVol1Candidate(title, author, data?.Items || []);
    } catch (e) {
      console.log(`[vol1_backfill] id=${id} rakuten_error=${String(e?.message || e)}`);
      miss++;
      await sleep(250);
      continue;
    }

    // 2) ダメなら author なし（取りこぼし対策）
    if (!best) {
      try {
        const data2 = await rakutenSearch({ title, author: "" });
        best = pickVol1Candidate(title, author, data2?.Items || []);
      } catch {
        // ignore
      }
    }

    if (!best) {
      console.log(`[vol1_backfill] id=${id} -> no_good_candidate`);
      miss++;
      await sleep(220);
      continue;
    }

    const isbn13 = digits(best.isbn);
    const img = best.largeImageUrl || best.mediumImageUrl || best.smallImageUrl || null;

    s.vol1 = {
      ...(s.vol1 || {}),
      isbn13,
      image: s?.vol1?.image || img,
      // description は fill_series_synopsis.mjs 等で埋める
    };

    added++;
    console.log(`[vol1_backfill] id=${id} -> "${best.title}" isbn=${isbn13}`);
    await sleep(220);
  }

  await fs.writeFile(SERIES_PATH, JSON.stringify(root, null, 2));
  console.log(`vol1_backfill: added=${added} skipped=${skipped} miss=${miss}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
