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

function fmtDate(d) {
  // works.json は YYYY-MM-DD の想定。無ければ空。
  return d ? String(d) : "";
}

function renderList(data) {
  const root = document.getElementById("list");
  if (!root) return;

  const items = data?.items || [];
  if (!items.length) {
    root.innerHTML = `<div class="status">表示できる作品がありません（works.json が0件）</div>`;
    return;
  }

  root.innerHTML = items
    .map((it) => {
      const key = encodeURIComponent(it.seriesKey);
      const title = it.title || it.seriesKey;
      const author = it.author || "";
      const img = it.image || "";
      const amz = it.amazonDp || "#";
      const isbn = it.isbn13 || "";
      const date = fmtDate(it.releaseDate);
      const genres = Array.isArray(it.genres) ? it.genres.slice(0, 3) : [];

      const subBits = [];
      if (author) subBits.push(esc(author));
      if (isbn) subBits.push(`ISBN: ${esc(isbn)}`);
      if (date) subBits.push(`発売: ${esc(date)}`);
      if (genres.length) subBits.push(`ジャンル: ${esc(genres.join(" / "))}`);

      return `
        <article class="card">
          <div class="card-row">
            <div class="thumb">
              ${
                img
                  ? `<a href="${esc(amz)}" target="_blank" rel="nofollow noopener"><img src="${esc(img)}" alt="${esc(title)}"/></a>`
                  : `<div class="thumb-ph"></div>`
              }
            </div>
            <div class="meta">
              <div class="title"><a href="./work.html?key=${key}">${esc(it.seriesKey)}</a></div>
              <div class="sub">${subBits.join(" / ")}</div>
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

  const items = data?.items || [];
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
  const date = fmtDate(it.releaseDate);

  const pubBrand = it.publisher?.brand || "";
  const pubManu = it.publisher?.manufacturer || "";
  const publisher =
    pubBrand && pubManu && pubBrand !== pubManu
      ? `${pubBrand} / ${pubManu}`
      : (pubBrand || pubManu || "");

  const genres = Array.isArray(it.genres) ? it.genres : [];
  const tags = Array.isArray(it.tags) ? it.tags : [];

  // 長文はそのまま出す（必要なら後で折りたたみUIに）
  const desc = it.description || "";
  const descSrc = it.descriptionSource ? `（${it.descriptionSource}）` : "";

  const subBits = [];
  if (author) subBits.push(esc(author));
  if (isbn) subBits.push(`ISBN: ${esc(isbn)}`);
  if (date) subBits.push(`発売: ${esc(date)}`);
  if (publisher) subBits.push(`出版社: ${esc(publisher)}`);

  detail.innerHTML = `
    <div class="d-title">${esc(it.seriesKey)}</div>
    <div class="d-sub">${subBits.join(" / ")}</div>

    <div class="d-row">
      ${img ? `<img class="d-img" src="${esc(img)}" alt="${esc(title)}"/>` : ""}
      <div class="d-links">
        ${amz ? `<a class="btn" href="${esc(amz)}" target="_blank" rel="nofollow noopener">Amazon（1巻）</a>` : ""}
      </div>
    </div>

    ${
      genres.length
        ? `<div class="d-note">ジャンル: ${esc(genres.join(" / "))}</div>`
        : ""
    }
    ${
      tags.length
        ? `<div class="d-note">タグ: ${esc(tags.slice(0, 12).join(" / "))}</div>`
        : ""
    }
    ${
      desc
        ? `<div class="d-note">説明${esc(descSrc)}：<br/>${esc(desc).replaceAll("\n", "<br/>")}</div>`
        : ""
    }
  `;
}

(async function main() {
  try {
    // ★ series.json ではなく works.json を読む
    const data = await loadJson("./data/lane2/works.json");
    renderList(data);
    renderWork(data);
  } catch (e) {
    const s = document.getElementById("status");
    if (s) s.textContent = "読み込みに失敗しました";
    console.error(e);
  }
})();
