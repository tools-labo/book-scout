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

function fmtDate(iso) {
  const s = String(iso ?? "").trim();
  if (!s) return "";
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return s;
  return `${m[1]}/${m[2]}/${m[3]}`;
}

// ★辞書（増やすのはOK、ただし無いものは出さない）
const GENRE_JA = {
  Action: "アクション",
  Adventure: "冒険",
  Comedy: "コメディ",
  Drama: "ドラマ",
  Fantasy: "ファンタジー",
  Romance: "恋愛",
  Sports: "スポーツ",
  Horror: "ホラー",
  Mystery: "ミステリー",
  Psychological: "心理",
  SciFi: "SF",
  "Slice of Life": "日常",
  Supernatural: "超常",
  Thriller: "サスペンス",
  Ecchi: "お色気",
};

const TAG_JA = {
  Football: "サッカー",
  Magic: "魔法",
  Elf: "エルフ",
  Demons: "魔族/悪魔",
  Shounen: "少年",
  "Male Protagonist": "男主人公",
  "Female Protagonist": "女主人公",
  "Battle Royale": "バトルロイヤル",
  "Urban Fantasy": "現代ファンタジー",
  "Time Skip": "時間経過",
  "Primarily Male Cast": "男性多め",
  "Primarily Teen Cast": "10代中心",
  "Ensemble Cast": "群像",
  Tragedy: "悲劇",
  Travel: "旅",
  Philosophy: "哲学",
  "Super Power": "超能力",
  "Anti-Hero": "アンチヒーロー",
  Athletics: "競技",
  Fitness: "フィットネス",
  Youkai: "妖怪",
  Twins: "双子",
  Rural: "田舎",
  Conspiracy: "陰謀",
  Archery: "弓",
  Iyashikei: "癒し系",
  Medieval: "中世",
  Episodic: "短編集/エピソード型",
};

// ★辞書にないものは “捨てる”
function jpizeOnlyKnown(arr, dict) {
  if (!Array.isArray(arr)) return [];
  return arr
    .map((x) => String(x ?? "").trim())
    .filter(Boolean)
    .map((k) => dict[k] || null)
    .filter(Boolean);
}

// ★日本語あらすじは openBD と Wikipedia のみ
function pickJaDescription(vol1) {
  const openbd = String(vol1?.openbdSummary ?? vol1?.summary ?? "").trim();
  if (openbd) return { text: openbd, source: "openbd" };

  const wiki = String(vol1?.wikiSummary ?? "").trim();
  if (wiki) return { text: wiki, source: "wikipedia" };

  return { text: "", source: "" };
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
    const author = it.author || "";
    const img = it.vol1?.image || "";
    const vol1Amz = it.vol1?.amazonDp || "#";
    const isbn = it.vol1?.isbn13 || "";
    const date = fmtDate(it.vol1?.releaseDate);

    const genresJa = jpizeOnlyKnown(it.vol1?.genres, GENRE_JA);

    return `
      <article class="card">
        <div class="card-row">
          <div class="thumb">
            ${
              img
                ? `<a href="${esc(vol1Amz)}" target="_blank" rel="nofollow noopener"><img src="${esc(img)}" alt="${esc(it.seriesKey)}"/></a>`
                : `<div class="thumb-ph"></div>`
            }
          </div>
          <div class="meta">
            <div class="title"><a href="./work.html?key=${key}">${esc(it.seriesKey)}</a></div>
            <div class="sub">
              ${author ? `<span>${esc(author)}</span>` : ""}
              ${isbn ? `<span> / ISBN: ${esc(isbn)}</span>` : ""}
              ${date ? `<span> / 発売: ${esc(date)}</span>` : ""}
              ${genresJa.length ? `<span> / ジャンル: ${esc(genresJa.join(" / "))}</span>` : ""}
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

  const author = it.author || "";
  const img = it.vol1?.image || "";
  const vol1Amz = it.vol1?.amazonDp || "";
  const isbn = it.vol1?.isbn13 || "";
  const date = fmtDate(it.vol1?.releaseDate);
  const pub = it.vol1?.publisher?.manufacturer || it.vol1?.publisher?.brand || "";

  const genresJa = jpizeOnlyKnown(it.vol1?.genres, GENRE_JA);
  const tagsJa = jpizeOnlyKnown(it.vol1?.tags, TAG_JA);

  const desc = pickJaDescription(it.vol1);
  const descLabel =
    desc.source === "openbd" ? "あらすじ（openBD）" :
    desc.source === "wikipedia" ? "概要（Wikipedia）" :
    "";

  detail.innerHTML = `
    <div class="d-title">${esc(it.seriesKey)}</div>
    <div class="d-sub">
      ${author ? esc(author) : ""}
      ${isbn ? " / ISBN: " + esc(isbn) : ""}
      ${date ? " / 発売: " + esc(date) : ""}
      ${pub ? " / 出版社: " + esc(pub) : ""}
    </div>

    <div class="d-row">
      ${img ? `<img class="d-img" src="${esc(img)}" alt="${esc(it.seriesKey)}"/>` : ""}
      <div class="d-links">
        ${vol1Amz ? `<a class="btn" href="${esc(vol1Amz)}" target="_blank" rel="nofollow noopener">Amazon（1巻）</a>` : ""}
      </div>
    </div>

    ${genresJa.length ? `<div class="d-note">ジャンル: ${esc(genresJa.join(" / "))}</div>` : ""}
    ${tagsJa.length ? `<div class="d-note">タグ: ${esc(tagsJa.join(" / "))}</div>` : ""}

    ${
      desc.text
        ? `<div class="d-note"><div style="margin-bottom:6px;">${esc(descLabel)}：</div><div style="white-space:pre-wrap;">${esc(desc.text)}</div></div>`
        : ""
    }
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
