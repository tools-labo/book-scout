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
 * 正規化
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
 * Amazon（表示側でアフィ付与）
 * ======================= */
const AMAZON_ASSOCIATE_TAG = "book-scout-22";

function isAmazonJpHost(hostname) {
  const h = String(hostname || "").toLowerCase();
  return h === "amazon.co.jp" || h === "www.amazon.co.jp" || h.endsWith(".amazon.co.jp");
}

function ensureAmazonAffiliate(urlLike) {
  const raw = toText(urlLike);
  if (!raw) return "";
  if (raw === "#") return raw;

  try {
    const u = new URL(raw, location.href);
    if (!isAmazonJpHost(u.hostname)) return raw;
    if (u.searchParams.has("tag")) return u.toString();
    u.searchParams.set("tag", AMAZON_ASSOCIATE_TAG);
    return u.toString();
  } catch {
    return raw;
  }
}

function patchAmazonAnchors(root = document) {
  const as = root?.querySelectorAll?.('a[href]') || [];
  for (const a of as) {
    const href = a.getAttribute("href") || "";
    if (!href) continue;

    const next = ensureAmazonAffiliate(href);
    if (next && next !== href) a.setAttribute("href", next);

    const target = (a.getAttribute("target") || "").toLowerCase();
    if (target === "_blank") {
      const rel = (a.getAttribute("rel") || "").trim();
      const parts = new Set(rel.split(/\s+/g).filter(Boolean));
      parts.add("noopener");
      a.setAttribute("rel", Array.from(parts).join(" "));
    }
  }
}

/* =======================
 * Analytics Engine 送信
 * ======================= */
const WORKER_COLLECT_URL = "https://book-scout-events.dx7qqdcchs.workers.dev/collect";

async function sendEvent({ type, page, seriesKey, mood }) {
  try {
    // GETでもいいけど、URL長くなるのでPOSTに寄せる
    await fetch(WORKER_COLLECT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, page, seriesKey, mood }),
      keepalive: true,
    });
  } catch {
    // 失敗してもUXを壊さない（ログは捨てる）
  }
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
 * Home：URL state
 * ======================= */
function getHomeState() {
  const p = qs();
  const g = toText(p.get("g")) || "action";
  const a = toText(p.get("a")) || "shonen";
  return { g, a };
}
function setHomeState(next) {
  const p = qs();
  if (next.g != null) p.set("g", String(next.g));
  if (next.a != null) p.set("a", String(next.a));
  const url = `${location.pathname}?${p.toString()}`;
  history.replaceState(null, "", url);
}

/* =======================
 * ジャンル（確定10本）→ タブ
 * ======================= */
const GENRE_TABS = [
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
function parseOneQueryParam(name) {
  const raw = toText(qs().get(name));
  return raw ? raw.trim() : "";
}

/* =======================
 * カテゴリー（旧：読者層）
 * ======================= */
const CATEGORY_TABS = [
  { id: "shonen", value: "少年", label: "少年マンガ" },
  { id: "seinen", value: "青年", label: "青年マンガ" },
  { id: "shojo", value: "少女", label: "少女マンガ" },
  { id: "josei", value: "女性", label: "女性マンガ" },
  { id: "other", value: "その他", label: "その他" },
];

function getFirstAudienceLabel(it) {
  const arr = pickArr(it, ["audiences", "vol1.audiences"]).map(toText).filter(Boolean);
  return arr[0] || "その他";
}
function hasAudience(it, audLabel) {
  if (!audLabel) return true;
  return getFirstAudienceLabel(it) === audLabel;
}

/* =======================
 * 連載誌
 * ======================= */
function hasMagazine(it, mag) {
  if (!mag) return true;
  const ms = pickArr(it, ["magazines", "vol1.magazines"]).map(toText).filter(Boolean);
  const m1 = toText(pick(it, ["magazine", "vol1.magazine"])) || "";
  if (ms.length) return ms.includes(mag);
  return m1.includes(mag);
}

/* =======================
 * 気分（クイックフィルター）
 * ======================= */
const QUICK_FILTERS_PATH = "./data/lane2/quick_filters.json";
const QUICK_MAX = 2;

function parseMoodQuery() {
  const raw = toText(qs().get("mood"));
  if (!raw) return [];
  const ids = raw.split(",").map(s => s.trim()).filter(Boolean);
  return ids.slice(0, QUICK_MAX);
}

function setMoodQuery(ids) {
  const p = qs();
  const clean = (ids || []).map(toText).filter(Boolean).slice(0, QUICK_MAX);
  if (clean.length) p.set("mood", clean.join(","));
  else p.delete("mood");
  const url = `${location.pathname}?${p.toString()}`;
  history.replaceState(null, "", url);
}

function itGenresTags(it) {
  const genres = pickArr(it, ["genres", "vol1.genres"]).map(toText).filter(Boolean);
  const tags = pickArr(it, ["tags", "vol1.tags"]).map(toText).filter(Boolean);
  return { genres, tags };
}

function matchesAny(list, wanted) {
  if (!wanted?.length) return false;
  const set = new Set(list || []);
  return wanted.some(x => set.has(x));
}

function matchesQuickDef(it, def) {
  if (!def) return false;
  const { genres, tags } = itGenresTags(it);

  const anyGenres = (def.matchAny?.genres || []).map(toText).filter(Boolean);
  const anyTags = (def.matchAny?.tags || []).map(toText).filter(Boolean);

  const noneGenres = (def.matchNone?.genres || []).map(toText).filter(Boolean);
  const noneTags = (def.matchNone?.tags || []).map(toText).filter(Boolean);

  if (matchesAny(genres, noneGenres)) return false;
  if (matchesAny(tags, noneTags)) return false;

  const hit = matchesAny(genres, anyGenres) || matchesAny(tags, anyTags);
  return !!hit;
}

function quickCounts(allItems, defs) {
  const map = new Map();
  for (const d of defs) map.set(d.id, 0);
  for (const it of allItems) {
    for (const d of defs) {
      if (matchesQuickDef(it, d)) map.set(d.id, (map.get(d.id) || 0) + 1);
    }
  }
  return map;
}

/* =======================
 * list.html のバナー
 * ======================= */
function renderFilterBanner({ genreWanted, audienceWanted, magazineWanted }) {
  const s = document.getElementById("status");
  if (!s) return;

  const parts = [];
  if (genreWanted?.length) {
    const ja = genreWanted.map((g) => GENRE_JA[g] || g).join(" / ");
    parts.push(`ジャンル: <b>${esc(ja)}</b>`);
  }
  if (audienceWanted) {
    const tab = CATEGORY_TABS.find(x => x.value === audienceWanted);
    const label = tab?.label || audienceWanted;
    parts.push(`カテゴリー: <b>${esc(label)}</b>`);
  }
  if (magazineWanted) parts.push(`連載誌: <b>${esc(magazineWanted)}</b>`);

  if (!parts.length) { s.textContent = ""; return; }
  s.innerHTML = `絞り込み：${parts.join(" / ")}`;
}

/* =======================
 * list.html（気分フィルターAND）
 * ======================= */
function renderList(data, quickDefs) {
  const root = document.getElementById("list");
  if (!root) return;

  const all = Array.isArray(data?.items) ? data.items : [];

  const genreWanted = parseGenreQuery();
  const audienceWanted = parseOneQueryParam("aud");
  const magazineWanted = parseOneQueryParam("mag");

  const moodSelected = parseMoodQuery();
  const moodDefsById = new Map((quickDefs || []).map(d => [d.id, d]));
  const moodActiveDefs = moodSelected.map(id => moodDefsById.get(id)).filter(Boolean);

  const items = all
    .filter((it) => (genreWanted.length ? hasAnyGenre(it, genreWanted) : true))
    .filter((it) => hasAudience(it, audienceWanted))
    .filter((it) => hasMagazine(it, magazineWanted))
    .filter((it) => {
      if (!moodActiveDefs.length) return true;
      return moodActiveDefs.every(def => matchesQuickDef(it, def));
    });

  renderFilterBanner({ genreWanted, audienceWanted, magazineWanted });

  // フィルター操作を送信（1回の操作で1イベント）
  // mood を押したタイミングで送る（下の onToggle 内）
  if (document.getElementById("quickFiltersList")) {
    const defs = Array.isArray(quickDefs) ? quickDefs : [];
    const counts = quickCounts(all, defs);

    const rootUi = document.getElementById("quickFiltersList");
    const selected = new Set(moodSelected);

    rootUi.innerHTML = `
      <div class="pills">
        ${defs.map(d => {
          const isOn = selected.has(d.id);
          const n = counts.get(d.id) || 0;
          return `
            <button
              type="button"
              class="pill"
              data-mood="${esc(d.id)}"
              aria-pressed="${isOn ? "true" : "false"}"
              style="${isOn ? "outline:2px solid currentColor; outline-offset:1px;" : ""}"
            >
              ${esc(d.label)} <span style="opacity:.7;">(${n})</span>
            </button>
          `;
        }).join("")}
      </div>
    `;

    rootUi.onclick = (ev) => {
      const btn = ev.target?.closest?.("button[data-mood]");
      if (!btn) return;
      const id = btn.getAttribute("data-mood") || "";
      if (!id) return;

      const cur = parseMoodQuery();
      const set = new Set(cur);

      if (set.has(id)) set.delete(id);
      else {
        if (set.size >= QUICK_MAX) return;
        set.add(id);
      }

      const next = Array.from(set);
      setMoodQuery(next);

      // list_filter を送る（mood は複数なので join で入れる）
      sendEvent({
        type: "list_filter",
        page: "list",
        seriesKey: "",
        mood: next.join(","),
      });

      renderList(data, quickDefs);
    };
  }

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

    const amzRaw = toText(pick(it, ["amazonDp", "vol1.amazonDp", "amazonUrl", "vol1.amazonUrl"])) || "#";
    const amz = ensureAmazonAffiliate(amzRaw);

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
 * work.html：読み味投票（vote）
 * ======================= */
function renderVoteUI({ quickDefs, seriesKey }) {
  const root = document.getElementById("voteBox");
  if (!root) return;

  const defs = Array.isArray(quickDefs) ? quickDefs : [];
  if (!defs.length || !seriesKey) { root.innerHTML = ""; return; }

  root.innerHTML = `
    <div class="d-sub" style="margin-top:14px;">読み味（投票）</div>
    <div class="pills">
      ${defs.map(d => `
        <button type="button" class="pill" data-vote="${esc(d.id)}">
          ${esc(d.label)}
        </button>
      `).join("")}
    </div>
    <div class="d-sub" id="voteStatus" style="margin-top:8px;"></div>
  `;

  root.onclick = (ev) => {
    const btn = ev.target?.closest?.("button[data-vote]");
    if (!btn) return;
    const mood = btn.getAttribute("data-vote") || "";
    if (!mood) return;

    // 連打対策（同一作品×同一moodは10秒抑止）
    const k = `vote:${seriesKey}:${mood}`;
    const now = Date.now();
    const last = Number(localStorage.getItem(k) || "0");
    if (now - last < 10000) {
      const st = document.getElementById("voteStatus");
      if (st) st.textContent = "投票しました（少し待ってね）";
      return;
    }
    localStorage.setItem(k, String(now));

    sendEvent({ type: "vote", page: "work", seriesKey, mood });

    const st = document.getElementById("voteStatus");
    if (st) st.textContent = `投票: ${mood}`;
  };
}

function renderWork(data, quickDefs) {
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

  const amzRaw = toText(pick(it, ["amazonDp", "vol1.amazonDp", "amazonUrl", "vol1.amazonUrl"])) || "";
  const amz = ensureAmazonAffiliate(amzRaw);

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

    <div id="voteBox"></div>
  `;

  renderVoteUI({ quickDefs, seriesKey });
}

async function run() {
  try {
    const v = qs().get("v");
    const worksUrl = v ? `./data/lane2/works.json?v=${encodeURIComponent(v)}` : "./data/lane2/works.json";
    const quickUrl = v ? `${QUICK_FILTERS_PATH}?v=${encodeURIComponent(v)}` : QUICK_FILTERS_PATH;

    const data = await loadJson(worksUrl, { bust: !!v });
    const quick = await loadJson(quickUrl, { bust: !!v });
    const quickDefs = Array.isArray(quick?.items) ? quick.items : [];

    // list / work
    renderList(data, quickDefs);
    renderWork(data, quickDefs);

    patchAmazonAnchors(document);
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
