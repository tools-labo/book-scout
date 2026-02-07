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

// 改行を <br> にしたいので、escapeした後で \n を <br> に変換する
function escWithBr(s) {
  return esc(s).replaceAll("\n", "<br>");
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

function normKey(s) {
  return String(s ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .replaceAll("　", " ");
}

function pickKeyCandidates(it) {
  const cands = [
    it?.seriesKey,
    it?.workKey,
    it?.work?.key,
    it?.series?.key,
    it?.title,
    it?.latest?.title,
  ]
    .filter(Boolean)
    .map((x) => normKey(x));

  // decodeURIComponent っぽいものも候補に入れる（失敗しても無視）
  const decoded = [];
  for (const k of cands) {
    try {
      const d = normKey(decodeURIComponent(k));
      if (d && d !== k) decoded.push(d);
    } catch {}
  }

  return Array.from(new Set([...cands, ...decoded])).filter(Boolean);
}

// list_items.json に足りない synopsis/image を works.json から補完する
function mergeWorksIntoListItems(listItems, worksObj) {
  if (!Array.isArray(listItems) || !worksObj || typeof worksObj !== "object") return listItems;

  const wmap = worksObj; // works.json は { [workKey]: {...} } 想定

  let mergedDesc = 0;
  let mergedImg = 0;
  let miss = 0;

  const out = listItems.map((it) => {
    const candidates = pickKeyCandidates(it);

    let w = null;
    for (const k of candidates) {
      if (wmap[k]) {
        w = wmap[k];
        break;
      }
    }
    if (!w) {
      miss++;
      return it;
    }

    const curDesc = it?.vol1?.description;
    const curDescOk = typeof curDesc === "string" ? curDesc.trim().length > 0 : !!curDesc;

    // works.json の description はトップレベル想定（あなたの貼った通り）
    const wDesc = (typeof w.description === "string" && w.description.trim())
      ? w.description
      : null;

    const nextDesc = curDescOk ? curDesc : wDesc;

    const curImg = it?.vol1?.image;
    const wImg = w.image || null;
    const nextImg = curImg || wImg;

    const curVol1Amz = it?.vol1?.amazonDp;
    const wAmz = w.amazonUrl || null;
    const nextVol1Amz = curVol1Amz || wAmz;

    if (!curDescOk && wDesc) mergedDesc++;
    if (!curImg && wImg) mergedImg++;

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

  console.log("[mergeWorksIntoListItems] items=", listItems.length, "miss=", miss, "descMerged=", mergedDesc, "imgMerged=", mergedImg);
  return out;
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

              <!-- 改行対応 -->
              <div class="synopsis">${escWithBr(synopsis)}</div>

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

    <div class="d-synopsis">${escWithBr(synopsis)}</div>
  `;
}

(async function main() {
  try {
    const cat = qs().get("cat") || "manga";

    let items = await loadJson(`./data/${cat}/list_items.json`);

    try {
      const worksObj = await loadJson(`./data/${cat}/works.json`);
      items = mergeWorksIntoListItems(items, worksObj);
    } catch (e) {
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
