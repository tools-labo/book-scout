// public/app.js
async function loadJson(path) {
  const r = await fetch(path, { cache: "no-store" });
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${path}`);
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

function hasJapaneseChars(text) {
  // ひらがな/カタカナ/漢字が1文字でもあれば日本語扱い
  return /[ぁ-んァ-ン一-龯]/.test(String(text || ""));
}

function pickSynopsis(it, work) {
  // 表示優先：
  // 1) list_items の vol1.description
  // 2) works.json 側の vol1.description（build_work_pages で反映されたやつ）
  // 3) 準備中
  const s1 = it?.vol1?.description ?? null;
  const s2 = work?.vol1?.description ?? null;

  const s = (s1 && String(s1).trim()) || (s2 && String(s2).trim()) || "";
  if (!s) return "（あらすじ準備中）";

  // 英語しか無い場合は出したくない
  if (!hasJapaneseChars(s)) return "（あらすじ準備中）";

  return s;
}

function tagChips(tagsObj) {
  const out = [];
  for (const k of ["demo", "genre", "publisher"]) {
    const arr = tagsObj?.[k] || [];
    for (const v of arr) out.push(`<span class="chip">${esc(v)}</span>`);
  }
  return out.join("");
}

function renderList(items, worksByKey) {
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
      const img = it.vol1?.image || "";

      const latestAmz = it.latest?.amazonDp || "";
      const vol1Amz = it.vol1?.amazonDp || "";

      const work = worksByKey?.get?.(it.seriesKey) || null;
      const synopsis = pickSynopsis(it, work);

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

function renderWork(items, worksByKey) {
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

  const work = worksByKey?.get?.(it.seriesKey) || null;
  const synopsis = pickSynopsis(it, work);

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

    // list_items は現状のUIが使ってる基盤
    const items = await loadJson(`./data/${cat}/list_items.json`);

    // works.json は synopsisApplied されたあらすじが入ってる
    const worksObj = await loadJson(`./data/${cat}/works.json`);
    const worksByKey = new Map(Object.entries(worksObj || {})); // [seriesKey] -> work

    renderList(items, worksByKey);
    renderWork(items, worksByKey);

  } catch (e) {
    const status = document.getElementById("status");
    if (status) status.textContent = "読み込みに失敗しました";
    console.error(e);
  }
})();
