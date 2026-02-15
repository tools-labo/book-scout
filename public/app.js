// public/app.js  (FULL REPLACE)

function qs() { return new URLSearchParams(location.search); }

async function loadJson(url, { bust = false } = {}) {
  const r = await fetch(url, { cache: bust ? "no-store" : "default" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return await r.json();
}

function esc(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function toText(v) {
  if (v == null) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" || typeof v === "boolean") return String(v);

  if (Array.isArray(v)) {
    const xs = v.map(toText).filter(Boolean);
    const seen = new Set();
    const uniq = xs.filter(x => (seen.has(x) ? false : (seen.add(x), true)));
    return uniq.join(" / ");
  }

  if (typeof v === "object") {
    const keys = ["name","ja","jp","label","value","text","title","publisher","company","display","brand","manufacturer"];
    for (const k of keys) {
      if (v[k] != null) {
        const t = toText(v[k]);
        if (t) return t;
      }
    }
    return "";
  }
  return "";
}

// works.json が「フラット形式」でも「vol1ネスト形式」でも読めるようにする
function pick(it, keys) {
  for (const k of keys) {
    const v = k.includes(".")
      ? k.split(".").reduce((o, kk) => (o ? o[kk] : undefined), it)
      : it?.[k];
    if (Array.isArray(v)) return v;
    if (toText(v)) return v;
  }
  return null;
}
function pickArr(it, keys) {
  for (const k of keys) {
    const v = k.includes(".")
      ? k.split(".").reduce((o, kk) => (o ? o[kk] : undefined), it)
      : it?.[k];
    if (Array.isArray(v) && v.length) return v;
  }
  return [];
}

function setStatus(msg) {
  const s = document.getElementById("status");
  if (s) { s.textContent = msg; return; }

  const d = document.getElementById("detail");
  if (d) { d.innerHTML = `<div class="status">${esc(msg)}</div>`; return; }
  const l = document.getElementById("list");
  if (l) { l.innerHTML = `<div class="status">${esc(msg)}</div>`; return; }
}

/* =======================
 * ★再発防止：表示用の正規化
 * ======================= */

// 発売日：ISOでも何でも "YYYY-MM-DD" を優先表示（末尾のT...Zを出さない）
function formatReleaseDate(raw) {
  const s = toText(raw);
  if (!s) return "";
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : s;
}

// tags: 配列でも文字列でも拾う（"A / B" でも表示できる）
function normalizeTagList(raw) {
  if (raw == null) return [];
  if (Array.isArray(raw)) {
    return raw.map(toText).filter(Boolean);
  }
  if (typeof raw === "string") {
    const s = raw.trim();
    if (!s) return [];
    // "A / B" や "A,B" などを吸収
    const parts = s.split(/\s*\/\s*|\s*,\s*/g).map(x => x.trim()).filter(Boolean);
    return parts.length ? parts : [s];
  }
  // object などは toText で拾って1要素扱い
  const t = toText(raw);
  return t ? [t] : [];
}

// 重複除去
function uniqStr(list) {
  const seen = new Set();
  const out = [];
  for (const x of list || []) {
    const s = toText(x);
    if (!s) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function getTagsForView(it) {
  // まず配列を優先
  const arr = pickArr(it, ["tags", "vol1.tags"]);
  if (arr.length) return uniqStr(arr.map(toText).filter(Boolean));

  // 次に文字列/その他を拾う
  const raw = pick(it, ["tags", "vol1.tags"]);
  return uniqStr(normalizeTagList(raw));
}

/* =======================
 * Genre map (EN -> JA)
 * ======================= */
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

function mapGenres(genres) {
  if (!Array.isArray(genres)) return [];
  return genres
    .map((g) => {
      const s = toText(g);
      if (!s) return null;
      if (GENRE_JA[s] == null && /[ぁ-んァ-ヶ一-龠]/.test(s)) return s; // 日本語はそのまま
      return GENRE_JA[s] || null; // 辞書外英語は非表示
    })
    .filter(Boolean);
}

function pills(list) {
  if (!list?.length) return "";
  return `<div class="pills">${list.map((x) => `<span class="pill">${esc(x)}</span>`).join("")}</div>`;
}

/* =======================
 * ジャンル棚（確定10本）
 * ★コメディ棚は作らない
 * ★恋愛・ラブコメに Comedy を混ぜない（Romanceのみ）
 * ======================= */
const GENRE_SHELVES = [
  { id: "action", label: "アクション・バトル", match: ["Action"] },
  { id: "fantasy", label: "ファンタジー・異世界", match: ["Fantasy"] },
  { id: "sf", label: "SF", match: ["Sci-Fi"] },
  { id: "horror", label: "ホラー", match: ["Horror"] },
  { id: "mystery", label: "ミステリー・サスペンス", match: ["Mystery", "Thriller"] },
  { id: "romance", label: "恋愛・ラブコメ", match: ["Romance"] },
  { id: "slice", label: "日常", match: ["Slice of Life"] },
  { id: "sports", label: "スポーツ", match: ["Sports"] },
  { id: "drama", label: "ヒューマンドラマ", match: ["Drama"] },
  { id: "other", label: "その他", match: ["Adventure", "Psychological", "Supernatural"] },
];

function hasAnyGenre(it, wanted) {
  const g = pickArr(it, ["genres", "vol1.genres"]).map(toText).filter(Boolean);
  return wanted.some(x => g.includes(x));
}

// genre=Action,Thriller の複数指定を許可
function parseGenreQuery() {
  const raw = toText(qs().get("genre"));
  if (!raw) return [];
  return raw.split(",").map(s => s.trim()).filter(Boolean);
}

function renderGenreBanner(wanted) {
  const s = document.getElementById("status");
  if (!s) return;
  if (!wanted.length) { s.textContent = ""; return; }
  const ja = wanted.map((g) => GENRE_JA[g] || g).join(" / ");
  s.innerHTML = `ジャンル絞り込み：<b>${esc(ja)}</b>`;
}

/* =======================
 * index.html shelves
 * - 2ジャンル横並びは CSS の .shelf-grid が担当
 * - 「一覧を見る」は見出し/文言の2箇所とも list へリンク
 * ======================= */
function renderShelves(data) {
  const root = document.getElementById("shelves");
  if (!root) return;

  const items = Array.isArray(data?.items) ? data.items : [];
  if (!items.length) { root.innerHTML = ""; return; }

  const v = qs().get("v");
  const vq = v ? `&v=${encodeURIComponent(v)}` : "";

  const shelvesHtml = GENRE_SHELVES.map((sh) => {
    const picked = items
      .filter((it) => hasAnyGenre(it, sh.match))
      .slice(0, 12);

    if (!picked.length) return "";

    const jump = `./list.html?genre=${encodeURIComponent(sh.match.join(","))}${vq}`;

    const cards = picked.map((it) => {
      const seriesKey = toText(pick(it, ["seriesKey"])) || "";
      const title = toText(pick(it, ["title", "vol1.title"])) || seriesKey || "(無題)";
      const img = toText(pick(it, ["image", "vol1.image"])) || "";
      const key = encodeURIComponent(seriesKey);

      return `
        <a class="shelf-card" href="./work.html?key=${key}${v ? `&v=${encodeURIComponent(v)}` : ""}">
          <div class="shelf-thumb">
            ${img ? `<img src="${esc(img)}" alt="${esc(title)}">` : `<div class="thumb-ph"></div>`}
          </div>
          <div class="shelf-title">${esc(seriesKey || title)}</div>
        </a>
      `;
    }).join("");

    return `
      <section class="shelf">
        <div class="shelf-head">
          <a href="${jump}" aria-label="${esc(sh.label)} 一覧を見る">
            <h2 class="shelf-h">${esc(sh.label)}</h2>
          </a>
          <a class="shelf-link" href="${jump}" aria-label="${esc(sh.label)} 一覧を見る">一覧を見る</a>
        </div>
        <div class="shelf-row">${cards}</div>
      </section>
    `;
  }).join("");

  root.innerHTML = `
    <div class="home-h2">ジャンル</div>
    <p class="home-desc">まずは気分で選ぶ。タップで絞り込み一覧へ。</p>
    <div class="shelf-grid">
      ${shelvesHtml}
    </div>
  `;
}

/* =======================
 * list.html
 * ======================= */
function renderList(data) {
  const root = document.getElementById("list");
  if (!root) return;

  const all = Array.isArray(data?.items) ? data.items : [];
  const wanted = parseGenreQuery();
  const items = wanted.length ? all.filter((it) => hasAnyGenre(it, wanted)) : all;

  renderGenreBanner(wanted);

  if (!items.length) {
    root.innerHTML = `<div class="status">表示できる作品がありません</div>`;
    return;
  }

  root.innerHTML = items.map((it) => {
    const seriesKey = toText(pick(it, ["seriesKey"])) || "";
    const key = encodeURIComponent(seriesKey);

    const title = toText(pick(it, ["title", "vol1.title"])) || seriesKey || "(無題)";
    const author = toText(pick(it, ["author", "vol1.author"])) || "";

    const img = toText(pick(it, ["image", "vol1.image"])) || "";
    const amz = toText(pick(it, ["amazonDp", "vol1.amazonDp", "amazonUrl", "vol1.amazonUrl"])) || "#";

    // ★発売日：必ず整形して表示
    const releaseRaw = pick(it, ["releaseDate", "vol1.releaseDate"]);
    const release = formatReleaseDate(releaseRaw);

    const publisher = toText(pick(it, ["publisher", "vol1.publisher"])) || "";
    const magazine = toText(pick(it, ["magazine", "vol1.magazine"])) || "";

    const genresJa = mapGenres(pickArr(it, ["genres", "vol1.genres"]));

    // ★タグ：配列でも文字列でも表示できる
    const tagsJa = getTagsForView(it).slice(0, 10);

    const synopsis = toText(pick(it, ["synopsis", "vol1.synopsis"])) || "";

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
            <div class="title"><a href="./work.html?key=${key}">${esc(seriesKey || title)}</a></div>
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

/* =======================
 * work.html
 * ======================= */
function renderWork(data) {
  const detail = document.getElementById("detail");
  if (!detail) return;

  const key = qs().get("key");
  if (!key) { detail.innerHTML = `<div class="d-title">作品キーがありません</div>`; return; }

  const items = Array.isArray(data?.items) ? data.items : [];
  const it = items.find((x) => toText(pick(x, ["seriesKey"])) === key);
  if (!it) { detail.innerHTML = `<div class="d-title">見つかりませんでした</div>`; return; }

  const seriesKey = toText(pick(it, ["seriesKey"])) || "";
  const title = toText(pick(it, ["title", "vol1.title"])) || seriesKey || "(無題)";
  const author = toText(pick(it, ["author", "vol1.author"])) || "";

  const img = toText(pick(it, ["image", "vol1.image"])) || "";
  const amz = toText(pick(it, ["amazonDp", "vol1.amazonDp", "amazonUrl", "vol1.amazonUrl"])) || "";

  // ★発売日：必ず整形して表示
  const releaseRaw = pick(it, ["releaseDate", "vol1.releaseDate"]);
  const release = formatReleaseDate(releaseRaw);

  const publisher = toText(pick(it, ["publisher", "vol1.publisher"])) || "";
  const magazine = toText(pick(it, ["magazine", "vol1.magazine"])) || "";

  const genresJa = mapGenres(pickArr(it, ["genres", "vol1.genres"]));

  // ★タグ：配列でも文字列でも表示できる
  const tagsJa = getTagsForView(it);

  const synopsis = toText(pick(it, ["synopsis", "vol1.synopsis"])) || "";

  const metaParts = [
    author ? esc(author) : null,
    release ? `発売日: ${esc(release)}` : null,
    publisher ? `出版社: ${esc(publisher)}` : null,
    magazine ? `連載誌: ${esc(magazine)}` : null,
  ].filter(Boolean).join(" / ");

  detail.innerHTML = `
    <div class="d-title">${esc(seriesKey || title)}</div>
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

async function run() {
  try {
    const v = qs().get("v");
    const url = v ? `./data/lane2/works.json?v=${encodeURIComponent(v)}` : "./data/lane2/works.json";
    const data = await loadJson(url, { bust: !!v });

    renderShelves(data);
    renderList(data);
    renderWork(data);
  } catch (e) {
    setStatus("読み込みに失敗しました");
    console.error(e);
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", run, { once: true });
} else {
  run();
}
