// public/app.js（全差し替え：work/works を正にして表示、英語あらすじガード付き）

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

// 日本語（ひら/カタ/漢字）が1文字でも含まれるか
function hasJapanese(text) {
  const s = String(text ?? "");
  return /[ぁ-んァ-ヶ一-龯]/.test(s);
}

function normalizeSynopsis(text) {
  const t = String(text ?? "").trim();
  if (!t) return "（あらすじ準備中）";
  // 英語など（日本語文字ゼロ）は表示しない
  if (!hasJapanese(t)) return "（あらすじ準備中）";
  return t;
}

function tagChips(tagsObj) {
  const out = [];
  for (const k of ["demo", "genre", "publisher"]) {
    const arr = tagsObj?.[k] || [];
    for (const v of arr) out.push(`<span class="chip">${esc(v)}</span>`);
  }
  return out.join("");
}

function renderList(listItems, worksByKey, cat) {
  const root = document.getElementById("list");
  if (!root) return;

  root.innerHTML = listItems
    .map((it) => {
      const keyRaw = it.seriesKey; // list_itemsのキー（workKeyと一致している想定）
      const key = encodeURIComponent(keyRaw);

      // works.json（=work出力の元）から最新のvol1.descriptionを引く
      const w = worksByKey?.get?.(keyRaw) || null;

      const title = it.title || it.seriesKey;
      const author = it.author || "";
      const publisher = it.publisher || "";
      const date = it.latest?.publishedAt || "";
      const vol = it.latest?.volume ?? "";
      const img = it.vol1?.image || "";

      const latestAmz = it.latest?.amazonDp || "";
      const vol1Amz = it.vol1?.amazonDp || "";

      const synopsis = normalizeSynopsis(w?.vol1?.description ?? it.vol1?.description);

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
                <a href="./work.html?cat=${esc(cat)}&key=${key}">${esc(title)}</a>
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
            </div>
          </div>
        </article>
      `;
    })
    .join("");
}

function renderWorkDetail(work, cat) {
  const detail = document.getElementById("detail");
  const status = document.getElementById("status");
  if (!detail) return;

  if (status) status.textContent = "";

  const title = work?.title || work?.seriesKey || "（タイトル不明）";
  const author = work?.author || "";
  const publisher = work?.publisher || "";
  const synopsis = normalizeSynopsis(work?.vol1?.description);
  const img = work?.vol1?.image || "";
  const vol1Amz = work?.vol1?.amazonDp || "";
  const latestAmz = work?.latest?.amazonDp || "";

  // 戻るリンクをcatに合わせる
  const back = document.getElementById("backToList");
  if (back) back.href = `./list.html?cat=${encodeURIComponent(cat)}`;

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

    <div class="chips">${tagChips(work?.tags)}</div>

    <div class="d-synopsis">${esc(synopsis)}</div>
  `;
}

(async function main() {
  try {
    const cat = qs().get("cat") || "manga";

    // list.html 用：並び順は list_items、あらすじは works.json（1回fetchで済む）
    const listPromise = loadJson(`./data/${cat}/list_items.json`);
    const worksPromise = loadJson(`./data/${cat}/works.json`).catch(() => null);

    // work.html 用：keyがあるなら work/<key>.json を優先
    const key = qs().get("key");

    const [listItems, worksObj] = await Promise.all([listPromise, worksPromise]);

    // list_items.json は配列想定（保険）
    const list = Array.isArray(listItems) ? listItems : (listItems?.items || []);

    // works.json → Map(workKey -> workObj)
    const worksByKey = new Map();
    if (worksObj && typeof worksObj === "object") {
      for (const [wk, w] of Object.entries(worksObj)) worksByKey.set(wk, w);
    }

    // list.html は #list がある前提
    renderList(list, worksByKey, cat);

    // work.html は #detail がある前提
    if (key) {
      const workPath = `./data/${cat}/work/${encodeURIComponent(key)}.json`;
      const work = await loadJson(workPath);
      renderWorkDetail(work, cat);
    }
  } catch (e) {
    const status = document.getElementById("status");
    if (status) status.textContent = "読み込みに失敗しました";
    console.error(e);
  }
})();
