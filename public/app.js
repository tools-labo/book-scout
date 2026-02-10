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

/**
 * works.json の項目が string / object / array どれでも来うる前提で
 * 表示用の「人間が読める文字列」へ正規化する。
 *
 * 例:
 * - "講談社" -> "講談社"
 * - { name:"講談社" } -> "講談社"
 * - { ja:"講談社" } -> "講談社"
 * - { publisher:"講談社" } -> "講談社"
 * - ["講談社","集英社"] -> "講談社 / 集英社"
 */
function toText(v) {
  if (v == null) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" || typeof v === "boolean") return String(v);

  if (Array.isArray(v)) {
    const xs = v.map(toText).filter(Boolean);
    // 重複排除（順序は維持）
    const seen = new Set();
    const uniq = xs.filter(x => (seen.has(x) ? false : (seen.add(x), true)));
    return uniq.join(" / ");
  }

  if (typeof v === "object") {
    // よくあるキーを優先順で拾う（必要なら増やす）
    const keys = [
      "name",
      "ja",
      "jp",
      "label",
      "value",
      "text",
      "title",
      "publisher",
      "company",
      "display",
    ];
    for (const k of keys) {
      if (v[k] != null) {
        const t = toText(v[k]);
        if (t) return t;
      }
    }
    // それでも取れない場合は空にする（[object Object] を出さない）
    return "";
  }

  return "";
}

const GENRE_JA = {
  Action: "アクション",
  Adventure: "冒険",
  Comedy: "コメディ",
  Drama: "ドラマ",
  Fantasy: "ファンタジー",
  Horror: "ホラー",
  Mystery: "ミステリー",
  Psychological: "心理",
  Romance: "恋愛",
  "Sci-Fi": "SF",
  "Slice of Life": "日常",
  Sports: "スポーツ",
  Supernatural: "超常",
  Thriller: "サスペンス",
};

const TAG_JA = {
  Shounen: "少年",
  Seinen: "青年",
  "Male Protagonist": "男性主人公",
  "Female Protagonist": "女性主人公",
  "Battle Royale": "バトルロイヤル",
  Football: "サッカー",
  Athletics: "競技",
  Magic: "魔法",
  Demons: "悪魔",
  Elf: "エルフ",
  Travel: "旅",
  Tragedy: "悲劇",
  Iyashikei: "癒し",
  Philosophy: "哲学",
  "Time Skip": "時間経過",
  "Primarily Male Cast": "男多め",
  "Primarily Teen Cast": "10代中心",
  "Ensemble Cast": "群像劇",
  "Urban Fantasy": "現代ファンタジー",
  Twins: "双子",
  Youkai: "妖怪",
  Conspiracy: "陰謀",
  Rural: "田舎",
};

function mapGenres(genres) {
  if (!Array.isArray(genres)) return [];
  return genres.map((g) => GENRE_JA[g]).filter(Boolean);
}
function mapTags(tags) {
  if (!Array.isArray(tags)) return [];
  return tags.map((t) => TAG_JA[t]).filter(Boolean);
}

function pills(list) {
  if (!list.length) return "";
  return `<div class="pills">${list.map((x) => `<span class="pill">${esc(x)}</span>`).join("")}</div>`;
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
    const title = toText(it.title) || toText(it.seriesKey);
    const author = toText(it.author);
    const img = toText(it.image);
    const amz = toText(it.amazonDp) || "#";

    const release = toText(it.releaseDate);
    const publisher = toText(it.publisher);
    const magazine = toText(it.magazine);

    const genresJa = mapGenres(it.genres);
    const tagsJa = mapTags(it.tags).slice(0, 10);

    const synopsis = toText(it.synopsis);

    const metaParts = [
      author ? esc(author) : null,
      release ? `発売日: ${esc(release)}` : null,
      publisher ? `出版社: ${esc(publisher)}` : null,
      magazine ? `連載誌: ${esc(magazine)}` : null,
    ].filter(Boolean).join(" / ");

    return `
      <article class="card">
        <div class="card-row">
          <div class="thumb">
            ${img ? `<a href="${esc(amz)}" target="_blank" rel="nofollow noopener"><img src="${esc(img)}" alt="${esc(title)}"/></a>` : `<div class="thumb-ph"></div>`}
          </div>
          <div class="meta">
            <div class="title"><a href="./work.html?key=${key}">${esc(title)}</a></div>
            ${metaParts ? `<div class="sub">${metaParts}</div>` : ""}

            ${genresJa.length ? `<div class="sub">ジャンル: ${esc(genresJa.join(" / "))}</div>` : ""}
            ${tagsJa.length ? `<div class="sub">タグ:</div>${pills(tagsJa)}` : ""}

            ${synopsis ? `
              <details class="syn">
                <summary>あらすじ</summary>
                <div class="syn-body">${esc(synopsis)}</div>
              </details>
            ` : ""}
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

  const title = toText(it.title) || toText(it.seriesKey);
  const author = toText(it.author);
  const img = toText(it.image);
  const amz = toText(it.amazonDp);

  const release = toText(it.releaseDate);
  const publisher = toText(it.publisher);
  const magazine = toText(it.magazine);

  const genresJa = mapGenres(it.genres);
  const tagsJa = mapTags(it.tags);

  const synopsis = toText(it.synopsis);

  const metaParts = [
    author ? esc(author) : null,
    release ? `発売日: ${esc(release)}` : null,
    publisher ? `出版社: ${esc(publisher)}` : null,
    magazine ? `連載誌: ${esc(magazine)}` : null,
  ].filter(Boolean).join(" / ");

  detail.innerHTML = `
    <div class="d-title">${esc(title)}</div>
    ${metaParts ? `<div class="d-sub">${metaParts}</div>` : ""}

    <div class="d-row">
      ${img ? `<img class="d-img" src="${esc(img)}" alt="${esc(title)}"/>` : ""}
      <div class="d-links">
        ${amz ? `<a class="btn" href="${esc(amz)}" target="_blank" rel="nofollow noopener">Amazon（1巻）</a>` : ""}
      </div>
    </div>

    ${genresJa.length ? `<div class="d-sub" style="margin-top:12px;">ジャンル: ${esc(genresJa.join(" / "))}</div>` : ""}
    ${tagsJa.length ? `<div class="d-sub" style="margin-top:8px;">タグ:</div>${pills(tagsJa)}` : ""}

    ${synopsis ? `
      <div class="d-sub" style="margin-top:14px;">あらすじ</div>
      <div class="d-text">${esc(synopsis)}</div>
    ` : ""}
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
