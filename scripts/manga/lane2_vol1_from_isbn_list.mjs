import fs from "node:fs/promises";

const SEED = "data/manga/seed_isbn.json";
const OUT_OK = "data/manga/vol1_master.json";
const OUT_TODO = "data/manga/vol1_todo.json";

async function loadJson(p, fallback) {
  try {
    return JSON.parse(await fs.readFile(p, "utf8"));
  } catch {
    return fallback;
  }
}

async function saveJson(p, obj) {
  await fs.mkdir(p.split("/").slice(0, -1).join("/"), { recursive: true });
  await fs.writeFile(p, JSON.stringify(obj, null, 2));
}

function normIsbn13(s) {
  const x = String(s || "").replace(/[^0-9X]/gi, "");
  return /^\d{13}$/.test(x) ? x : null;
}

function dpFrom(asinOrUrl) {
  if (!asinOrUrl) return null;
  const s = String(asinOrUrl).trim();
  const m = s.match(/^https:\/\/www\.amazon\.co\.jp\/dp\/([A-Z0-9]{10}|[0-9]{9}X|[0-9]{10})/i);
  if (m) return `https://www.amazon.co.jp/dp/${m[1]}`;
  const asin = s.toUpperCase().replace(/[^0-9A-Z]/g, "");
  if (/^[A-Z0-9]{10}$/.test(asin)) return `https://www.amazon.co.jp/dp/${asin}`;
  return null;
}

async function fetchJson(url) {
  const r = await fetch(url, { headers: { "User-Agent": "book-scout/0.1" } });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return await r.json();
}

function pickRakutenItem(apiJson, targetIsbn13) {
  const items = apiJson?.Items || [];
  // ISBN一致を最優先
  for (const wrap of items) {
    const it = wrap?.Item;
    const isbn = normIsbn13(it?.isbn);
    if (isbn && isbn === targetIsbn13) return it;
  }
  // 無ければ先頭（ただし危険なので null）
  return null;
}

function toVol1Record(seriesKey, isbn13, it) {
  const title = it?.title || null;
  const author = it?.author || null;
  const publisher = it?.publisherName || null;
  const publishedAt = it?.salesDate || null;
  const description = it?.itemCaption || null;
  const image = it?.largeImageUrl || it?.mediumImageUrl || it?.smallImageUrl || null;

  // 楽天にはAmazon直は無いので、Amazonは別レーンで後で付与
  return {
    seriesKey,
    isbn13,
    title,
    author,
    publisher,
    publishedAt,
    description,
    image,
    amazonDp: null,
    confirmedVol1: true,
    source: {
      rakuten: it?.itemUrl || null
    }
  };
}

async function main() {
  const seed = await loadJson(SEED, []);
  const appId = process.env.RAKUTEN_APP_ID || "";

  const ok = {};
  const todo = [];

  for (const row of seed) {
    const seriesKey = String(row?.seriesKey || "").trim();
    const isbn13 = normIsbn13(row?.isbn13);

    if (!seriesKey || !isbn13) {
      todo.push({ seriesKey, isbn13: row?.isbn13 ?? null, reason: "bad_seed_row" });
      continue;
    }

    if (!appId) {
      todo.push({ seriesKey, isbn13, reason: "no_rakuten_app_id" });
      continue;
    }

    // 楽天：BooksBookSearch（ISBN指定ができる）
    const url =
      "https://app.rakuten.co.jp/services/api/BooksBook/Search/20170404" +
      `?applicationId=${encodeURIComponent(appId)}` +
      `&isbn=${encodeURIComponent(isbn13)}` +
      `&format=json`;

    try {
      const j = await fetchJson(url);
      const it = pickRakutenItem(j, isbn13);
      if (!it) {
        todo.push({ seriesKey, isbn13, reason: "rakuten_not_found" });
        continue;
      }
      ok[seriesKey] = toVol1Record(seriesKey, isbn13, it);
    } catch (e) {
      todo.push({ seriesKey, isbn13, reason: "rakuten_error", err: String(e?.message || e) });
    }
  }

  await saveJson(OUT_OK, ok);
  await saveJson(OUT_TODO, todo);

  console.log(`[lane2_vol1] seed=${seed.length} ok=${Object.keys(ok).length} todo=${todo.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
