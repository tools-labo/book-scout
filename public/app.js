// public/app.js

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
 * 表示前の正規化（再発防止用）
 * ======================= */
function formatYmd(s) {
  const t = toText(s);
  if (!t) return "";
  if (t.length >= 10 && /^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10);
  return t;
}

function normalizeImgUrl(u) {
  const raw = toText(u);
  if (!raw) return "";
  let x = "";
  try { x = encodeURI(raw); } catch { x = raw; }
  x = x.replaceAll("+", "%2B");
  return x;
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
      if (GENRE_JA[s] == null && /[ぁ-んァ-ヶ一-龠]/.test(s)) return s;
      return GENRE_JA[s] || null;
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

function parseGenreQuery() {
  const raw = toText(qs().get("genre"));
  if (!raw) return [];
  return raw.split(",").map(s => s.trim()).filter(Boolean);
}

/* =======================
 * audience / magazine query (list用)
 * ======================= */
function parseOneQueryParam(name) {
  const raw = toText(qs().get(name));
  return raw ? raw.trim() : "";
}

function hasAudience(it, aud) {
  if (!aud) return true;
  const a = pickArr(it, ["audiences", "vol1.audiences"]).map(toText).filter(Boolean);
  return a.includes(aud);
}

function hasMagazine(it, mag) {
  if (!mag) return true;
  const ms = pickArr(it, ["magazines", "vol1.magazines"]).map(toText).filter(Boolean);
  // fallback: magazine 文字列にしか無い作品があっても拾えるようにする
  const m1 = toText(pick(it, ["magazine", "vol1.magazine"]));
  if (ms.length) return ms.includes(mag);
  return m1.includes(mag);
}

function renderFilterBanner({ genreWanted, audienceWanted, magazineWanted }) {
  const s = document.getElementById("status");
  if (!s) return;

  const parts = [];
  if (genreWanted?.length) {
    const ja = genreWanted.map((g) => GENRE_JA[g] || g).join(" / ");
    parts.push(`ジャンル: <b>${esc(ja)}</b>`);
  }
  if (audienceWanted) parts.push(`読者層: <b>${esc(audienceWanted)}</b>`);
  if (magazineWanted) parts.push(`連載誌: <b>${esc(magazineWanted)}</b>`);

  if (!parts.length) { s.textContent = ""; return; }
  s.innerHTML = `絞り込み：${parts.join(" / ")}`;
}

/* =======================
 * index.html ジャンル棚
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
      const imgRaw = toText(pick(it, ["image", "vol1.image"])) || "";
      const img = normalizeImgUrl(imgRaw);
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
    <div class="shelf-grid">
      ${shelvesHtml}
    </div>
  `;
}

/* =======================
 * index.html 読者層→連載誌棚
 * ======================= */
const AUDIENCES = ["少年", "青年", "少女", "女性", "その他"];

function getFirstAudience(it) {
  const arr = pickArr(it, ["audiences", "vol1.audiences"]).map(toText).filter(Boolean);
  // audiences が複数でも、ホームのタブは「最初の1つ」に寄せる（棚の重複爆発を防ぐ）
  return arr[0] || "その他";
}

function getMagazines(it) {
  const ms = pickArr(it, ["magazines", "vol1.magazines"]).map(toText).filter(Boolean);
  if (ms.length) return ms;
  const m1 = toText(pick(it, ["magazine", "vol1.magazine"]));
  return m1 ? [m1] : [];
}

function sortByReleaseDesc(a, b) {
  const da = formatYmd(pick(a, ["releaseDate", "vol1.releaseDate"])) || "";
  const db = formatYmd(pick(b, ["releaseDate", "vol1.releaseDate"])) || "";
  // 文字列比較（YYYY-MM-DD）
  if (da !== db) return db.localeCompare(da);
  const ta = toText(pick(a, ["seriesKey"])) || "";
  const tb = toText(pick(b, ["seriesKey"])) || "";
  return ta.localeCompare(tb);
}

function buildAudienceMagazineIndex(items) {
  // aud -> mag -> items[]
  const map = new Map();
  for (const it of items) {
    const aud = getFirstAudience(it);
    const mags = getMagazines(it);
    if (!map.has(aud)) map.set(aud, new Map());
    const mm = map.get(aud);

    for (const mag of mags) {
      const k = toText(mag);
      if (!k) continue;
      if (!mm.has(k)) mm.set(k, []);
      mm.get(k).push(it);
    }
  }

  // sort inside each magazine
  for (const [aud, mm] of map.entries()) {
    for (const [mag, arr] of mm.entries()) {
      arr.sort(sortByReleaseDesc);
      mm.set(mag, arr);
    }
    map.set(aud, mm);
  }

  return map;
}

function renderAudienceTabs(activeAud) {
  const tabs = document.getElementById("audienceTabs");
  if (!tabs) return;

  const btns = AUDIENCES.map((a) => {
    const isOn = a === activeAud;
    return `<button class="aud-tab ${isOn ? "is-active" : ""}" data-aud="${esc(a)}" type="button">${esc(a)}</button>`;
  }).join("");

  tabs.innerHTML = `<div class="aud-tabrow">${btns}</div>`;
}

function renderAudienceShelvesSection({ data, activeAud }) {
  const root = document.getElementById("audienceShelves");
  const tabs = document.getElementById("audienceTabs");
  if (!root || !tabs) return;

  const items = Array.isArray(data?.items) ? data.items : [];
  if (!items.length) { root.innerHTML = ""; return; }

  const v = qs().get("v");
  const vq = v ? `&v=${encodeURIComponent(v)}` : "";

  const idx = buildAudienceMagazineIndex(items);

  const aud = AUDIENCES.includes(activeAud) ? activeAud : (AUDIENCES.find(a => idx.has(a)) || "その他");
  renderAudienceTabs(aud);

  const mm = idx.get(aud) || new Map();
  // magazines sort: number of items desc
  const magsSorted = Array.from(mm.entries())
    .map(([mag, arr]) => ({ mag, arr, count: arr.length }))
    .sort((a, b) => (b.count - a.count) || a.mag.localeCompare(b.mag))
    .slice(0, 12); // 棚が増えすぎるので上位だけ

  if (!magsSorted.length) {
    root.innerHTML = `<div class="status">この読者層に表示できる連載誌がありません</div>`;
    return;
  }

  const shelvesHtml = magsSorted.map(({ mag, arr }) => {
    const picked = arr.slice(0, 12);

    const jump = `./list.html?aud=${encodeURIComponent(aud)}&mag=${encodeURIComponent(mag)}${vq}`;

    const cards = picked.map((it) => {
      const seriesKey = toText(pick(it, ["seriesKey"])) || "";
      const title = toText(pick(it, ["title", "vol1.title"])) || seriesKey || "(無題)";
      const imgRaw = toText(pick(it, ["image", "vol1.image"])) || "";
      const img = normalizeImgUrl(imgRaw);
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
          <a href="${jump}" aria-label="${esc(aud)} / ${esc(mag)} 一覧を見る">
            <h2 class="shelf-h">${esc(mag)}</h2>
          </a>
          <a class="shelf-link" href="${jump}" aria-label="${esc(aud)} / ${esc(mag)} 一覧を見る">一覧を見る</a>
        </div>
        <div class="shelf-row">${cards}</div>
      </section>
    `;
  }).join("");

  root.innerHTML = `
    <div class="aud-shelfgrid">
      ${shelvesHtml}
    </div>
  `;

  // tab click
  tabs.onclick = (ev) => {
    const btn = ev.target?.closest?.("button[data-aud]");
    if (!btn) return;
    const next = btn.getAttribute("data-aud") || "";
    if (!next || next === aud) return;
    renderAudienceShelvesSection({ data, activeAud: next });
  };
}

/* =======================
 * list.html
 * ======================= */
function renderList(data) {
  const root = document.getElementById("list");
  if (!root) return;

  const all = Array.isArray(data?.items) ? data.items : [];

  const genreWanted = parseGenreQuery();
  const audienceWanted = parseOneQueryParam("aud");
  const magazineWanted = parseOneQueryParam("mag");

  const items = all
    .filter((it) => (genreWanted.length ? hasAnyGenre(it, genreWanted) : true))
    .filter((it) => hasAudience(it, audienceWanted))
    .filter((it) => hasMagazine(it, magazineWanted));

  renderFilterBanner({ genreWanted, audienceWanted, magazineWanted });

  if (!items.length) {
    root.innerHTML = `<div class="status">表示できる作品がありません</div>`;
    return;
  }

  root.innerHTML = items.map((it) => {
    const seriesKey = toText(pick(it, ["seriesKey"])) || "";
    const key = encodeURIComponent(seriesKey);

    const title = toText(pick(it, ["title", "vol1.title"])) || seriesKey || "(無題)";
    const author = toText(pick(it, ["author", "vol1.author"])) || "";

    const imgRaw = toText(pick(it, ["image", "vol1.image"])) || "";
    const img = normalizeImgUrl(imgRaw);

    const amz = toText(pick(it, ["amazonDp", "vol1.amazonDp", "amazonUrl", "vol1.amazonUrl"])) || "#";

    const release = formatYmd(pick(it, ["releaseDate", "vol1.releaseDate"])) || "";
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

  const imgRaw = toText(pick(it, ["image", "vol1.image"])) || "";
  const img = normalizeImgUrl(imgRaw);

  const amz = toText(pick(it, ["amazonDp", "vol1.amazonDp", "amazonUrl", "vol1.amazonUrl"])) || "";

  const release = formatYmd(pick(it, ["releaseDate", "vol1.releaseDate"])) || "";
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
    const url = v ? `./data/lane2/works.json?v=${encodeURIComponent(v)}` : "./data/lane2/works.json";
    const data = await loadJson(url, { bust: !!v });

    renderShelves(data);
    renderAudienceShelvesSection({ data, activeAud: "少年" });

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
