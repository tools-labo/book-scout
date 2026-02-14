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

// ジャンル英→日
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
 * ジャンル棚（10本）
 * - works.json の genres（英語）だけで判定
 * - 「もっと見る」では match 全体を genre=... で渡す（ズレ防止）
 * ======================= */
const GENRE_SHELVES = [
  { id: "action", label: "アクション・バトル", match: ["Action"] },
  { id: "fantasy", label: "ファンタジー・異世界", match: ["Fantasy"] },
  { id: "sf", label: "SF", match: ["Sci-Fi"] },
  { id: "horror", label: "ホラー", match: ["Horror"] },
  { id: "mystery", label: "ミステリー・サスペンス", match: ["Mystery", "Thriller"] },
  { id: "romance", label: "恋愛・ラブコメ", match: ["Romance", "Comedy"] },
  { id: "comedy", label: "コメディ", match: ["Comedy"] },
  { id: "slice", label: "日常", match: ["Slice of Life"] },
  { id: "sports", label: "スポーツ", match: ["Sports"] },
  { id: "drama", label: "ヒューマンドラマ", match: ["Drama"] },
];

function hasAnyGenre(it, wanted) {
  const g = pickArr(it, ["genres", "vol1.genres"]).map(toText).filter(Boolean);
  return wanted.some(x => g.includes(x));
}

// genre=Action,Comedy みたいな複数指定を許可
function parseGenreQuery() {
  const raw = toText(qs().get("genre"));
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// list向け：上に「絞り込み中」を出す
function renderGenreBanner(wanted) {
  const s = document.getElementById("status");
  if (!s) return;

  if (!wanted.length) {
    s.textContent = "";
    return;
  }

  const ja = wanted.map((g) => GENRE_JA[g] || g).join(" / ");
  s.innerHTML = `ジャンル絞り込み：<b>${esc(ja)}</b>`;
}

function renderShelves(data) {
  const root = document.getElementById("shelves");
  if (!root) return;

  const items = Array.isArray(data?.items) ? data.items : [];
  if (!items.length) { root.innerHTML = ""; return; }

  const v = qs().get("v");
  const vq = v ? `&v=${encodeURIComponent(v)}` : "";

  root.innerHTML = GENRE_SHELVES.map((sh) => {
    const picked = items
      .filter((it) => hasAnyGenre(it, sh.match))
      .slice(0, 12);

    if (!picked.length) return "";

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

    // ★棚の match 全体を渡す（list側で OR フィルタ）
    const jump = `./list.html?genre=${encodeURIComponent(sh.match.join(","))}${vq}`;

    return `
      <section class="shelf">
        <div class="shelf-head">
          <h2 class="shelf-h">${esc(sh.label)}</h2>
          <a class="shelf-more" href="${jump}">もっと見る</a>
        </div>
        <div class="shelf-row">
          ${cards}
        </div>
      </section>
    `;
  }).join("");
}

/* =======================
 * list/work 表示
 * - list.html?genre=Action,Thriller で OR 絞り込み
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

    const release = toText(pick(it, ["releaseDate", "vol1.releaseDate"])) || "";
    const publisher = toText(pick(it, ["publisher", "vol1.publisher"])) || "";
    const magazine = toText(pick(it, ["magazine", "vol1.magazine"])) || "";

    const genresJa = mapGenres(pickArr(it, ["genres", "vol1.genres"]));
    const tagsJa = pickArr(it, ["tags", "vol1.tags"]).slice(0, 10).map(toText).filter(Boolean);

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

function renderWork(data) {
  const detail = document.getElementById("detail");
  if (!detail) return;

  const key = qs().get("key");
  if (!key) {
    detail.innerHTML = `<div class="d-title">作品キーがありません</div>`;
    return;
  }

  const items = Array.isArray(data?.items) ? data.items : [];
  const it = items.find((x) => toText(pick(x, ["seriesKey"])) === key);
  if (!it) {
    detail.innerHTML = `<div class="d-title">見つかりませんでした</div>`;
    return;
  }

  const seriesKey = toText(pick(it, ["seriesKey"])) || "";
  const title = toText(pick(it, ["title", "vol1.title"])) || seriesKey || "(無題)";
  const author = toText(pick(it, ["author", "vol1.author"])) || "";

  const img = toText(pick(it, ["image", "vol1.image"])) || "";
  const amz = toText(pick(it, ["amazonDp", "vol1.amazonDp", "amazonUrl", "vol1.amazonUrl"])) || "";

  const release = toText(pick(it, ["releaseDate", "vol1.releaseDate"])) || "";
  const publisher = toText(pick(it, ["publisher", "vol1.publisher"])) || "";
  const magazine = toText(pick(it, ["magazine", "vol1.magazine"])) || "";

  const genresJa = mapGenres(pickArr(it, ["genres", "vol1.genres"]));
  const tagsJa = pickArr(it, ["tags", "vol1.tags"]).map(toText).filter(Boolean);

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
    const url = v
      ? `./data/lane2/works.json?v=${encodeURIComponent(v)}`
      : "./data/lane2/works.json";

    const data = await loadJson(url, { bust: !!v });

    renderShelves(data); // index用（#shelvesが無いページでは何もしない）
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
