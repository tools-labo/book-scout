// scripts/manga/vol1_backfill_rakuten.mjs （全差し替え）
import fs from "node:fs/promises";

const APP_ID = process.env.RAKUTEN_APP_ID;
if (!APP_ID) {
  console.log("Skip: RAKUTEN_APP_ID not set");
  process.exit(0);
}

const SERIES_PATH = "data/manga/series_master.json";
const ITEMS_MASTER_PATH = "data/manga/items_master.json";

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
    score += 10; // vol1限定の基礎点

    if (score > bestScore) {
      bestScore = score;
      best = it;
    }
  }

  // タイトル一致が弱いものは誤爆しやすいので切る（安全側）
  if (!best || bestScore < 60) return null;
  return best;
}

async function fetchJson(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), 15000);
    try {
      const r = await fetch(url, { cache: "no-store", signal: ac.signal });
      clearTimeout(to);
      if (r.ok) return await r.json();
      if ((r.status === 429 || r.status >= 500) && i < tries - 1) {
        await sleep(800 + i * 600);
        continue;
      }
      const t = await r.text().catch(() => "");
      throw new Error(`HTTP ${r.status}\n${t.slice(0, 120)}`);
    } catch (e) {
      clearTimeout(to);
      if (i < tries - 1) {
        await sleep(800 + i * 600);
        continue;
      }
      throw e;
    }
  }
  return null;
}

function pickOpenbdText(x) {
  const tcs = x?.onix?.CollateralDetail?.TextContent;
  if (Array.isArray(tcs)) {
    const hit = tcs.find((a) => a?.Text) || tcs.find((a) => a?.Text?.[0]);
    const t = hit?.Text;
    if (typeof t === "string") return t;
    if (Array.isArray(t) && typeof t[0] === "string") return t[0];
  }
  const s = x?.summary?.description;
  return typeof s === "string" ? s : null;
}

async function openbdByIsbn(isbn13) {
  const u = `https://api.openbd.jp/v1/get?isbn=${encodeURIComponent(isbn13)}`;
  const r = await fetchJson(u);
  const x = Array.isArray(r) ? r[0] : null;
  return x || null;
}

function hasVol1(s) {
  const isbn13 = s?.vol1?.isbn13;
  return isbn13 && digits(isbn13).length === 13;
}

async function main() {
  // 1) 今日の「最新刊リスト(=items_masterの_rep=true)」から対象workKeyを作る
  const itemsMaster = JSON.parse(await fs.readFile(ITEMS_MASTER_PATH, "utf8"));
  const targetWorkKeys = new Set(
    (itemsMaster || [])
      .filter((x) => x && x._rep && x.seriesType === "main" && x.workKey)
      .map((x) => String(x.workKey))
  );

  if (targetWorkKeys.size === 0) {
    console.log("vol1_backfill: targetWorkKeys=0 (skip)");
    return;
  }

  // 2) series_master 読み込み
  const root = JSON.parse(await fs.readFile(SERIES_PATH, "utf8"));
  const itemsMap = root?.items && typeof root.items === "object" ? root.items : null;
  if (!itemsMap) {
    throw new Error(
      `series_master.json format invalid: expected { meta, items }, but got keys=${Object.keys(root || {}).join(",")}`
    );
  }

  // 3) 対象シリーズだけ抽出（キーが数字のものだけ）
  const candidates = [];
  for (const [id, s] of Object.entries(itemsMap)) {
    if (!/^\d+$/.test(id)) continue; // id=vol1 みたいな誤キーを排除
    if (!s) continue;
    if (!s.seriesKey) continue;
    if (!targetWorkKeys.has(String(s.seriesKey))) continue; // 今日の最新刊に出てるシリーズだけ
    candidates.push([id, s]);
  }

  let added = 0;
  let skipped = 0;
  let miss = 0;
  let filledDesc = 0;

  for (const [id, s] of candidates) {
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

    // 4) openBDであらすじ（description）を取得（必須要件に寄せる）
    let desc = null;
    try {
      const ob = await openbdByIsbn(isbn13);
      desc = ob ? pickOpenbdText(ob) : null;
    } catch {
      // ignore
    }

    s.vol1 = {
      ...(s.vol1 || {}),
      isbn13,
      image: s?.vol1?.image || img,
      description: s?.vol1?.description || desc || null,
    };

    added++;
    if (desc && !s?.vol1?.description) filledDesc++;
    console.log(
      `[vol1_backfill] id=${id} -> "${best.title}" isbn=${isbn13} desc=${desc ? "yes" : "no"}`
    );

    await sleep(260); // Rakuten+openBDの負荷を軽く
  }

  await fs.writeFile(SERIES_PATH, JSON.stringify(root, null, 2));
  console.log(
    `vol1_backfill: target=${candidates.length} added=${added} skipped=${skipped} miss=${miss} descFilled=${filledDesc}`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
