// scripts/build_work_pages.mjs (FULL REPLACE)
import fs from "node:fs";
import path from "node:path";

const ROOT_PUBLIC = "public";
const WORK_DIR = path.join(ROOT_PUBLIC, "work");

// ✅ canonical の基準URL（独自ドメイン運用に合わせる）
const SITE_ORIGIN = "https://book-scout.tools-labo.com";
const SITE_BASE_PATH = ""; // サブドメイン直下なので空（先頭に / は不要）

// base64url (no /, +, =)
function b64urlFromUtf8(s) {
  const b64 = Buffer.from(String(s), "utf8").toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function escHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function normSpace(s) {
  return String(s ?? "")
    .replace(/\r?\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function clip(s, n) {
  const t = normSpace(s);
  if (!t) return "";
  return t.length > n ? t.slice(0, n) + "…" : t;
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

function pad3(n) {
  return String(n).padStart(3, "0");
function mask(v, keepStart = 4, keepEnd = 3) {
  const s = norm(v);
  if (!s) return "(empty)";
  if (s.length <= keepStart + keepEnd) return "*".repeat(s.length);
  return `${s.slice(0, keepStart)}***${s.slice(-keepEnd)}`;
}

function safeReadJson(p) {
async function safeReadText(res) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
    return await res.text();
  } catch (e) {
    return `[read_text_failed] ${String(e?.message || e)}`;
  }
}

// ---- load works index ----
const idxPath = "data/lane2/works/index.json";
const idx = safeReadJson(idxPath);
const items = Array.isArray(idx?.listItems) ? idx.listItems : [];
const lookup = idx?.lookup && typeof idx.lookup === "object" ? idx.lookup : null;

if (!items.length) {
  console.error("index.json に listItems がありません");
  process.exit(1);
}
if (!lookup) {
  console.error("index.json に lookup がありません（split構成を想定しています）");
  process.exit(1);
}

// shard cache
const shardCache = new Map(); // shardNo -> shardJson

function loadShard(shardNo) {
  const key = String(shardNo);
  if (shardCache.has(key)) return shardCache.get(key);

  const file = `data/lane2/works/works_${pad3(Number(shardNo))}.json`;
  const j = safeReadJson(file);
  shardCache.set(key, j);
  return j;
}

function findFullWorkBySeriesKey(seriesKey) {
  const shardNo = lookup?.[seriesKey];
  if (shardNo == null) return null;

  const shard = loadShard(shardNo);
  const arr = Array.isArray(shard?.items) ? shard.items : [];
  return arr.find((x) => String(x?.seriesKey || "").trim() === seriesKey) || null;
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

// 既存を一旦クリアして作り直す（work.htmlは別）
fs.rmSync(WORK_DIR, { recursive: true, force: true });
fs.mkdirSync(WORK_DIR, { recursive: true });
  const url = new URL("https://openapi.rakuten.co.jp/services/api/BooksTotal/Search/20170404");
  url.searchParams.set("applicationId", appId);
  url.searchParams.set("format", "json");
  url.searchParams.set("formatVersion", "2");
  url.searchParams.set("isbnjan", isbnjan);
  url.searchParams.set("outOfStockFlag", "1");

function makeDescription({ seriesKey, title, synopsis }) {
  const s = clip(synopsis, 120);
  if (s) return s;
  if (affiliateId) {
    url.searchParams.set("affiliateId", affiliateId);
  }

  const t = String(title || seriesKey || "").trim();
  if (t) return `${t} の作品情報（タグ・投票・お気に入り）を確認できます。`;
  return "作品情報（タグ・投票・お気に入り）を確認できます。";
}
  console.log(`[rakuten:test] GET ${url.origin}${url.pathname}?...`);

function canonicalUrlFromId(id) {
  // 例: https://book-scout.tools-labo.com/work/<id>/
  return `${SITE_ORIGIN}${SITE_BASE_PATH}/work/${id}/`;
}
  const headers = {
    "User-Agent": "tools-labo/book-scout lane2 rakuten-test",
    "Authorization": `Bearer ${accessKey}`,
    "Referer": referer,
    "Origin": origin,
  };

// 生成テンプレ
function pageHtml({ title, description, canonicalUrl }) {
  const pageTitle = `${title}｜BOOKスカウト`;
  const desc = description ? String(description) : "";
  const canon = String(canonicalUrl || "").trim();

  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escHtml(pageTitle)}</title>
  ${desc ? `<meta name="description" content="${escHtml(desc)}" />` : ""}
  ${canon ? `<link rel="canonical" href="${escHtml(canon)}" />` : ""}
  <link rel="stylesheet" href="../../style.css" />
</head>
<body class="has-gheader">
  <header class="gheader" id="gheader">
    <div class="gheader-inner">
      <div class="gbrand">
        <a class="gbrand-title" href="../../index.html">BOOKスカウト</a>
      </div>
      <nav class="gnav" aria-label="グローバルナビ">
        <a href="../../index.html">ホーム</a>
        <a href="../../list.html">リスト</a>
        <a href="../../stats.html">ランキング</a>
      </nav>
    </div>
  </header>

  <main class="wrap">
    <div id="status" class="status"></div>
    <section class="section" style="margin-top:6px;">
      <a class="section-link" href="../../list.html">← リストへ戻る</a>
    </section>
    <section class="grid" style="margin-top:12px;">
      <aside id="detail" class="detail">
        <div class="d-title">読み込み中…</div>
      </aside>
    </section>

    <footer class="gfooter" aria-label="サイトフッター">
      <div class="gfooter-inner">
        <span>© Tools-LABO</span>
        <a href="../../privacy/">プライバシーポリシー</a>
        <a href="https://docs.google.com/forms/d/e/1FAIpQLSfF73yZ69HH-FASKEYSkp98zM92o4dtQLtiQs7BzLRuwsobfA/viewform?pli=1"
           target="_blank" rel="noopener noreferrer">お問い合わせ</a>
      </div>
    </footer>
  </main>

  <script>
    (function () {
      // ✅ SEO: ?key=... が付いてきたら消す（/work/<id>/ を正にする）
      try {
        var p = new URLSearchParams(location.search);
        if (p.has("key")) {
          p.delete("key");
          var q = p.toString();
          history.replaceState(null, "", location.pathname + (q ? "?" + q : "") + location.hash);
        }
      } catch {}
    })();
  </script>

  <script>
    (function () {
      const v = new URLSearchParams(location.search).get("v");
      const s = document.createElement("script");
      s.src = "../../app.js" + (v ? ("?v=" + encodeURIComponent(v)) : "");
      document.body.appendChild(s);
    })();
  </script>
</body>
</html>`;
}
  const res = await fetch(url.toString(), {
    method: "GET",
    headers,
  });

let n = 0;
let miss = 0;
  const text = await safeReadText(res);

for (const it of items) {
  const seriesKey = String(it?.seriesKey || "").trim();
  if (!seriesKey) continue;
  console.log(`[rakuten:test] status=${res.status} ok=${res.ok}`);

  const id = b64urlFromUtf8(seriesKey);
  const dir = path.join(WORK_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }

  const title = String(it?.title || seriesKey).trim() || seriesKey;
  if (!res.ok) {
    if (json) {
      console.log(JSON.stringify(json, null, 2));
    } else {
      console.log(text);
    }
    process.exit(2);
  }

  // synopsis は shard 側（フル）優先
  const full = findFullWorkBySeriesKey(seriesKey);
  const synopsis = String(
    full?.synopsis ??
      full?.vol1?.synopsis ??
      it?.synopsis ??
      it?.vol1?.synopsis ??
      ""
  ).trim();
  const items = Array.isArray(json?.Items) ? json.Items : [];
  const first = items[0] || null;

  const description = makeDescription({ seriesKey, title, synopsis });
  const canonicalUrl = canonicalUrlFromId(id);
  console.log(`[rakuten:test] hit_count=${items.length}`);

  fs.writeFileSync(
    path.join(dir, "index.html"),
    pageHtml({ title, description, canonicalUrl }),
    "utf8"
  );
  if (!first) {
    console.log("[rakuten:test] no item found");
    process.exit(3);
  }

  if (!synopsis) miss++;
  n++;
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

console.log(
  `[build_work_pages] generated: ${n} pages -> ${WORK_DIR} (synopsis missing: ${miss})`
);
main().catch((e) => {
  console.error(`[rakuten:test] fatal: ${String(e?.message || e)}`);
  process.exit(1);
});
