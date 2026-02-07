// public/app.js
async function loadJson(path) {
  const r = await fetch(path, { cache: "no-store" });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${path}`);
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
  return text || "（あらすじ準備中）";
}

function tagChips(tagsObj) {
  const out = [];
  for (const k of ["demo", "genre", "publisher"]) {
    const arr = tagsObj?.[k] || [];
    for (const v of arr) out.push(`<span class="chip">${esc(v)}</span>`);
  }
  return out.join("");
}

// list_items.json に足りない synopsis/image を works.json から補完する
function mergeWorksIntoListItems(listItems, worksObj) {
  if (!Array.isArray(listItems) || !worksObj || typeof worksObj !== "object") return listItems;

  // works.json は { [workKey]: {workKey,title,description,image,amazonUrl,...} } 想定
  const wmap = worksObj;

  return listItems.map((it) => {
    const key =
      it?.seriesKey ||
      it?.workKey ||
      it?.title ||
      it?.latest?.title ||
      "";

    const w = wmap[key];
    if (!w) return it;

    // vol1.description が無い/空の時だけ works.json の description を使う
    const curDesc = it?.vol1?.description;
    const nextDesc = (typeof curDesc === "string" && curDesc.trim()) ? curDesc : (w.description || null);

    const curImg = it?.vol1?.image;
    const nextImg = curImg || w.image || null;

    // Amazonリンクも一応補完（vol1/latest が無い場合の保険）
    const curVol1Amz = it?.vol1?.amazonDp;
    const nextVol1Amz = curVol1Amz || w.amazonUrl || null;

    return {
      ...it,
      vol1: {
        ...(it.vol1 || {}),
        description: nextDesc,
        image: nextImg,
        amazonDp: nextVol1Amz,
      },
    };
  });
}

function renderList(items) {
  const root = document.getElementById("list");
  if (!root) return;

  root.innerHTML = items
    .map((it) => {
      const key = encodeURIComponent(it.seriesKey);
      const title = it.title || it.seriesKey;
      const author = it.author || "";
      const publisher = it.publisher || "";
      const date = it.latest?.publishedAt || "";
      const vol = it.latest?.volume ?? "";

      // ここは vol1 優先。mergeWorksIntoListItems で vol1.description に入る想定
      const img = it.vol1?.image || "";
      const latestAmz = it.latest?.amazonDp || "";
      const vol1Amz = it.vol1?.amazonDp || "";
      const synopsis = clamp3Lines(it.vol1?.description);

      return `
        <article class="card">
          <div class="card-row">
            <div class="thumb">
              ${
                img
                  ? `<a href="${esc(vol1Amz || latestAmz || "#")}" target="_blank" rel="nofollow noopener"><img src="${esc(img)}" alt="${esc(title)}"/></a>`
                  : `<div class="thumb-ph"></div>`
              }
            </div>

            <div class="meta">
              <div class="title">
                <a href="./work.html?cat=manga&key=${key}">${esc(title)}</a>
              </div>
              <div class="sub">
                <span>${esc(author)}</span>
                ${publisher ? `<span> / ${esc(publisher)}</span>` : ""}
              </div>
              <div class="sub">
                <span>発売日: ${esc(date)}</span>
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

              ${
                it.vol1?.needsOverride
                  ? `<div class="note">※あらすじ要補完（override推奨）</div>`
                  : ""
              }
            </div>
          </div>
        </article>
      `;
    })
    .join("");
}

function renderWork(items) {
  const detail = document.getElementById("detail");
  const status = document.getElementById("status");
  if (!detail) return;

  const key = qs().get("key");
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

  const synopsis = it.vol1?.description || "（あらすじ準備中）";
  const img = it.vol1?.image || "";
  const vol1Amz = it.vol1?.amazonDp || "";
  const latestAmz = it.latest?.amazonDp || "";

  detail.innerHTML = `
    <div class="d-title">${esc(title)}</div>
    <div class="d-sub">${esc(author)} ${publisher ? " / " + esc(publisher) : ""}</div>

    <div class="d-row">
      ${img ? `<img class="d-img" src="${esc(img)}" alt="${esc(title)}"/>` : ""}
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
  try {
    const cat = qs().get("cat") || "manga";

    // 1) まず list_items を読む（今のUIの基礎）
    let items = await loadJson(`./data/${cat}/list_items.json`);

    // 2) works.json を読む（Rakuten/OpenBDで取れた description が入ってる）
    //    ※ここが今回の肝。読み込めなければそのまま動く（安全）
    try {
      const worksObj = await loadJson(`./data/${cat}/works.json`);
      items = mergeWorksIntoListItems(items, worksObj);
    } catch (e) {
      // works.json が無い/読めない場合でもUIは動かす
      console.warn("works.json not loaded:", e);
    }

    renderList(items);
    renderWork(items);

  } catch (e) {
    const status = document.getElementById("status");
    if (status) status.textContent = "読み込みに失敗しました";
    console.error(e);
  }
})();
