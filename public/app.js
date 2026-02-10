// public/app.js
async function loadJson(p) {
  const r = await fetch(p, { cache: "no-store" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return await r.json();
}

function qs() {
  return new URLSearchParams(location.search);
}

function esc(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// works.json の1件を「フロントで使いやすい形」に正規化
function normWork(it) {
  if (!it) return null;
  return {
    seriesKey: it.seriesKey || "",
    title: it.title || it.seriesKey || "",
    author: it.author || "",
    image: it.image || "",
    amazonDp: it.amazonDp || "",
    isbn13: it.isbn13 || "",
    releaseDate: it.releaseDate || "",
    publisher: it.publisher || "",
    description: it.description || "",
    genres: Array.isArray(it.genres) ? it.genres : [],
    tags: Array.isArray(it.tags) ? it.tags : [],
  };
}

function renderList(data) {
  const root = document.getElementById("list");
  if (!root) return;

  const items = Array.isArray(data?.items) ? data.items.map(normWork).filter(Boolean) : [];
  if (!items.length) {
    root.innerHTML = `<div class="status">表示できる作品がありません</div>`;
    return;
  }

  root.innerHTML = items
    .map((it) => {
      const key = encodeURIComponent(it.seriesKey);
      const title = it.title || it.seriesKey;
      const author = it.author || "";
      const img = it.image || "";
      const amz = it.amazonDp || "#";

      // 「日本語化方針」：genre/tags/英語はここでは出さない（後で日本語だけに整えたら出す）
      return `
        <article class="card">
          <div class="card-row">
            <div class="thumb">
              ${
                img
                  ? `<a href="${esc(amz)}" target="_blank" rel="nofollow noopener">
                       <img src="${esc(img)}" alt="${esc(title)}"/>
                     </a>`
                  : `<div class="thumb-ph"></div>`
              }
            </div>
            <div class="meta">
              <div class="title"><a href="./work.html?key=${key}">${esc(it.seriesKey)}</a></div>
              <div class="sub">
                ${author ? `<span>${esc(author)}</span>` : ""}
              </div>
            </div>
          </div>
        </article>
      `;
    })
    .join("");
}

function renderWork(data) {
  const detail = document.getElementById("detail");
  if (!detail) return;

  const key = qs().get("key");
  if (!key) {
    detail.innerHTML = `<div class="d-title">作品キーがありません</div>`;
    return;
  }

  const items = Array.isArray(data?.items) ? data.items.map(normWork).filter(Boolean) : [];
  const it = items.find((x) => x.seriesKey === key);
  if (!it) {
    detail.innerHTML = `<div class="d-title">見つかりませんでした</div>`;
    return;
  }

  const title = it.title || it.seriesKey;
  const author = it.author || "";
  const img = it.image || "";
  const amz = it.amazonDp || "";
  const isbn = it.isbn13 || "";
  const rel = it.releaseDate || "";
  const pub = it.publisher || "";
  const desc = it.description || "";

  // 日本語化方針：
  // - 英語あらすじは出さない（パイプライン側で description を日本語ソース限定にする）
  // - genre/tagsも日本語のみになったらここに表示を足す
  detail.innerHTML = `
    <div class="d-title">${esc(it.seriesKey)}</div>
    <div class="d-sub">
      ${author ? esc(author) : ""}
      ${isbn ? ` / ISBN: ${esc(isbn)}` : ""}
      ${rel ? ` / 発売: ${esc(rel)}` : ""}
      ${pub ? ` / 出版社: ${esc(pub)}` : ""}
    </div>

    <div class="d-row">
      ${img ? `<img class="d-img" src="${esc(img)}" alt="${esc(title)}"/>` : ""}
      <div class="d-links">
        ${amz ? `<a class="btn" href="${esc(amz)}" target="_blank" rel="nofollow noopener">Amazon（1巻）</a>` : ""}
      </div>
    </div>

    ${
      desc
        ? `
          <div class="d-note">
            <div style="margin-bottom:6px;">あらすじ</div>
            <div style="white-space:pre-wrap; line-height:1.6;">${esc(desc)}</div>
          </div>
        `
        : ""
    }
  `;
}

(async function main() {
  try {
    // ★works.json を読む
    const data = await loadJson("./data/lane2/works.json");
    renderList(data);
    renderWork(data);
  } catch (e) {
    const s = document.getElementById("status");
    if (s) s.textContent = "読み込みに失敗しました";
    console.error(e);
  }
})();
