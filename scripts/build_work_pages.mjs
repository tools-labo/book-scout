// scripts/build_work_pages.mjs（FULL REPLACE）
// - public/work/<id>/index.html を全作品分生成
// - 静的ページURLを汚さない（?key= を付けない）
//   ※ key は public/app.js 側の resolveWorkKey() が pathname から復元する前提
import fs from "node:fs";
import path from "node:path";

const ROOT_PUBLIC = "public";
const WORK_DIR = path.join(ROOT_PUBLIC, "work");

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

// index.json から listItems を取る（現構造に合わせる）
const idx = JSON.parse(fs.readFileSync("data/lane2/works/index.json", "utf8"));
const items = Array.isArray(idx?.listItems) ? idx.listItems : [];
if (!items.length) {
  console.error("index.json に listItems がありません");
  process.exit(1);
}

// 既存を一旦クリアして作り直す（work.html は別）
fs.rmSync(WORK_DIR, { recursive: true, force: true });
fs.mkdirSync(WORK_DIR, { recursive: true });

// 生成テンプレ
function pageHtml({ seriesKey, title }) {
  const pageTitle = `${title || seriesKey}｜BOOKスカウト`;

  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escHtml(pageTitle)}</title>
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
      // work/<id>/ は public/app.js が pathname から key を復元できるため、
      // URL に ?key= を付けたり書き換えたりしない（静的URLを保つ）。
      // ※ ここは意図的に空（将来の保険のため IIFE だけ残す）
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
for (const it of items) {
  const seriesKey = String(it?.seriesKey || "").trim();
  if (!seriesKey) continue;

  const id = b64urlFromUtf8(seriesKey);
  const dir = path.join(WORK_DIR, id);
  fs.mkdirSync(dir, { recursive: true });

  const title = String(it?.title || seriesKey);
  fs.writeFileSync(path.join(dir, "index.html"), pageHtml({ seriesKey, title }), "utf8");
  n++;
}

console.log(`[build_work_pages] generated: ${n} pages -> ${WORK_DIR}`);
