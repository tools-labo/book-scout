// public/app.js
async function loadJson(p) {
  const r = await fetch(p, { cache: "no-store" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return await r.json();
}
function qs() { return new URLSearchParams(location.search); }
function esc(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
function joinNonEmpty(parts, sep = " / ") {
  return parts.filter((x) => x != null && String(x).trim()).join(sep);
}

function renderChips(arr, cls = "chip") {
  const xs = Array.isArray(arr) ? arr.filter(Boolean) : [];
  if (!xs.length) return "";
  return `<div class="chips">${xs.map((x) => `<span class="${cls}">${esc(x)}</span>`).join("")}</div>`;
}

function renderList(data) {
  const root = document.getElementById("list");
  if (!root) return;

  const items = data?.items || [];
  if (!items.length) {
    root.innerHTML = `<div class="status">表示できる作品がありません</div>`;
    return;
  }

  root.innerHTML = items.map((it) => {
    const key = encodeURIComponent(it.seriesKey);
    const title = it.title || it.seriesKey;
    const author = it.author || "";
    const img = it.image || "";
    const vol1Amz = it.amazonDp || "#";

    const releaseDate = it.releaseDate || "";
    const publisher = it.publisher?.brand || it.publisher?.manufacturer || "";
    const magazine = it.magazine || "";

    const metaLine = joinNonEmpty([
      author,
      magazine ? `連載誌: ${magazine}` : null,
      releaseDate ? `発売日: ${releaseDate}` : null,
      publisher ? `出版社: ${publisher}` : null,
    ], " / ");

    const genres = Array.isArray(it.genres) ? it.genres : [];
    const tags = Array.isArray(it.tags) ? it.tags : [];

    const desc = it.description || "";

    return `
      <article class="card">
        <div class="card-row">
          <div class="thumb">
            ${img ? `<a href="${esc(vol1Amz)}" target="_blank" rel="nofollow noopener"><img src="${esc(img)}" alt="${esc(title)}"/></a>` : `<div class="thumb-ph"></div>`}
          </div>
          <div class="meta">
            <div class="title"><a href="./work.html?key=${key}">${esc(it.seriesKey)}</a></div>
            ${metaLine ? `<div class="sub">${esc(metaLine)}</div>` : ""}

            ${genres.length ? `<div class="sec"><div class="sec-h">ジャンル</div>${renderChips(genres)}</div>` : ""}
            ${tags.length ? `<div class="sec"><div class="sec-h">タグ</div>${renderChips(tags)}</div>` : ""}

            ${desc ? `
              <details class="desc">
                <summary>あらすじ</summary>
                <div class="desc-body">${esc(desc).replaceAll("\n", "<br>")}</div>
              </details>
            ` : ""}
          </div>
        </div>
      </article>
    `;
  }).join("");
}

function renderWork(data) {
  const detail = document.getElementById("detail");
  if (!detail) return;

  const key = qs().get("key");
  if (!key) {
    detail.innerHTML = `<div class="d-title">作品キーがありません</div>`;
    return;
  }

  const items = data?.items || [];
  const it = items.find((x) => x.seriesKey === key);
  if (!it) {
    detail.innerHTML = `<div class="d-title">見つかりませんでした</div>`;
    return;
  }

  const title = it.title || it.seriesKey;
  const author = it.author || "";
  const img = it.image || "";
  const vol1Amz = it.amazonDp || "";
  const isbn = it.isbn13 || "";

  const releaseDate = it.releaseDate || "";
  const publisher = it.publisher?.brand || it.publisher?.manufacturer || "";
  const magazine = it.magazine || "";

  const metaLine = joinNonEmpty([
    author,
    magazine ? `連載誌: ${magazine}` : null,
    releaseDate ? `発売日: ${releaseDate}` : null,
    publisher ? `出版社: ${publisher}` : null,
    isbn ? `ISBN: ${isbn}` : null,
  ], " / ");

  const genres = Array.isArray(it.genres) ? it.genres : [];
  const tags = Array.isArray(it.tags) ? it.tags : [];
  const desc = it.description || "";

  detail.innerHTML = `
    <div class="d-title">${esc(it.seriesKey)}</div>
    ${metaLine ? `<div class="d-sub">${esc(metaLine)}</div>` : ""}

    <div class="d-row">
      ${img ? `<img class="d-img" src="${esc(img)}" alt="${esc(title)}"/>` : ""}
      <div class="d-links">
        ${vol1Amz ? `<a class="btn" href="${esc(vol1Amz)}" target="_blank" rel="nofollow noopener">Amazon（1巻）</a>` : ""}
      </div>
    </div>

    ${genres.length ? `<div class="sec"><div class="sec-h">ジャンル</div>${renderChips(genres)}</div>` : ""}
    ${tags.length ? `<div class="sec"><div class="sec-h">タグ</div>${renderChips(tags)}</div>` : ""}

    ${desc ? `
      <div class="sec">
        <div class="sec-h">あらすじ</div>
        <div class="d-desc">${esc(desc).replaceAll("\n", "<br>")}</div>
      </div>
    ` : ""}
  `;
}

(async function main() {
  try {
    const data = await loadJson("./data/lane2/works.json");
    renderList(data);
    renderWork(data);
  } catch (e) {
    const s = document.getElementById("status");
    if (s) s.textContent = "読み込みに失敗しました";
    console.error(e);
  }
})();
