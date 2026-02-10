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

function joinIf(arr, sep = " / ") {
  if (!Array.isArray(arr)) return "";
  const xs = arr.map((x) => String(x ?? "").trim()).filter(Boolean);
  return xs.join(sep);
}

function renderList(data) {
  const root = document.getElementById("list");
  if (!root) return;

  const items = data?.items || [];
  if (!items.length) {
    root.innerHTML = `<div class="status">表示できる作品がありません</div>`;
    return;
  }

  root.innerHTML = items
    .map((it) => {
      const key = encodeURIComponent(it.seriesKey);
      const title = it.title || it.seriesKey || "";
      const author = it.author || "";
      const img = it.image || "";
      const vol1Amz = it.amazonDp || "";
      const isbn = it.isbn13 || "";
      const release = it.releaseDate || "";
      const pub = it.publisher?.brand || it.publisher?.manufacturer || "";

      const subBits = [];
      if (author) subBits.push(esc(author));
      if (isbn) subBits.push(`ISBN: ${esc(isbn)}`);
      if (release) subBits.push(`発売: ${esc(release)}`);
      if (pub) subBits.push(`出版社: ${esc(pub)}`);

      return `
      <article class="card">
        <div class="card-row">
          <div class="thumb">
            ${
              img
                ? `<a href="${esc(vol1Amz || "#")}" target="_blank" rel="nofollow noopener">
                    <img src="${esc(img)}" alt="${esc(title)}"/>
                  </a>`
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

  const title = it.title || it.seriesKey || "";
  const author = it.author || "";
  const img = it.image || "";
  const vol1Amz = it.amazonDp || "";
  const isbn = it.isbn13 || "";
  const release = it.releaseDate || "";
  const pub = it.publisher?.brand || it.publisher?.manufacturer || "";
  const desc = it.description || ""; // openBD → wiki のみが入る想定
  const descSrc = it.descriptionSource || ""; // "openbd" or "wikipedia"

  const headerBits = [];
  if (author) headerBits.push(esc(author));
  if (isbn) headerBits.push(`ISBN: ${esc(isbn)}`);
  if (release) headerBits.push(`発売: ${esc(release)}`);
  if (pub) headerBits.push(`出版社: ${esc(pub)}`);

  const descLabel =
    descSrc === "openbd" ? "あらすじ（openBD）" : descSrc === "wikipedia" ? "あらすじ（Wikipedia）" : "あらすじ";

  detail.innerHTML = `
    <div class="d-title">${esc(it.seriesKey)}</div>
    <div class="d-sub">${headerBits.join(" / ")}</div>

    <div class="d-row">
      ${img ? `<img class="d-img" src="${esc(img)}" alt="${esc(title)}"/>` : ""}
      <div class="d-links">
        ${
          vol1Amz
            ? `<a class="btn" href="${esc(vol1Amz)}" target="_blank" rel="nofollow noopener">Amazon（1巻）</a>`
            : ""
        }
      </div>
    </div>

    ${
      desc
        ? `<div class="d-note">
            <div class="d-label">${esc(descLabel)}</div>
            <div class="d-desc">${esc(desc).replaceAll("\n", "<br>")}</div>
          </div>`
        : ""
    }
  `;
}

(async function main() {
  try {
    // ★ series.json ではなく works.json
    const data = await loadJson("./data/lane2/works.json");
    renderList(data);
    renderWork(data);
  } catch (e) {
    const s = document.getElementById("status");
    if (s) s.textContent = "読み込みに失敗しました";
    console.error(e);
  }
})();
