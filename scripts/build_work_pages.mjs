// scripts/build_work_pages.mjs (FULL REPLACE)
import fs from "node:fs";
import path from "node:path";

const ROOT_PUBLIC = "public";
const WORK_DIR = path.join(ROOT_PUBLIC, "work");

// 独自ドメイン
const SITE_ORIGIN = "https://book-scout.tools-labo.com";
const SITE_BASE_PATH = "";

// GA4
const GA_MEASUREMENT_ID = "G-09Q7K095VK";

// OGP画像は未導入なら空のまま
// 後で共通画像を置いたら "/assets/ogp/book-scout.png" などに差し替え
const OGP_IMAGE_URL = "";

// base64url
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
}

function pad3(n) {
  return String(n).padStart(3, "0");
}

function safeReadJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function cleanDate(s) {
  const t = String(s ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : "";
}

function absoluteUrlFromMaybeRelative(u) {
  const raw = String(u ?? "").trim();
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.startsWith("/")) return `${SITE_ORIGIN}${raw}`;
  return `${SITE_ORIGIN}/${raw}`;
}

function normalizeAmazonAffiliate(urlLike) {
  const raw = String(urlLike ?? "").trim();
  if (!raw) return "";

  try {
    const u = new URL(raw);
    const h = String(u.hostname || "").toLowerCase();
    const isAmazonJp =
      h === "amazon.co.jp" ||
      h === "www.amazon.co.jp" ||
      h.endsWith(".amazon.co.jp");

    if (!isAmazonJp) return raw;
    if (!u.searchParams.has("tag")) {
      u.searchParams.set("tag", "book-scout-22");
    }
    return u.toString();
  } catch {
    return raw;
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
const shardCache = new Map();

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

// 既存生成物を作り直し
fs.rmSync(WORK_DIR, { recursive: true, force: true });
fs.mkdirSync(WORK_DIR, { recursive: true });

function pickText(...vals) {
  for (const v of vals) {
    const t = String(v ?? "").trim();
    if (t) return t;
  }
  return "";
}

function makeTitle({ title, seriesKey }) {
  const t = pickText(title, seriesKey, "作品");
  return `${t}｜あらすじ・作品情報 - BOOKスカウト`;
}

function makeDescription({ title, seriesKey, synopsis }) {
  const t = pickText(title, seriesKey, "この作品");
  const s = clip(synopsis, 110);

  if (s) {
    return clip(`${s} BOOKスカウトであらすじ、タグ、読後感投票、関連作品を確認できます。`, 140);
  }

  return `${t} のあらすじ、タグ、読後感投票、関連作品をBOOKスカウトで確認できます。`;
}

function canonicalUrlFromId(id) {
  return `${SITE_ORIGIN}${SITE_BASE_PATH}/work/${id}/`;
}

function makeBookJsonLd({
  name,
  description,
  url,
  image,
  author,
  publisher,
  datePublished,
  isbn13,
}) {
  const obj = {
    "@context": "https://schema.org",
    "@type": "Book",
    name,
    url,
  };

  if (description) obj.description = description;
  if (image) obj.image = image;
  if (author) obj.author = { "@type": "Person", name: author };
  if (publisher) obj.publisher = { "@type": "Organization", name: publisher };
  if (datePublished) obj.datePublished = datePublished;
  if (isbn13) obj.isbn = isbn13;

  return JSON.stringify(obj, null, 2);
}

function pageHtml({
  pageTitle,
  description,
  canonicalUrl,
  ogImageUrl,
  jsonLd,
}) {
  const desc = String(description || "").trim();
  const canon = String(canonicalUrl || "").trim();
  const ogImage = String(ogImageUrl || "").trim();
  const gaId = String(GA_MEASUREMENT_ID || "").trim();

  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escHtml(pageTitle)}</title>

  ${desc ? `<meta name="description" content="${escHtml(desc)}" />` : ""}
  ${canon ? `<link rel="canonical" href="${escHtml(canon)}" />` : ""}

  <meta property="og:site_name" content="BOOKスカウト" />
  <meta property="og:locale" content="ja_JP" />
  <meta property="og:type" content="article" />
  <meta property="og:title" content="${escHtml(pageTitle)}" />
  ${desc ? `<meta property="og:description" content="${escHtml(desc)}" />` : ""}
  ${canon ? `<meta property="og:url" content="${escHtml(canon)}" />` : ""}
  ${ogImage ? `<meta property="og:image" content="${escHtml(ogImage)}" />` : ""}

  <meta name="twitter:card" content="${ogImage ? "summary_large_image" : "summary"}" />
  <meta name="twitter:title" content="${escHtml(pageTitle)}" />
  ${desc ? `<meta name="twitter:description" content="${escHtml(desc)}" />` : ""}
  ${ogImage ? `<meta name="twitter:image" content="${escHtml(ogImage)}" />` : ""}

  <link rel="stylesheet" href="../../style.css" />

  ${
    gaId
      ? `
  <!-- Google tag (gtag.js) -->
  <script async src="https://www.googletagmanager.com/gtag/js?id=${escHtml(gaId)}"></script>
  <script>
    window.dataLayer = window.dataLayer || [];
    function gtag(){dataLayer.push(arguments);}
    gtag('js', new Date());
    gtag('config', '${escHtml(gaId)}');
  </script>`
      : ""
  }

  <script type="application/ld+json">
${jsonLd}
  </script>
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
    <a href="https://tools-labo.com/" target="_blank" rel="noopener noreferrer">Tools-LABOホーム</a>
    <a href="../../privacy/">プライバシーポリシー</a>
    <a href="https://docs.google.com/forms/d/e/1FAIpQLSfF73yZ69HH-FASKEYSkp98zM92o4dtQLtiQs7BzLRuwsobfA/viewform?pli=1"
       target="_blank" rel="noopener noreferrer">お問い合わせ</a>
  </div>
  </footer>
  </main>

  <script>
    (function () {
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

let n = 0;
let missSynopsis = 0;
let missIsbn = 0;

for (const it of items) {
  const seriesKey = String(it?.seriesKey || "").trim();
  if (!seriesKey) continue;

  const id = b64urlFromUtf8(seriesKey);
  const dir = path.join(WORK_DIR, id);
  fs.mkdirSync(dir, { recursive: true });

  const full = findFullWorkBySeriesKey(seriesKey);

  const title = pickText(it?.title, full?.title, seriesKey);
  const synopsis = pickText(
    full?.synopsis,
    full?.vol1?.synopsis,
    it?.synopsis,
    it?.vol1?.synopsis
  );

  const author = pickText(
    full?.author,
    full?.vol1?.author,
    it?.author,
    it?.vol1?.author
  );

  const publisher = pickText(
    full?.publisher,
    full?.vol1?.publisher,
    it?.publisher,
    it?.vol1?.publisher
  );

  const releaseDate = cleanDate(
    pickText(
      full?.releaseDate,
      full?.vol1?.releaseDate,
      it?.releaseDate,
      it?.vol1?.releaseDate
    )
  );

  const image = absoluteUrlFromMaybeRelative(
    pickText(
      full?.image,
      full?.vol1?.image,
      it?.image,
      it?.vol1?.image
    )
  );

  const amazonUrl = normalizeAmazonAffiliate(
    pickText(
      full?.amazonDp,
      full?.vol1?.amazonDp,
      full?.amazonUrl,
      full?.vol1?.amazonUrl,
      it?.amazonDp,
      it?.vol1?.amazonDp,
      it?.amazonUrl,
      it?.vol1?.amazonUrl
    )
  );

  const isbn13 = pickText(
    full?.isbn13,
    full?.vol1?.isbn13,
    it?.isbn13,
    it?.vol1?.isbn13
  );

  const pageTitle = makeTitle({ title, seriesKey });
  const description = makeDescription({ title, seriesKey, synopsis });
  const canonicalUrl = canonicalUrlFromId(id);

  const jsonLd = makeBookJsonLd({
    name: title || seriesKey,
    description,
    url: canonicalUrl,
    image,
    author,
    publisher,
    datePublished: releaseDate,
    isbn13,
  });

  fs.writeFileSync(
    path.join(dir, "index.html"),
    pageHtml({
      pageTitle,
      description,
      canonicalUrl,
      ogImageUrl: OGP_IMAGE_URL,
      jsonLd,
    }),
    "utf8"
  );

  if (!synopsis) missSynopsis++;
  if (!isbn13) missIsbn++;
  n++;
}

console.log(
  `[build_work_pages] generated: ${n} pages -> ${WORK_DIR} (synopsis missing: ${missSynopsis}, isbn13 missing: ${missIsbn})`
);
