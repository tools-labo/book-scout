// scripts/lane2/test_rakuten_books_api.mjs
// FULL REPLACE
// 楽天 Books Total Search API 独立テスト
//
// 必須 env:
// RAKUTEN_APP_ID
// RAKUTEN_ACCESS_KEY
//
// 任意 env:
// RAKUTEN_AFFILIATE_ID
// RAKUTEN_TEST_ISBN
// RAKUTEN_TEST_REFERER
// RAKUTEN_TEST_ORIGIN

function norm(v) {
  return String(v ?? "").trim();
}

function mask(v, keepStart = 4, keepEnd = 3) {
  const s = norm(v);
  if (!s) return "(empty)";
  if (s.length <= keepStart + keepEnd) return "*".repeat(s.length);
  return `${s.slice(0, keepStart)}***${s.slice(-keepEnd)}`;
}

async function safeReadText(res) {
  try {
    return await res.text();
  } catch (e) {
    return `[read_text_failed] ${String(e?.message || e)}`;
  }
}

async function main() {
  const appId = norm(process.env.RAKUTEN_APP_ID);
  const accessKey = norm(process.env.RAKUTEN_ACCESS_KEY);
  const affiliateId = norm(process.env.RAKUTEN_AFFILIATE_ID);
  const isbnjan = norm(process.env.RAKUTEN_TEST_ISBN) || "9784088821294";
  const referer = norm(process.env.RAKUTEN_TEST_REFERER) || "https://book-scout.tools-labo.com/";
  const origin = norm(process.env.RAKUTEN_TEST_ORIGIN) || "https://book-scout.tools-labo.com";

  console.log("[rakuten:test] env");
  console.log(`- APP_ID: ${mask(appId)}`);
  console.log(`- ACCESS_KEY: ${accessKey ? "(set)" : "(empty)"}`);
  console.log(`- AFFILIATE_ID: ${affiliateId ? "(set)" : "(empty)"}`);
  console.log(`- TEST_ISBNJAN: ${isbnjan}`);
  console.log(`- REFERER: ${referer}`);
  console.log(`- ORIGIN: ${origin}`);

  const missing = [];
  if (!appId) missing.push("RAKUTEN_APP_ID");
  if (!accessKey) missing.push("RAKUTEN_ACCESS_KEY");

  if (missing.length) {
    console.error(`[rakuten:test] missing env: ${missing.join(", ")}`);
    process.exit(1);
  }

  const url = new URL("https://openapi.rakuten.co.jp/services/api/BooksTotal/Search/20170404");
  url.searchParams.set("applicationId", appId);
  url.searchParams.set("format", "json");
  url.searchParams.set("formatVersion", "2");
  url.searchParams.set("isbnjan", isbnjan);
  url.searchParams.set("outOfStockFlag", "1");

  if (affiliateId) {
    url.searchParams.set("affiliateId", affiliateId);
  }

  console.log(`[rakuten:test] GET ${url.origin}${url.pathname}?...`);

  const headers = {
    "User-Agent": "tools-labo/book-scout lane2 rakuten-test",
    "Authorization": `Bearer ${accessKey}`,
    "Referer": referer,
    "Origin": origin,
  };

  const res = await fetch(url.toString(), {
    method: "GET",
    headers,
  });

  const text = await safeReadText(res);

  console.log(`[rakuten:test] status=${res.status} ok=${res.ok}`);

  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }

  if (!res.ok) {
    if (json) {
      console.log(JSON.stringify(json, null, 2));
    } else {
      console.log(text);
    }
    process.exit(2);
  }

  const items = Array.isArray(json?.Items) ? json.Items : [];
  const first = items[0] || null;

  console.log(`[rakuten:test] hit_count=${items.length}`);

  if (!first) {
    console.log("[rakuten:test] no item found");
    process.exit(3);
  }

  const picked = {
    title: first.title || null,
    author: first.author || null,
    publisherName: first.publisherName || null,
    salesDate: first.salesDate || null,
    isbn: first.isbn || null,
    jan: first.jan || null,
    itemUrl: first.itemUrl || null,
    affiliateUrl: first.affiliateUrl || null,
    smallImageUrl: first.smallImageUrl || null,
    mediumImageUrl: first.mediumImageUrl || null,
    largeImageUrl: first.largeImageUrl || null,
  };

  console.log("[rakuten:test] first item:");
  console.log(JSON.stringify(picked, null, 2));
}

main().catch((e) => {
  console.error(`[rakuten:test] fatal: ${String(e?.message || e)}`);
  process.exit(1);
});
