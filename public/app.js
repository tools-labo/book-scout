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

function chips(arr, cls = "chip") {
  if (!Array.isArray(arr) || !arr.length) return "";
  return `<div class="chips">${arr.map((x) => `<span class="${cls}">${esc(x)}</span>`).join("")}</div>`;
}

function pubText(it) {
  const d = it.releaseDate ? `発売: ${esc(it.releaseDate)}` : "";
  const p = it.publisher?.brand ? `出版社: ${esc(it.publisher.brand)}` : "";
  if (!d && !p) return "";
  if (d && p) return `${d} / ${p}`;
  return d || p;
}

function magazineText(it) {
  const mags = it.serializedIn;
  if (!Array.isArray(mags) || !mags.length) return "";
  return `連載: ${esc(mags.join(" / "))}`;
}

function renderList(data) {
  const root = document.getElementById("list");
  if (!root) return;

  const items = data?.items || [];
  if (!items.length) {
    root.innerHTML = `<div class="status">表示できる作品がありません（1巻確定が0件）</div>`;
    return;
  }

  root.innerHTML = items.map((it) => {
    const key = encodeURIComponent(it.seriesKey);
    const title = it.title || it.seriesKey;
    const author = it.author || "";
    const img = it.image || "";
    const vol1Amz = it.amazonDp || "#";
    const isbn = it.isbn13 || "";

    const mags = magazineText(it);
    const pub = pubText(it);

    const genresHtml = chips(it.genres, "chip chip-genre");
    const tagsHtml = chips(it.tags, "chip chip-tag");

    const desc = it.description || "";
    const descHtml = desc
      ? `
        <details class="synopsis">
          <summary>あらすじ</summary>
          <div class="synopsis-body">${esc(desc)}</div>
        </details>
      `
      : "";

    return `
      <article class="card">
        <div class="card-row">
          <div class="thumb">
            ${
              img
                ? `<a href="${esc(vol1Amz)}" target="_blank" rel="nofollow noopener"><img src="${esc(img)}" alt="${esc(title)}"/></a>`
                : `<div class="thumb-ph"></div>`
            }
          </div>
          <div class="meta">
            <div class="title"><a href="./work.html?key=${key}">${esc(it.seriesKey)}</a></div>

            <div class="sub">
              ${author ? `<span>${esc(author)}</span>` : ""}
              ${isbn ? `<span>${author ? " / " : ""}ISBN: ${esc(isbn)}</span>` : ""}
            </div>

            ${mags ? `<div class="kvs">${mags}</div>` : ""}
            ${pub ? `<div class="kvs">${pub}</div>` : ""}

            ${genresHtml ? `<div class="kvs-label">ジャンル</div>${genresHtml}` : ""}
            ${tagsHtml ? `<div class="kvs-label">タグ</div>${tagsHtml}` : ""}

            ${descHtml}
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

  const mags = magazineText(it);
  const pub = pubText(it);

  const genresHtml = chips(it.genres, "chip chip-genre");
  const tagsHtml = chips(it.tags, "chip chip-tag");

  const desc = it.description || "";

  detail.innerHTML = `
    <div class="d-title">${esc(it.seriesKey)}</div>
    <div class="d-sub">
      ${author ? esc(author) : ""}
      ${isbn ? `${author ? " / " : ""}ISBN: ${esc(isbn)}` : ""}
    </div>

    ${(mags || pub) ? `<div class="d-kvs">${mags ? `<div>${mags}</div>` : ""}${pub ? `<div>${pub}</div>` : ""}</div>` : ""}

    <div class="d-row">
      ${img ? `<img class="d-img" src="${esc(img)}" alt="${esc(title)}"/>` : ""}
      <div class="d-links">
        ${vol1Amz ? `<a class="btn" href="${esc(vol1Amz)}" target="_blank" rel="nofollow noopener">Amazon（1巻）</a>` : ""}
        ${genresHtml ? `<div class="d-sec"><div class="kvs-label">ジャンル</div>${genresHtml}</div>` : ""}
        ${tagsHtml ? `<div class="d-sec"><div class="kvs-label">タグ</div>${tagsHtml}</div>` : ""}
      </div>
    </div>

    ${desc ? `<div class="d-desc"><div class="kvs-label">あらすじ</div><div class="d-desc-body">${esc(desc)}</div></div>` : ""}
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
