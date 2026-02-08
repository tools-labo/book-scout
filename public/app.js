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
    const title = it.vol1?.title || it.seriesKey;
    const author = it.author || "";
    const img = it.vol1?.image || "";
    const vol1Amz = it.vol1?.amazonDp || "#";
    const isbn = it.vol1?.isbn13 || "";

    return `
      <article class="card">
        <div class="card-row">
          <div class="thumb">
            ${img ? `<a href="${esc(vol1Amz)}" target="_blank" rel="nofollow noopener"><img src="${esc(img)}" alt="${esc(title)}"/></a>` : `<div class="thumb-ph"></div>`}
          </div>
          <div class="meta">
            <div class="title"><a href="./work.html?key=${key}">${esc(it.seriesKey)}</a></div>
            <div class="sub">
              ${author ? `<span>${esc(author)}</span>` : ""}
              ${isbn ? `<span> / ISBN: ${esc(isbn)}</span>` : ""}
            </div>
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

  const title = it.vol1?.title || it.seriesKey;
  const author = it.author || "";
  const img = it.vol1?.image || "";
  const vol1Amz = it.vol1?.amazonDp || "";
  const isbn = it.vol1?.isbn13 || "";

  detail.innerHTML = `
    <div class="d-title">${esc(it.seriesKey)}</div>
    <div class="d-sub">${esc(author)} ${isbn ? " / ISBN: " + esc(isbn) : ""}</div>
    <div class="d-row">
      ${img ? `<img class="d-img" src="${esc(img)}" alt="${esc(title)}"/>` : ""}
      <div class="d-links">
        ${vol1Amz ? `<a class="btn" href="${esc(vol1Amz)}" target="_blank" rel="nofollow noopener">Amazon（1巻）</a>` : ""}
      </div>
    </div>
  `;
}

(async function main() {
  try {
    const data = await loadJson("./data/lane2/series.json");
    renderList(data);
    renderWork(data);
  } catch (e) {
    const s = document.getElementById("status");
    if (s) s.textContent = "読み込みに失敗しました";
    console.error(e);
  }
})();
