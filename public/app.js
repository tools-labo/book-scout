// public/app.js（全差し替え版）
// - list_items.json を基本に描画
// - vol1.description がプレースホルダ（「（あらすじ準備中）」等）なら works.json の description を採用
// - works.json が無い/読めない場合でも list だけで動く（フェイルセーフ）

async function loadJson(path) {
  const r = await fetch(path, { cache: "no-store" });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${path}`);
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

function isPlaceholderSynopsis(s) {
  const t = String(s ?? "").trim();
  return (
    t === "" ||
    t === "（あらすじ準備中）" ||
    t === "(あらすじ準備中)" ||
    t === "あらすじ準備中"
  );
}

function hasRealSynopsis(s) {
  const t = String(s ?? "").trim();
  return t.length > 0 && !isPlaceholderSynopsis(t);
}

function pickSynopsis(listItem, workObj) {
  const a = listItem?.vol1?.description;
  if (hasRealSynopsis(a)) return a;

  // works.json は root に description を持つ想定（貼ってくれた例）
  const b = workObj?.description;
  if (hasRealSynopsis(b)) return b;

  return "（あらすじ準備中）";
}

function pickImage(listItem, workObj) {
  return listItem?.vol1?.image || workObj?.image || "";
}

function pickVol1Amazon(listItem, workObj) {
  return listItem?.vol1?.amazonDp || workObj?.amazonUrl || "";
}

function pickLatestAmazon(listItem) {
  return listItem?.latest?.amazonDp || "";
}

function tagChips(tagsObj) {
  const out = [];
  for (const k of ["demo", "genre", "publisher"]) {
    const arr = tagsObj?.[k] || [];
    for (const v of arr) out.push(`<span class="chip">${esc(v)}</span>`);
  }
  return out.join("");
}

function buildWorksMap(worksRaw) {
  // works.json: { [workKey]: {...} } 想定
  if (!worksRaw || typeof worksRaw !== "object") return new Map();
  return new Map(Object.entries(worksRaw));
}

function renderList(items, worksMap, cat) {
  const root = document.getElementById("list");
  if (!root) return;

  root.innerHTML = items
    .map((it) => {
      const seriesKey = it.seriesKey;
      const key = encodeURIComponent(seriesKey);
      const workObj = worksMap.get(seriesKey) || null;

      const title = it.title || seriesKey;
      const author = it.author || "";
      const publisher = it.publisher || "";
      const date = it.latest?.publishedAt || "";
      const vol = it.latest?.volume ?? "";

      const img = pickImage(it, workObj);
      const vol1Amz = pickVol1Amazon(it, workObj);
      const latestAmz = pickLatestAmazon(it);
      const synopsis = pickSynopsis(it, workObj);

      return `
        <article class="card">
          <div class="card-row">
            <div class="thumb">
              ${
                img
                  ? `<a href="${esc(vol1Amz || latestAmz || "#")}" target="_blank" rel="nofollow noopener"><img src="${esc(
                      img
                    )}" alt="${esc(title)}"/></a>`
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

function renderWork(items, worksMap, cat) {
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

  const workObj = worksMap.get(it.seriesKey) || null;

  const title = it.title || it.seriesKey;
  const author = it.author || "";
  const publisher = it.publisher || "";
  const synopsis = pickSynopsis(it, workObj);
  const img = pickImage(it, workObj);
  const vol1Amz = pickVol1Amazon(it, workObj);
  const latestAmz = pickLatestAmazon(it);

  const back = document.getElementById("backToList");
  if (back) back.setAttribute("href", `./list.html?cat=${encodeURIComponent(cat)}`);

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
  const status = document.getElementById("status");

  try {
    const cat = qs().get("cat") || "manga";
    const base = `./data/${cat}`;

    // list_items は必須
    const items = await loadJson(`${base}/list_items.json`);

    // works は任意（無くても動く）
    let worksMap = new Map();
    try {
      const works = await loadJson(`${base}/works.json`);
      worksMap = buildWorksMap(works);
    } catch (e) {
      // works.json が無い/読めない場合は list_items だけで描画
      console.warn("works.json load skipped:", e?.message || e);
    }

    renderList(items, worksMap, cat);
    renderWork(items, worksMap, cat);
  } catch (e) {
    if (status) status.textContent = "読み込みに失敗しました";
    console.error(e);
  }
})();
