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

// 既存を一旦クリアして作り直す（work.htmlは別）
fs.rmSync(WORK_DIR, { recursive: true, force: true });
fs.mkdirSync(WORK_DIR, { recursive: true });

function makeDescription({ seriesKey, title, synopsis }) {
  const s = clip(synopsis, 120);
  if (s) return s;

  const t = String(title || seriesKey || "").trim();
  if (t) return `${t} の作品情報（タグ・投票・お気に入り）を確認できます。`;
  return "作品情報（タグ・投票・お気に入り）を確認できます。";
}

function canonicalUrlFromId(id) {
  // 例: https://book-scout.tools-labo.com/work/<id>/
  return `${SITE_ORIGIN}${SITE_BASE_PATH}/work/${id}/`;
}

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

let n = 0;
let miss = 0;

for (const it of items) {
  const seriesKey = String(it?.seriesKey || "").trim();
  if (!seriesKey) continue;

  const id = b64urlFromUtf8(seriesKey);
  const dir = path.join(WORK_DIR, id);
  fs.mkdirSync(dir, { recursive: true });

  const title = String(it?.title || seriesKey).trim() || seriesKey;

  // synopsis は shard 側（フル）優先
  const full = findFullWorkBySeriesKey(seriesKey);
  const synopsis = String(
    full?.synopsis ??
      full?.vol1?.synopsis ??
      it?.synopsis ??
      it?.vol1?.synopsis ??
      ""
  ).trim();

  const description = makeDescription({ seriesKey, title, synopsis });
  const canonicalUrl = canonicalUrlFromId(id);

  fs.writeFileSync(
    path.join(dir, "index.html"),
    pageHtml({ title, description, canonicalUrl }),
    "utf8"
  );

  if (!synopsis) miss++;
  n++;
}

console.log(
  `[build_work_pages] generated: ${n} pages -> ${WORK_DIR} (synopsis missing: ${miss})`
);
