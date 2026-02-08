// public/app.js
async function loadJson(url) {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
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

function clamp3Lines(text) {
  return text && String(text).trim() ? String(text) : "（あらすじ準備中）";
}

function tagChips(tagsObj) {
  const out = [];
  for (const k of ["demo", "genre", "publisher"]) {
    const arr = tagsObj?.[k] || [];
    for (const v of arr) out.push(`<span class="chip">${esc(v)}</span>`);
  }
  return out.join("");
}

function isVol1Confirmed(it) {
  // “確定したものしか出さない”判定
  const img = it?.vol1?.image;
  const dp = it?.vol1?.amazonDp;
  return Boolean(img && dp);
}

function getCat() {
  return qs().get("cat") || "manga";
}

function getDataUrl(cat) {
  return `./data/${encodeURIComponent(cat)}/list_items.json`;
}

function getOnlyConfirmed() {
  // デフォは 1（確定分のみ表示）
  const v = qs().get("onlyConfirmed");
  if (v == null) return true;
  return v !== "0";
}

function setBackLink(cat) {
  const a = document.getElementById("backToList");
  if (a) a.href = `./list.html?cat=${encodeURIComponent(cat)}`;
}

function renderList(items, cat) {
  const root = document.getElementById("list");
  if (!root) return;

  const onlyConfirmed = getOnlyConfirmed();
  const shown = onlyConfirmed ? items.filter(isVol1Confirmed) : items;

  const hint = document.getElementById("hint");
  if (hint) {
    hint.innerHTML = `
      <div class="hint">
        表示: ${onlyConfirmed ? "1巻確定のみ" : "全件"}　
        <a class="hint-link" href="./list.html?cat=${encodeURIComponent(cat)}&onlyConfirmed=${onlyConfirmed ? "0" : "1"}">
          ${onlyConfirmed ? "全件を表示" : "1巻確定のみ"}
        </a>
      </div>
    `;
  }

  root.innerHTML = shown
    .map((it) => {
      const keyEnc = encodeURIComponent(it.seriesKey);
      const title = it.title || it.seriesKey;

      const author = it.author || "";
      const publisher = it.publisher || "";

      const date = it.latest?.publishedAt || "";
      const vol = it.latest?.volume ?? "";

      const img = it.vol1?.image || "";
      const vol1Amz = it.vol1?.amazonDp || "";
      const latestAmz = it.latest?.amazonDp || "";
      const synopsis = clamp3Lines(it.vol1?.description);

      // 書影リンクは「1巻が確定している時だけ」1巻へ
      const imgHtml = img
        ? vol1Amz
          ? `<a href="${esc(vol1Amz)}" target="_blank" rel="nofollow noopener"><img src="${esc(img)}" alt="${esc(title)}"/></a>`
          : `<img src="${esc(img)}" alt="${esc(title)}"/>`
        : `<div class="thumb-ph"></div>`;

      return `
        <article class="card">
          <div class="card-row">
            <div class="thumb">${imgHtml}</div>

            <div class="meta">
              <div class="title">
                <a href="./work.html?cat=${encodeURIComponent(cat)}&key=${keyEnc}">${esc(title)}</a>
              </div>

              <div class="sub">
                <span>${esc(author)}</span>
                ${publisher ? `<span> / ${esc(publisher)}</span>` : ""}
              </div>

              <div class="sub">
                ${date ? `<span>発売日: ${esc(date)}</span>` : ""}
                ${vol ? `<span> / 最新${esc(vol)}巻</span>` : ""}
              </div>

              <div class="chips">${tagChips(it.tags)}</div>

              <div class="synopsis">${esc(synopsis)}</div>

              <div class="links">
                ${
                  vol1Amz
                    ? `<a class="btn" href="${esc(vol1Amz)}" target="_blank" rel="nofollow noopener">Amazon（1巻）</a>`
                    : ""
                }
                ${
                  latestAmz
                    ? `<a class="btn" href="${esc(latestAmz)}" target="_blank" rel="nofollow noopener">Amazon（最新巻）</a>`
                    : ""
                }
              </div>
            </div>
          </div>
        </article>
      `;
    })
    .join("");

  if (!shown.length) {
    root.innerHTML = `<div class="empty">表示できる作品がありません（1巻確定のみ表示中）。</div>`;
  }
}

function renderWork(items, cat) {
  const detail = document.getElementById("detail");
  const status = document.getElementById("status");
  if (!detail) return;

  setBackLink(cat);

  const keyRaw = qs().get("key");
  const key = keyRaw ? decodeURIComponent(keyRaw) : "";
  if (!key) {
    detail.innerHTML = `<div class="d-title">作品キーがありません</div>`;
    return;
  }

  const it = items.find((x) => x.seriesKey === key);
  if (!it) {
    detail.innerHTML = `<div class="d-title">見つかりませんでした</div>`;
    return;
  }

  if (status) status.textContent = "";

  const title = it.title || it.seriesKey;
  const author = it.author || "";
  const publisher = it.publisher || "";

  const synopsis = clamp3Lines(it.vol1?.description);
  const img = it.vol1?.image || "";

  const vol1Amz = it.vol1?.amazonDp || "";
  const latestAmz = it.latest?.amazonDp || "";

  const imgHtml = img
    ? vol1Amz
      ? `<a href="${esc(vol1Amz)}" target="_blank" rel="nofollow noopener"><img class="d-img" src="${esc(img)}" alt="${esc(title)}"/></a>`
      : `<img class="d-img" src="${esc(img)}" alt="${esc(title)}"/>`
    : "";

  detail.innerHTML = `
    <div class="d-title">${esc(title)}</div>
    <div class="d-sub">${esc(author)} ${publisher ? " / " + esc(publisher) : ""}</div>

    <div class="d-row">
      ${imgHtml}
      <div class="d-links">
        ${vol1Amz ? `<a class="btn" href="${esc(vol1Amz)}" target="_blank" rel="nofollow noopener">Amazon（1巻）</a>` : ""}
        ${latestAmz ? `<a class="btn" href="${esc(latestAmz)}" target="_blank" rel="nofollow noopener">Amazon（最新巻）</a>` : ""}
      </div>
    </div>

    <div class="chips">${tagChips(it.tags)}</div>

    <div class="d-synopsis">${esc(synopsis)}</div>
  `;
}

(async function main() {
  const cat = getCat();
  const url = getDataUrl(cat);

  try {
    const items = await loadJson(url);

    renderList(items, cat);
    renderWork(items, cat);

  } catch (e) {
    const status = document.getElementById("status");
    if (status) {
      status.innerHTML = `
        <div class="status-error">
          読み込みに失敗しました。<br/>
          参照先: <code>${esc(url)}</code><br/>
          <small>※ public/data/${esc(cat)}/list_items.json を配置すると表示されます</small>
        </div>
      `;
    }
    console.error(e);
  }
})();
