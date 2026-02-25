// public/app.js（1/2）FULL REPLACE
// - works を分割JSON（works/index.json + works/works_*.json）から読む
// - Home：人気ランキング（閲覧数 上位6）
// - Home：ジャンル/カテゴリー棚は「日替わりランダム18件」（作品は表示する）
// - Home：棚の説明テキストは出さない（見出しのみ）
// - ✅ List：author/synopsis を完全に非表示（work詳細は表示）
// - ✅ Home：★おすすめ度/★作画クオリティのランキング棚（要素がある時だけ表示）
// - ✅ Work：平均★（集計JSONがある時だけ表示）
// - ✅ perf: 画像遅延(Observer) / List段階描画 / 重い計算キャッシュ
//
// 【分割ルール】
// - 1/2 はこの END マーカーで必ず終わる
// - 2/2 は START マーカーから必ず始める
// - token が一致しない場合は貼り間違い
// token: A1B2

function qs() { return new URLSearchParams(location.search); }

/* =======================
 * perf: tiny placeholder
 * ======================= */
const IMG_PLACEHOLDER_SRC =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";

/* =======================
 * perf: JSON cache (same session)
 * - bust=true のときはキャッシュしない
 * ======================= */
const __jsonCache = new Map(); // url -> json
async function loadJson(url, { bust = false } = {}) {
  if (!bust && __jsonCache.has(url)) return __jsonCache.get(url);

  const r = await fetch(url, { cache: bust ? "no-store" : "default" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();

  if (!bust) __jsonCache.set(url, j);
  return j;
}
async function tryLoadJson(url, { bust = false } = {}) {
  try { return await loadJson(url, { bust }); } catch { return null; }
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
 * perf: Lazy images (data-src)
 * - src は placeholder のまま
 * - viewport 直前で data-src -> src
 * ======================= */
let __imgObserver = null;

function ensureImgObserver() {
  if (__imgObserver) return __imgObserver;

  if (!("IntersectionObserver" in window)) {
    __imgObserver = {
      observe(el) {
        try {
          const ds = el.getAttribute("data-src") || "";
          if (ds) el.setAttribute("src", ds);
          el.removeAttribute("data-src");
        } catch {}
      },
      unobserve() {},
      disconnect() {},
    };
    return __imgObserver;
  }

  __imgObserver = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const img = e.target;
      try {
        const ds = img.getAttribute("data-src") || "";
        if (ds) img.setAttribute("src", ds);
        img.removeAttribute("data-src");
      } catch {}
      try { __imgObserver.unobserve(img); } catch {}
    }
  }, {
    root: null,
    rootMargin: "200px 0px",
    threshold: 0.01,
  });

  return __imgObserver;
}

function initLazyImages(root = document) {
  const obs = ensureImgObserver();
  const imgs = root?.querySelectorAll?.("img[data-src]") || [];
  for (const img of imgs) {
    try { obs.observe(img); } catch {}
  }
}

/* =======================
 * Analytics
 * ======================= */
const EVENTS_ENDPOINT = "https://book-scout-events.dx7qqdcchs.workers.dev/collect";

// 匿名セッションID（ログイン不要）
// - 端末ごとに固定
// - localStorage が死んでも「無いよりマシ」
const SID_KEY = "sid:v1";
function getSid() {
  try {
    let sid = localStorage.getItem(SID_KEY) || "";
    if (!sid) {
      sid = (crypto?.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now());
      localStorage.setItem(SID_KEY, sid);
    }
    return sid;
  } catch {
    return (crypto?.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now());
  }
}

// ✅ 全イベントを fetch(keepalive) に統一（iOSプライベートの sendBeacon 落ち対策）
function trackEvent({ type, page, seriesKey = "", mood = "", genre = "", aud = "", mag = "", k = "", v = "" }) {
  try {
    const payload = {
      type: String(type || "unknown"),
      page: String(page || ""),
      seriesKey: String(seriesKey || ""),
      mood: String(mood || ""),
      genre: String(genre || ""),
      aud: String(aud || ""),
      mag: String(mag || ""),
      sid: getSid(),
      k: String(k || ""),
      v: String(v || ""),
      ts: Date.now(),
    };

    // ★ rating は doubles に載せたいので数値も明示（互換のため残す）
    if (payload.type === "rate") {
      const r = Number(payload.v || 0);
      payload.rating = Number.isFinite(r) ? r : 0;
    }

    fetch(EVENTS_ENDPOINT, {
      method: "POST",
      mode: "cors",
      keepalive: true,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }).catch(() => {});

    return true;
  } catch {
    return false;
  }
}

/* =======================
 * 多重カウント抑止（端末ローカル）
 * ======================= */
const EVENT_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const EVENT_KEY_PREFIX = "evt:v1:";

function nowMs() { return Date.now(); }

function canSendOnce(key, cooldownMs = EVENT_COOLDOWN_MS) {
  const k = `${EVENT_KEY_PREFIX}${key}`;
  const t = nowMs();
  try {
    const prev = Number(localStorage.getItem(k) || "0");
    if (prev && (t - prev) < cooldownMs) return false;
    localStorage.setItem(k, String(t));
    return true;
  } catch {
    return true;
  }
}

function trackVoteOnce(seriesKey, mood) {
  const sk = toText(seriesKey);
  const md = toText(mood);
  if (!sk || !md) return false;
  const key = `vote:${sk}:${md}`;
  if (!canSendOnce(key)) return false;
  trackEvent({ type: "vote", page: "work", seriesKey: sk, mood: md });
  return true;
}

function trackFavoriteOnce(seriesKey, page) {
  const sk = toText(seriesKey);
  if (!sk) return false;
  const pg = toText(page) || "unknown";
  const key = `favorite:${sk}`;
  if (!canSendOnce(key)) return false;
  trackEvent({ type: "favorite", page: pg, seriesKey: sk, mood: "" });
  return true;
}

function trackWorkViewOnce(seriesKey) {
  const sk = toText(seriesKey);
  if (!sk) return false;

  try {
    const k = `work_view:${sk}`;
    if (sessionStorage.getItem(k) === "1") return false;
    sessionStorage.setItem(k, "1");
  } catch {}

  trackEvent({ type: "work_view", page: "work", seriesKey: sk, mood: "" });
  return true;
}

/* =======================
 * Favorite（端末内だけ保持）
 * ======================= */
function favKey(seriesKey) { return `fav:${toText(seriesKey)}`; }
function isFav(seriesKey) {
  const sk = toText(seriesKey);
  if (!sk) return false;
  try { return localStorage.getItem(favKey(sk)) === "1"; } catch { return false; }
}
function setFav(seriesKey, on) {
  const sk = toText(seriesKey);
  if (!sk) return;
  try {
    if (on) localStorage.setItem(favKey(sk), "1");
    else localStorage.removeItem(favKey(sk));
  } catch {}
}

function favButtonHtml(seriesKey, page) {
  const sk = esc(seriesKey || "");
  const pg = esc(page || "");
  const on = isFav(seriesKey);
  return `
    <button
      type="button"
      class="fav-btn ${on ? "is-on" : ""}"
      data-fav="1"
      data-serieskey="${sk}"
      data-page="${pg}"
      aria-pressed="${on ? "true" : "false"}"
    >
      <span class="fav-icon" aria-hidden="true">${on ? "♥" : "♡"}</span>
      <span class="fav-text">お気に入り</span>
    </button>
  `;
}
function refreshFavButtons(root = document) {
  const btns = root.querySelectorAll?.("button[data-fav='1']") || [];
  for (const btn of btns) {
    const sk = btn.getAttribute("data-serieskey") || "";
    const on = isFav(sk);
    btn.classList.toggle("is-on", on);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    const icon = btn.querySelector?.(".fav-icon");
    if (icon) icon.textContent = on ? "♥" : "♡";
  }
}
function bindFavHandlers(root = document) {
  if (root.__favBound) return;
  root.__favBound = true;

  root.addEventListener("click", (ev) => {
    const btn = ev.target?.closest?.("button[data-fav='1']");
    if (!btn) return;

    const seriesKey = btn.getAttribute("data-serieskey") || "";
    const page = btn.getAttribute("data-page") || "";
    if (!seriesKey) return;

    const currently = isFav(seriesKey);
    const next = !currently;

    setFav(seriesKey, next);
    refreshFavButtons(document);

    // ONにしたときだけ送る
    if (next) void trackFavoriteOnce(seriesKey, page || "unknown");
  }, { passive: true });
}

/* =======================
 * 表示前の正規化
 * ======================= */
function normalizeImgUrl(u) {
  const raw = toText(u);
  if (!raw) return "";
  let x = "";
  try { x = encodeURI(raw); } catch { x = raw; }
  x = x.replaceAll("+", "%2B");
  return x;
}
function formatYmd(s) {
  const t = toText(s);
  if (!t) return "";
  if (t.length >= 10 && /^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10);
  return t;
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
  const as = root?.querySelectorAll?.("a[href]") || [];
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
 * works split paths
 * ======================= */
const WORKS_INDEX_PATH = "./data/lane2/works/index.json";
const WORKS_SHARD_DIR = "./data/lane2/works";
const WORKS_LEGACY_PATH = "./data/lane2/works.json";

/* =======================
 * metrics paths（★集計）
 * ======================= */
const METRIC_RATE_REC_TOP_PATH = "./data/metrics/wae/rate_rec_top.json";
const METRIC_RATE_ART_TOP_PATH = "./data/metrics/wae/rate_art_top.json";
const METRIC_RATE_BY_SERIES_KEY_PATH = "./data/metrics/wae/rate_by_series_key.json";

/* =======================
 * Genre（内部用）
 * ======================= */
function hasAnyGenre(it, wanted) {
  if (!wanted?.length) return true;
  const g = pickArr(it, ["genres", "vol1.genres"]).map(toText).filter(Boolean);
  return wanted.some(x => g.includes(x));
}

/* =======================
 * List：URL絞り込み（内部だけ）
 * ======================= */
function parseGenreQuery() {
  const raw = toText(qs().get("genre"));
  if (!raw) return [];
  return raw.split(",").map(s => s.trim()).filter(Boolean);
}
function parseOneQueryParam(name) {
  const raw = toText(qs().get(name));
  return raw ? raw.trim() : "";
}
function getFirstAudienceLabel(it) {
  const arr = pickArr(it, ["audiences", "vol1.audiences"]).map(toText).filter(Boolean);
  return arr[0] || "その他";
}
function hasAudience(it, audLabel) {
  if (!audLabel) return true;
  return getFirstAudienceLabel(it) === audLabel;
}
function hasMagazine(it, mag) {
  if (!mag) return true;
  const ms = pickArr(it, ["magazines", "vol1.magazines"]).map(toText).filter(Boolean);
  const m1 = toText(pick(it, ["magazine", "vol1.magazine"]));
  if (ms.length) return ms.includes(mag);
  return m1.includes(mag);
}

/* =======================
 * pills
 * ======================= */
// list用：max6
function pillsMax6(list) {
  const xs = (list || []).map(toText).filter(Boolean);
  if (!xs.length) return "";
  const head = xs.slice(0, 6);
  const rest = xs.length - head.length;
  const more = rest > 0 ? `<span class="pill">+${rest}</span>` : "";
  return `<div class="pills">${head.map(x => `<span class="pill">${esc(x)}</span>`).join("")}${more}</div>`;
}
// work用：全件表示
function pillsAll(list) {
  const xs = (list || []).map(toText).filter(Boolean);
  if (!xs.length) return "";
  return `<div class="pills">${xs.map(x => `<span class="pill">${esc(x)}</span>`).join("")}</div>`;
}

/* =======================
 * Quick filters
 * ======================= */
const QUICK_FILTERS_PATH = "./data/lane2/quick_filters.json";
const QUICK_MAX = 2;
const QUICK_MIN_HITS = 2;

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

function itTags(it) {
  const raw = pickArr(it, ["tags", "vol1.tags"]).map(toText).filter(Boolean);
  return Array.from(new Set(raw));
}
function toTagList(arr) {
  const xs = (arr || []).map(toText).filter(Boolean);
  return Array.from(new Set(xs));
}
function countTagHits(tagSet, wantedTags) {
  if (!wantedTags?.length) return 0;
  let n = 0;
  for (const t of wantedTags) if (tagSet.has(t)) n++;
  return n;
}
function quickEval(it, def) {
  if (!def) return { ok: false, hits: 0 };

  const tags = itTags(it);
  const tagSet = new Set(tags);

  const anyTags = toTagList(def.matchAny?.tags || []);
  const noneTags = toTagList(def.matchNone?.tags || []);

  for (const t of noneTags) if (tagSet.has(t)) return { ok: false, hits: 0 };

  const hits = countTagHits(tagSet, anyTags);
  return { ok: hits >= QUICK_MIN_HITS, hits };
}
function quickEvalAll(it, defs) {
  if (!defs?.length) return { ok: true, score: 0 };

  let score = 0;
  for (const def of defs) {
    const r = quickEval(it, def);
    if (!r.ok) return { ok: false, score: 0 };
    score += r.hits;
  }
  return { ok: true, score };
}
function quickCountsDynamic(baseItems, defs, selectedIds) {
  const byId = new Map(defs.map(d => [d.id, d]));
  const sel = (selectedIds || []).filter(Boolean);
  const selDefs = sel.map(id => byId.get(id)).filter(Boolean);

  const counts = new Map(defs.map(d => [d.id, 0]));
  const selectedSet = new Set(sel);

  for (const d of defs) {
    let condDefs = [];
    if (sel.length === 0) condDefs = [d];
    else if (sel.length === 1) condDefs = (selectedSet.has(d.id)) ? selDefs : [selDefs[0], d];
    else condDefs = selDefs;

    let n = 0;
    for (const it of baseItems) if (quickEvalAll(it, condDefs).ok) n++;
    counts.set(d.id, n);
  }

  return { counts };
}

/* =======================
 * Vote selection state (work)
 * ======================= */
const VOTE_MAX = 2;
const VOTE_STATE_PREFIX = "vote_sel:v1:";

function voteStateKey(seriesKey){ return `${VOTE_STATE_PREFIX}${toText(seriesKey)}`; }
function getVotedSet(seriesKey){
  const sk = toText(seriesKey);
  if (!sk) return new Set();
  try{
    const raw = localStorage.getItem(voteStateKey(sk)) || "";
    const ids = raw.split(",").map(s => s.trim()).filter(Boolean);
    return new Set(ids);
  }catch{ return new Set(); }
}
function setVotedSet(seriesKey, set){
  const sk = toText(seriesKey);
  if (!sk) return;
  try{
    const arr = Array.from(set || []).map(toText).filter(Boolean).slice(0, VOTE_MAX);
    localStorage.setItem(voteStateKey(sk), arr.join(","));
  }catch{}
}

/* =======================
 * Home：URL state（タブ）
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
 * Home：ジャンル棚（確定10本）
 * ======================= */
const HOME_GENRE_TABS = [
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

function genreCountMap(allItems) {
  const map = new Map();
  for (const t of HOME_GENRE_TABS) map.set(t.id, 0);
  for (const it of allItems) {
    for (const t of HOME_GENRE_TABS) {
      if (hasAnyGenre(it, t.match)) map.set(t.id, (map.get(t.id) || 0) + 1);
    }
  }
  return map;
}

/* =======================
 * Home：カード列（18件 + もっと見る）
 * ======================= */
function renderCardRow({ items, limit = 18, moreHref = "" }) {
  const v = qs().get("v");
  const cards = (items || []).slice(0, limit).map((it) => {
    const seriesKey = toText(pick(it, ["seriesKey"])) || "";
    const title = toText(pick(it, ["title", "vol1.title"])) || seriesKey || "(無題)";
    const imgRaw = toText(pick(it, ["image", "vol1.image"])) || "";
    const img = normalizeImgUrl(imgRaw);
    const key = encodeURIComponent(seriesKey);

    return `
      <a class="row-card" href="./work.html?key=${key}${v ? `&v=${encodeURIComponent(v)}` : ""}">
        <div class="row-thumb">
          ${
            img
              ? `<img src="${IMG_PLACEHOLDER_SRC}" data-src="${esc(img)}" alt="${esc(title)}" loading="lazy" decoding="async">`
              : `<div class="thumb-ph"></div>`
          }
        </div>
        <div class="row-title">${esc(seriesKey || title)}</div>
      </a>
    `;
  }).join("");

  const moreCard = moreHref
    ? `
      <a class="row-card row-more" href="${esc(moreHref)}" aria-label="もっと見る">
        <div class="row-thumb row-more-thumb">
          <div class="row-more-icon">→</div>
        </div>
        <div class="row-title row-more-title">もっと見る</div>
      </a>
    `
    : "";

  return `<div class="row-scroll">${cards}${moreCard}</div>`;
}

/* --- 日替わりランダム（Home専用）--- */
function daySeedStr() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}
function mulberry32(a) {
  return function() {
    let t = a += 0x6D2B79F5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hash32(str) {
  const s = String(str || "");
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function shuffleWithSeed(arr, seedStr) {
  const a = (arr || []).slice();
  const rnd = mulberry32(hash32(seedStr));
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function setGenreAllLink(activeTab) {
  const a = document.getElementById("genreAllLink");
  if (!a) return;
  const v = qs().get("v");
  const vq = v ? `&v=${encodeURIComponent(v)}` : "";
  const q = encodeURIComponent(activeTab.match.join(","));
  a.href = `./list.html?genre=${q}${vq}`;
}

/* --- Home ジャンル：日替わり18件 --- */
function renderGenreTabsRow({ items, activeId }) {
  const tabs = document.getElementById("genreTabs");
  const row = document.getElementById("genreRow");
  if (!tabs || !row) return;

  const all = Array.isArray(items) ? items : [];
  if (!all.length) { tabs.innerHTML = ""; row.innerHTML = ""; return; }

  const counts = genreCountMap(all);
  const active = HOME_GENRE_TABS.find(x => x.id === activeId) || HOME_GENRE_TABS[0];

  tabs.innerHTML = `
    <div class="tabrow">
      ${HOME_GENRE_TABS.map((t) => `
        <button class="tab ${t.id === active.id ? "is-active" : ""}" data-genre="${esc(t.id)}" type="button">
          <span class="tab-label">${esc(t.label)}</span>
          <span class="badge">${counts.get(t.id) || 0}</span>
        </button>
      `).join("")}
    </div>
  `;

  const pickedAll = all.filter(it => hasAnyGenre(it, active.match));
  const picked = shuffleWithSeed(pickedAll, `genre:${active.id}:${daySeedStr()}`);

  const v = qs().get("v");
  const vq = v ? `&v=${encodeURIComponent(v)}` : "";
  const moreHref = `./list.html?genre=${encodeURIComponent(active.match.join(","))}${vq}`;

  row.innerHTML = renderCardRow({ items: picked, limit: 18, moreHref });
  setGenreAllLink(active);
  initLazyImages(row);

  tabs.onclick = (ev) => {
    const btn = ev.target?.closest?.("button[data-genre]");
    if (!btn) return;
    const next = btn.getAttribute("data-genre") || "";
    if (!next || next === active.id) return;

    setHomeState({ g: next });
    renderGenreTabsRow({ items: all, activeId: next });
  };
}

/* =======================
 * Home：カテゴリー棚
 * ======================= */
const HOME_CATEGORY_TABS = [
  { id: "shonen", value: "少年", label: "少年マンガ" },
  { id: "seinen", value: "青年", label: "青年マンガ" },
  { id: "shojo", value: "少女", label: "少女マンガ" },
  { id: "josei", value: "女性", label: "女性マンガ" },
  { id: "other", value: "その他", label: "その他" },
];

function categoryCountMap(allItems) {
  const map = new Map();
  for (const t of HOME_CATEGORY_TABS) map.set(t.id, 0);
  for (const it of allItems) {
    const label = getFirstAudienceLabel(it);
    const tab = HOME_CATEGORY_TABS.find(x => x.value === label) || HOME_CATEGORY_TABS.find(x => x.id === "other");
    if (!tab) continue;
    map.set(tab.id, (map.get(tab.id) || 0) + 1);
  }
  return map;
}

function setAudienceAllLink(activeAudValue) {
  const a = document.getElementById("audienceAllLink");
  if (!a) return;
  const v = qs().get("v");
  const vq = v ? `&v=${encodeURIComponent(v)}` : "";
  a.href = `./list.html?aud=${encodeURIComponent(activeAudValue)}${vq}`;
}

/* --- Home カテゴリー：日替わり18件 --- */
function renderAudienceTabsRow({ items, activeAudId }) {
  const tabs = document.getElementById("audienceTabs");
  const row = document.getElementById("audienceRow");
  if (!tabs || !row) return;

  const all = Array.isArray(items) ? items : [];
  if (!all.length) { tabs.innerHTML = ""; row.innerHTML = ""; return; }

  const counts = categoryCountMap(all);
  const active = HOME_CATEGORY_TABS.find(x => x.id === activeAudId) || HOME_CATEGORY_TABS[0];
  const audValue = active.value;

  tabs.innerHTML = `
    <div class="tabrow">
      ${HOME_CATEGORY_TABS.map((t) => `
        <button class="tab ${t.id === active.id ? "is-active" : ""}" data-aud="${esc(t.id)}" type="button">
          <span class="tab-label">${esc(t.label)}</span>
          <span class="badge">${counts.get(t.id) || 0}</span>
        </button>
      `).join("")}
    </div>
  `;

  const pickedAll = all.filter(it => getFirstAudienceLabel(it) === audValue);
  const picked = shuffleWithSeed(pickedAll, `aud:${active.id}:${daySeedStr()}`);

  const v = qs().get("v");
  const vq = v ? `&v=${encodeURIComponent(v)}` : "";
  const moreHref = `./list.html?aud=${encodeURIComponent(audValue)}${vq}`;

  row.innerHTML = renderCardRow({ items: picked, limit: 18, moreHref });
  setAudienceAllLink(audValue);
  initLazyImages(row);

  tabs.onclick = (ev) => {
    const btn = ev.target?.closest?.("button[data-aud]");
    if (!btn) return;
    const next = btn.getAttribute("data-aud") || "";
    if (!next || next === active.id) return;

    setHomeState({ a: next });
    renderAudienceTabsRow({ items: all, activeAudId: next });
  };
}

/* =======================
 * Home：読後感（導線リンク）
 * ======================= */
function renderQuickHome({ defs, counts }) {
  const root = document.getElementById("quickFiltersHome");
  if (!root) return;
  if (!defs?.length) { root.innerHTML = ""; return; }

  const v = qs().get("v");
  const vq = v ? `&v=${encodeURIComponent(v)}` : "";

  root.innerHTML = `
    <div class="pills">
      ${defs.map(d => {
        const n = counts.get(d.id) || 0;
        const href = `./list.html?mood=${encodeURIComponent(d.id)}${vq}`;
        return `<a class="pill" href="${esc(href)}" style="text-decoration:none;">
          ${esc(d.label)}
          <span style="opacity:.7;">
            (<span class="qcount-wrap"><span class="qcount">${n}</span></span>)
          </span>
        </a>`;
      }).join("")}
    </div>
  `;
}

/* =======================
 * Home：人気ランキング（閲覧数） - 閲覧数は表示しない
 * ======================= */
function buildViewsMap(rows){
  const map = new Map();
  for (const r of (rows || [])) {
    const sk = toText(r?.seriesKey);
    if (!sk) continue;
    map.set(sk, Number(r?.n || 0));
  }
  return map;
}

function renderHomePopular({ items, viewsMap, limit = 6 }) {
  const root = document.getElementById("homePopular");
  if (!root) return;

  const all = Array.isArray(items) ? items : [];
  if (!all.length || !viewsMap?.size) {
    root.innerHTML = `<div class="status">データがまだありません</div>`;
    return;
  }

  const byKey = new Map();
  for (const it of all) {
    const sk = toText(pick(it, ["seriesKey"]));
    if (sk) byKey.set(sk, it);
  }

  const ranked = Array.from(viewsMap.entries())
    .map(([seriesKey, n]) => ({ seriesKey: toText(seriesKey), n: Number(n || 0) }))
    .filter(x => x.seriesKey && Number.isFinite(x.n) && x.n > 0 && byKey.has(x.seriesKey))
    .sort((a, b) => (b.n - a.n))
    .slice(0, limit);

  if (!ranked.length) {
    root.innerHTML = `<div class="status">データがまだありません</div>`;
    return;
  }

  const v = qs().get("v");
  const vq = v ? `&v=${encodeURIComponent(v)}` : "";

  root.innerHTML = `
    <div class="home-rank-grid">
      ${ranked.map((r, idx) => {
        const it = byKey.get(r.seriesKey);
        const title = toText(pick(it, ["title", "vol1.title"])) || r.seriesKey || "(無題)";
        const imgRaw = toText(pick(it, ["image", "vol1.image"])) || "";
        const img = normalizeImgUrl(imgRaw);
        const key = encodeURIComponent(r.seriesKey);

        return `
          <a class="home-rank-item" href="./work.html?key=${key}${vq}" aria-label="${esc(title)}">
            <div class="home-rank-cover">
              ${
                img
                  ? `<img src="${IMG_PLACEHOLDER_SRC}" data-src="${esc(img)}" alt="${esc(title)}" loading="lazy" decoding="async">`
                  : `<div class="thumb-ph"></div>`
              }
              <div class="home-rank-badge">${idx + 1}位</div>
            </div>
            <div class="home-rank-name">${esc(r.seriesKey || title)}</div>
          </a>
        `;
      }).join("")}
    </div>
  `;

  initLazyImages(root);
}

/* =======================
 * Home：★ランキング（おすすめ度 / 作画）
 * - 要素が無い場合は何もしない
 * - 表示は作品カードのみ（avg/nは今は出さない）
 * ======================= */
function normalizeRateTopRows(json){
  const rows = Array.isArray(json?.rows) ? json.rows
    : Array.isArray(json?.data) ? json.data
    : Array.isArray(json) ? json : [];
  return rows
    .map(r => ({
      seriesKey: toText(r?.seriesKey),
      avg: Number(r?.avg ?? 0),
      n: Number(r?.n ?? 0),
    }))
    .filter(x => x.seriesKey);
}

function renderHomeRateTop({ rootId, titleLabel = "", rows, itemsByKey, limit = 6 }) {
  const root = document.getElementById(rootId);
  if (!root) return;

  const xs = (rows || []).filter(Boolean).slice(0, limit).filter(r => itemsByKey.has(r.seriesKey));
  if (!xs.length) {
    root.innerHTML = `<div class="status">データがまだありません</div>`;
    return;
  }

  const v = qs().get("v");
  const vq = v ? `&v=${encodeURIComponent(v)}` : "";

  root.innerHTML = `
    <div class="home-rank-grid">
      ${xs.map((r, idx) => {
        const it = itemsByKey.get(r.seriesKey);
        const title = toText(pick(it, ["title", "vol1.title"])) || r.seriesKey || "(無題)";
        const imgRaw = toText(pick(it, ["image", "vol1.image"])) || "";
        const img = normalizeImgUrl(imgRaw);
        const key = encodeURIComponent(r.seriesKey);

        return `
          <a class="home-rank-item" href="./work.html?key=${key}${vq}" aria-label="${esc(title)}">
            <div class="home-rank-cover">
              ${
                img
                  ? `<img src="${IMG_PLACEHOLDER_SRC}" data-src="${esc(img)}" alt="${esc(title)}" loading="lazy" decoding="async">`
                  : `<div class="thumb-ph"></div>`
              }
              <div class="home-rank-badge">${idx + 1}位</div>
            </div>
            <div class="home-rank-name">${esc(r.seriesKey || title)}</div>
          </a>
        `;
      }).join("")}
    </div>
  `;

  initLazyImages(root);
}

/* =======================
 * Work：平均★（rate_by_series_key）
 * ======================= */
function buildRateBySeriesKeyMap(json){
  const rows = Array.isArray(json?.rows) ? json.rows
    : Array.isArray(json?.data) ? json.data
    : Array.isArray(json) ? json : [];

  const map = new Map(); // sk -> { rec:{avg,n}, art:{avg,n} }
  for (const r of rows) {
    const sk = toText(r?.seriesKey);
    const k = toText(r?.k);
    const avg = Number(r?.avg ?? 0);
    const n = Number(r?.n ?? 0);
    if (!sk || !k) continue;
    if (!map.has(sk)) map.set(sk, {});
    map.get(sk)[k] = { avg, n };
  }
  return map;
}
function formatStarAvg(v){
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return "";
  return (Math.round(n * 10) / 10).toFixed(1);
}

/* =======================
 * List render（author/synopsis は出さない）
 * - perf: 段階描画
 * ======================= */
function renderList(items, quickDefs) {
  const root = document.getElementById("list");
  if (!root) return;

  const all = Array.isArray(items) ? items : [];

  // 内部絞り込み（表示は増やさない）
  const genreWanted = parseGenreQuery();
  const audienceWanted = parseOneQueryParam("aud");
  const magazineWanted = parseOneQueryParam("mag");

  const moodSelected = parseMoodQuery();
  const byId = new Map((quickDefs || []).map(d => [d.id, d]));
  const moodActiveDefs = moodSelected.map(id => byId.get(id)).filter(Boolean);

  const base = all
    .filter(it => (genreWanted.length ? hasAnyGenre(it, genreWanted) : true))
    .filter(it => hasAudience(it, audienceWanted))
    .filter(it => hasMagazine(it, magazineWanted));

  // ✅ list_filter：同一状態の連打を抑える（5秒）
  function trackListFilterState(nextMoodIds) {
    const g = (genreWanted || []).map(toText).filter(Boolean).join(",");
    const a = toText(audienceWanted);
    const m = toText(magazineWanted);
    const mood = (nextMoodIds || []).map(toText).filter(Boolean).join(",");

    // 既存ログ互換のため mood=... 形式
    const moodVal = mood ? `mood=${mood}` : "";

    const stateKey = `list_filter:${g}|${a}|${m}|${moodVal}`;
    if (!canSendOnce(stateKey, 5000)) return false;

    trackEvent({
      type: "list_filter",
      page: "list",
      seriesKey: "",
      mood: moodVal,
      genre: g ? `genre=${g}` : "",
      aud: a ? `aud=${a}` : "",
      mag: m ? `mag=${m}` : "",
    });
    return true;
  }

  // mood AND + score順
  const scored = [];
  if (moodActiveDefs.length) {
    for (const it of base) {
      const r = quickEvalAll(it, moodActiveDefs);
      if (!r.ok) continue;
      scored.push({ it, score: r.score });
    }
    scored.sort((a, b) => (b.score - a.score));
  } else {
    for (const it of base) scored.push({ it, score: 0 });
  }
  const outItems = scored.map(x => x.it);

  // 解除
  const clear = document.getElementById("moodClearLink");
  if (clear) {
    clear.onclick = (ev) => {
      ev.preventDefault();

      // ✅ クリア状態を送信
      trackListFilterState([]);

      setMoodQuery([]);
      renderList(all, quickDefs);
      refreshFavButtons(document);
    };
  }

  // クイックUI（動的カウント）
  const qRoot = document.getElementById("quickFiltersList");
  if (qRoot) {
    const defs = Array.isArray(quickDefs) ? quickDefs : [];
    const dyn = quickCountsDynamic(base, defs, moodSelected);

    qRoot.innerHTML = `
      <div class="pills">
        ${defs.map(d => {
          const isOn = moodSelected.includes(d.id);
          const isDisabled = (!isOn && moodSelected.length >= QUICK_MAX);
          const n = dyn.counts.get(d.id) || 0;
          return `
            <button
              type="button"
              class="pill ${isOn ? "is-on" : ""}"
              data-mood="${esc(d.id)}"
              aria-pressed="${isOn ? "true" : "false"}"
              ${isDisabled ? "disabled" : ""}
              style="${isDisabled ? "opacity:.5;cursor:not-allowed" : ""}"
            >
              ${esc(d.label)}
              <span style="opacity:.7;">(<span class="qcount-wrap"><span class="qcount">${n}</span></span>)</span>
            </button>
          `;
        }).join("")}
      </div>
    `;

    qRoot.onclick = (ev) => {
      const btn = ev.target?.closest?.("button[data-mood]");
      if (!btn || btn.disabled) return;
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

      // ✅ 状態送信（5秒クールダウン）
      trackListFilterState(next);

      setMoodQuery(next);
      renderList(all, quickDefs);
      refreshFavButtons(document);
    };

    const hint = document.getElementById("quickFiltersHint");
    if (hint) {
      if (!moodSelected.length) hint.textContent = "";
      else hint.innerHTML = `気分: <b>${esc(moodSelected.map(id => byId.get(id)?.label || id).join(" × "))}</b>（AND / 最大2）`;
    }
  }

  if (!outItems.length) {
    root.innerHTML = `<div class="status">表示できる作品がありません</div>`;
    return;
  }

  const v = qs().get("v");
  const vq = v ? `&v=${encodeURIComponent(v)}` : "";

  // perf: 段階描画（初期を軽くする）
  root.innerHTML = "";
  const BATCH = 36;
  let i = 0;

  function itemHtml(it) {
    const seriesKey = toText(pick(it, ["seriesKey"])) || "";
    const key = encodeURIComponent(seriesKey);

    const title = toText(pick(it, ["title", "vol1.title"])) || seriesKey || "(無題)";
    const magazine = toText(pick(it, ["magazine", "vol1.magazine"])) || "";

    const imgRaw = toText(pick(it, ["image", "vol1.image"])) || "";
    const img = normalizeImgUrl(imgRaw);

    const amzRaw = toText(pick(it, ["amazonDp", "vol1.amazonDp", "amazonUrl", "vol1.amazonUrl"])) || "#";
    const amz = ensureAmazonAffiliate(amzRaw);

    const tagsJa = pickArr(it, ["tags", "vol1.tags"]).map(toText).filter(Boolean);

    return `
      <article class="card">
        <div class="card-row">
          <div class="thumb">
            ${
              img
                ? `<a href="./work.html?key=${key}${vq}" aria-label="${esc(title)}"><img src="${IMG_PLACEHOLDER_SRC}" data-src="${esc(img)}" alt="${esc(title)}" loading="lazy" decoding="async"/></a>`
                : `<div class="thumb-ph"></div>`
            }
          </div>

          <div class="meta">
            <div class="title"><a href="./work.html?key=${key}${vq}">${esc(seriesKey || title)}</a></div>

            ${magazine ? `<div class="sub">連載誌: ${esc(magazine)}</div>` : ""}

            ${tagsJa.length ? `<div class="sub">タグ</div>${pillsMax6(tagsJa)}` : ""}

            <div class="actions">
              ${amz && amz !== "#" ? `<a class="amz-mini" href="${esc(amz)}" target="_blank" rel="nofollow noopener">Amazon（1巻）</a>` : ""}
              ${favButtonHtml(seriesKey, "list")}
            </div>
          </div>
        </div>
      </article>
    `;
  }

  function pump() {
    const end = Math.min(outItems.length, i + BATCH);
    let html = "";
    for (; i < end; i++) html += itemHtml(outItems[i]);
    root.insertAdjacentHTML("beforeend", html);

    initLazyImages(root);
    refreshFavButtons(document);

    if (i < outItems.length) {
      requestAnimationFrame(pump);
    }
  }

  requestAnimationFrame(pump);
}

/* END PART 1 - token: A1B2 */

/* START PART 2 - token: A1B2 */

// public/app.js（2/2）FULL REPLACE
// - Work：読後感投票の“報酬”を投票枠内に集約（みんなの読後感 / 同じ読後感の作品）
// - Step A：トーストで即時フィードバック
// - 「マスク解除」文言は撤廃（伝わりにくいので）
// - 解除は最初の1回だけ扱い（2個目投票で“解除”が出ない）

/* =======================
 * Works loader (index/shard)
 * ======================= */
function pad3(n){ return String(n).padStart(3, "0"); }

async function loadWorksIndex({ bust }) {
  const v = qs().get("v");
  const idxUrl = v ? `${WORKS_INDEX_PATH}?v=${encodeURIComponent(v)}` : WORKS_INDEX_PATH;

  const idx = await tryLoadJson(idxUrl, { bust });
  if (idx && Array.isArray(idx.listItems)) {
    return { mode: "split", index: idx, listItems: idx.listItems, legacyItems: null };
  }

  const legacyUrl = v ? `${WORKS_LEGACY_PATH}?v=${encodeURIComponent(v)}` : WORKS_LEGACY_PATH;
  const legacy = await loadJson(legacyUrl, { bust });

  const items = Array.isArray(legacy?.items) ? legacy.items : [];
  const listItems = items.map(it => ({
    seriesKey: it?.seriesKey ?? null,
    title: it?.title ?? null,
    image: it?.image ?? null,
    amazonDp: it?.amazonDp ?? null,
    amazonUrl: it?.amazonUrl ?? null,
    magazine: it?.magazine ?? null,
    magazines: it?.magazines ?? null,
    audiences: it?.audiences ?? null,
    genres: it?.genres ?? null,
    tags: it?.tags ?? null,
    publisher: it?.publisher ?? null,
    releaseDate: it?.releaseDate ?? null,
  }));

  return { mode: "legacy", index: null, listItems, legacyItems: items };
}

async function loadWorkFullByKey({ worksState, key, bust }) {
  const k = toText(key);
  if (!k) return null;

  if (worksState?.mode === "split") {
    const idx = worksState.index;
    const shardIndex = idx?.lookup?.[k];
    if (shardIndex == null) return null;

    const file = `works_${pad3(Number(shardIndex))}.json`;
    const v = qs().get("v");
    const shardUrl = v
      ? `${WORKS_SHARD_DIR}/${file}?v=${encodeURIComponent(v)}`
      : `${WORKS_SHARD_DIR}/${file}`;

    const shard = await loadJson(shardUrl, { bust });
    const items = Array.isArray(shard?.items) ? shard.items : [];
    return items.find(x => toText(x?.seriesKey) === k) || null;
  }

  if (worksState?.mode === "legacy") {
    const items = Array.isArray(worksState.legacyItems) ? worksState.legacyItems : [];
    return items.find(x => toText(x?.seriesKey) === k) || null;
  }

  return null;
}

/* =======================
 * Toast（Step A）
 * ======================= */
let __toastEl = null;
let __toastTimer = null;

function ensureToast(){
  if (__toastEl) return __toastEl;
  const el = document.createElement("div");
  el.id = "toast";
  el.setAttribute("aria-live", "polite");
  el.setAttribute("aria-atomic", "true");
  el.style.cssText = `
    position: fixed;
    left: 50%;
    bottom: 14px;
    transform: translateX(-50%);
    z-index: 9999;
    max-width: min(560px, calc(100vw - 24px));
    pointer-events: none;
    opacity: 0;
    transition: opacity .18s ease, transform .18s ease;
  `;
  document.body.appendChild(el);
  __toastEl = el;
  return el;
}

function showToast(text){
  const el = ensureToast();
  if (__toastTimer) clearTimeout(__toastTimer);

  el.innerHTML = `
    <div style="
      pointer-events:none;
      background: rgba(20,20,20,.92);
      color:#fff;
      padding:10px 12px;
      border-radius: 12px;
      font-size: 13px;
      line-height: 1.4;
      box-shadow: 0 10px 30px rgba(0,0,0,.22);
    ">
      ${esc(text)}
    </div>
  `;
  // show
  el.style.opacity = "1";
  el.style.transform = "translateX(-50%) translateY(0)";

  __toastTimer = setTimeout(() => {
    el.style.opacity = "0";
    el.style.transform = "translateX(-50%) translateY(6px)";
  }, 1300);
}

/* =======================
 * Tag DF / IDF reco
 * ======================= */
function buildTagDf(items){
  const df = new Map();
  for (const it of (items || [])) {
    const raw = pickArr(it, ["tags", "vol1.tags"]).map(toText).filter(Boolean);
    const tags = Array.from(new Set(raw));
    for (const t of tags) df.set(t, (df.get(t) || 0) + 1);
  }
  return df;
}
function idfOf(tag, df, N){
  const d = df.get(tag) || 0;
  return Math.log((N + 1) / (d + 1)) + 1;
}
function tagSimilarTop3({ baseIt, allItems, df }) {
  const baseKey = toText(pick(baseIt, ["seriesKey"]));
  const baseTags = new Set(itTags(baseIt));
  const N = Math.max(1, (allItems || []).length);

  const scored = [];
  for (const it of (allItems || [])) {
    const sk = toText(pick(it, ["seriesKey"]));
    if (!sk || sk === baseKey) continue;

    const tags = itTags(it);
    let common = 0;
    let score = 0;

    for (const t of tags) {
      if (!baseTags.has(t)) continue;
      common++;
      score += idfOf(t, df, N);
    }
    if (common < 2) continue;

    scored.push({ it, score, common });
  }

  scored.sort((a,b) => (b.score - a.score) || (b.common - a.common));
  return scored.slice(0, 3).map(x => x.it);
}
function clamp3(arr){ return (arr || []).filter(Boolean).slice(0, 3); }

/* =======================
 * Vote cosine reco
 * ======================= */
const VOTE_AGG_PATH = "./data/metrics/wae/vote_by_series_mood.json";
const VOTE_MIN_TOTAL = 5;

function buildVoteMatrix(voteRows) {
  const rows = Array.isArray(voteRows?.rows) ? voteRows.rows
    : Array.isArray(voteRows?.data) ? voteRows.data
    : Array.isArray(voteRows) ? voteRows
    : [];

  const bySeries = new Map(); // sk -> Map(mood -> n)
  const totals = new Map();   // sk -> total

  for (const r of rows) {
    const sk = toText(r?.seriesKey);
    const mood = toText(r?.mood);
    const n = Number(r?.n || 0);
    if (!sk || !mood || !Number.isFinite(n)) continue;

    if (!bySeries.has(sk)) bySeries.set(sk, new Map());
    const m = bySeries.get(sk);
    m.set(mood, (m.get(mood) || 0) + n);

    totals.set(sk, (totals.get(sk) || 0) + n);
  }

  return { bySeries, totals };
}

function cosineSim(aMap, bMap) {
  if (!aMap || !bMap) return 0;

  let dot = 0, a2 = 0, b2 = 0;
  for (const [, v] of aMap) a2 += (v * v);
  for (const [, v] of bMap) b2 += (v * v);
  if (a2 <= 0 || b2 <= 0) return 0;

  for (const [k, av] of aMap) {
    const bv = bMap.get(k);
    if (bv != null) dot += av * bv;
  }
  return dot / (Math.sqrt(a2) * Math.sqrt(b2));
}

function voteSimilarTop3({ baseKey, allItems, voteMatrix }) {
  if (!voteMatrix?.bySeries?.size) return [];

  const baseVec = voteMatrix.bySeries.get(baseKey);
  if (!baseVec) return [];

  const scored = [];
  for (const it of (allItems || [])) {
    const sk = toText(pick(it, ["seriesKey"]));
    if (!sk || sk === baseKey) continue;

    const total = voteMatrix.totals.get(sk) || 0;
    if (total < VOTE_MIN_TOTAL) continue;

    const vec = voteMatrix.bySeries.get(sk);
    if (!vec) continue;

    const sim = cosineSim(baseVec, vec);
    if (sim <= 0) continue;

    scored.push({ it, sim, total });
  }

  scored.sort((a, b) => (b.sim - a.sim) || (b.total - a.total));
  return scored.slice(0, 3).map(x => x.it);
}

/* =======================
 * Work reco helpers
 * ======================= */
function toRecItem(it) {
  const seriesKey = toText(pick(it, ["seriesKey"])) || "";
  const title = toText(pick(it, ["title", "vol1.title"])) || seriesKey || "(無題)";
  const imgRaw = toText(pick(it, ["image", "vol1.image"])) || "";
  const img = normalizeImgUrl(imgRaw);
  return { seriesKey, title, img };
}

function recMiniRowHtml(items){
  const xs = (items || []).filter(Boolean);
  if (!xs.length) return `<div class="d-sub" style="opacity:.8;">データがまだありません</div>`;

  return `
    <div style="display:flex; gap:10px; overflow:auto; padding: 8px 2px 2px;">
      ${xs.map(x => `
        <a href="./work.html?key=${encodeURIComponent(x.seriesKey)}"
           style="min-width:110px; text-decoration:none; color:inherit;">
          <div style="
            border:1px solid rgba(0,0,0,.10);
            border-radius: 12px;
            overflow:hidden;
            background:#fff;
          ">
            <div style="aspect-ratio: 3/4; display:flex; align-items:center; justify-content:center;">
              ${
                x.img
                  ? `<img src="${IMG_PLACEHOLDER_SRC}" data-src="${esc(x.img)}" alt="${esc(x.title)}" loading="lazy" decoding="async" style="width:100%; height:100%; object-fit:cover;">`
                  : `<div class="thumb-ph" style="width:100%; height:100%;"></div>`
              }
            </div>
            <div style="font-size:12px; padding:8px; line-height:1.35;">
              ${esc(x.seriesKey || x.title)}
            </div>
          </div>
        </a>
      `).join("")}
    </div>
  `;
}

function recGridHtml(title, items){
  const xs = (items || []).filter(Boolean);
  if (!xs.length) return "";
  return `
    <div class="rec-block">
      <div class="rec-head"><div class="rec-title">${esc(title)}</div></div>
      <div class="rec-grid">
        ${xs.map(x => `
          <a class="rec-item" href="./work.html?key=${encodeURIComponent(x.seriesKey)}" aria-label="${esc(x.title)}">
            <div class="rec-cover">
              ${
                x.img
                  ? `<img src="${IMG_PLACEHOLDER_SRC}" data-src="${esc(x.img)}" alt="${esc(x.title)}" loading="lazy" decoding="async">`
                  : `<div class="thumb-ph"></div>`
              }
            </div>
            <div class="rec-name">${esc(x.seriesKey || x.title)}</div>
          </a>
        `).join("")}
      </div>
    </div>
  `;
}

/* ===== popular same genre×audience ===== */
function pickFirstGenre(it) {
  const g = pickArr(it, ["genres", "vol1.genres"]).map(toText).filter(Boolean);
  return g[0] || "";
}
function pickFirstAudience(it) {
  return getFirstAudienceLabel(it) || "その他";
}
function popularSameGenreAudTop3({ baseIt, allItems, viewsMap }) {
  const baseKey = toText(pick(baseIt, ["seriesKey"]));
  const g0 = pickFirstGenre(baseIt);
  const a0 = pickFirstAudience(baseIt);
  if (!g0 || !a0) return [];

  const scored = [];
  for (const it of (allItems || [])) {
    const sk = toText(pick(it, ["seriesKey"]));
    if (!sk || sk === baseKey) continue;

    const g = pickFirstGenre(it);
    const a = pickFirstAudience(it);
    if (g !== g0) continue;
    if (a !== a0) continue;

    const v = viewsMap?.get(sk) || 0;
    scored.push({ it, v });
  }

  scored.sort((a, b) => (b.v - a.v));
  return scored.slice(0, 3).map(x => x.it);
}

/* =======================
 * perf: DF cache (work reco)
 * ======================= */
let __dfCache = null;
let __dfCacheN = 0;
function getDfCached(allItems){
  const N = (allItems || []).length;
  if (__dfCache && __dfCacheN === N) return __dfCache;
  __dfCache = buildTagDf(allItems || []);
  __dfCacheN = N;
  return __dfCache;
}

/* =======================
 * Rating (★1〜5) - local once
 * ======================= */
const RATE_STATE_PREFIX = "rate:v1:";
function rateStateKey(seriesKey, k){ return `${RATE_STATE_PREFIX}${toText(seriesKey)}:${toText(k)}`; }
function getRatedValue(seriesKey, k){
  const sk = toText(seriesKey);
  const kk = toText(k);
  if (!sk || !kk) return "";
  try { return toText(localStorage.getItem(rateStateKey(sk, kk)) || ""); } catch { return ""; }
}
function setRatedValue(seriesKey, k, v){
  const sk = toText(seriesKey);
  const kk = toText(k);
  const vv = toText(v);
  if (!sk || !kk || !vv) return;
  try { localStorage.setItem(rateStateKey(sk, kk), vv); } catch {}
}

function starsHtml({ idPrefix, label, selected }) {
  const sel = Number(selected || 0);
  const btns = [1,2,3,4,5].map(n => {
    const on = sel >= n;
    return `
      <button
        type="button"
        class="star-btn ${on ? "is-on" : ""}"
        data-star="${n}"
        data-starid="${esc(idPrefix)}"
        aria-label="${esc(label)} ${n}"
        aria-pressed="${on ? "true" : "false"}"
        style="padding:6px 8px; font-size:18px; line-height:1; border:1px solid rgba(0,0,0,.12); background:#fff; border-radius:10px;"
      >${on ? "★" : "☆"}</button>
    `;
  }).join("");

  return `
    <div class="rate-row" style="margin-top:10px;">
      <div class="d-sub" style="margin-bottom:6px;">${esc(label)}</div>
      <div class="rate-stars" data-starwrap="${esc(idPrefix)}" style="display:flex; gap:6px; flex-wrap:wrap;">
        ${btns}
      </div>
    </div>
  `;
}

function applyStarsUi(wrapEl, selected){
  const sel = Number(selected || 0);
  const btns = wrapEl?.querySelectorAll?.("button[data-star]") || [];
  for (const b of btns) {
    const n = Number(b.getAttribute("data-star") || 0);
    const on = sel >= n && n > 0;
    b.classList.toggle("is-on", on);
    b.textContent = on ? "★" : "☆";
    b.setAttribute("aria-pressed", on ? "true" : "false");
  }
}

/* =======================
 * Work unlock state（読後感枠の報酬表示用）
 * ======================= */
const WORK_UNLOCK_PREFIX = "work_unlock:v2:"; // v2（既存と衝突しない）
function unlockKey(seriesKey){ return `${WORK_UNLOCK_PREFIX}${toText(seriesKey)}`; }
function isUnlocked(seriesKey){
  const sk = toText(seriesKey);
  if (!sk) return false;
  // 既に解除フラグ
  try { if (localStorage.getItem(unlockKey(sk)) === "1") return true; } catch {}
  // 読後感投票済み（選択が残ってる）
  const voted = getVotedSet(sk);
  return !!(voted && voted.size);
}
function setUnlocked(seriesKey){
  const sk = toText(seriesKey);
  if (!sk) return false;
  try {
    const k = unlockKey(sk);
    const prev = localStorage.getItem(k) === "1";
    if (!prev) localStorage.setItem(k, "1");
    return !prev; // 初回解除なら true
  } catch {
    return true;
  }
}

/* =======================
 * Work: みんなの読後感（投票枠内に表示）
 * - mood は quick_filters の id の想定なので label に変換
 * ======================= */
function buildMoodLabelMap(defs){
  const m = new Map();
  for (const d of (defs || [])) {
    const id = toText(d?.id);
    const label = toText(d?.label) || id;
    if (id) m.set(id, label);
  }
  return m;
}

function moodTopHtml({ seriesKey, voteMatrix, defs, max = 4 }){
  const sk = toText(seriesKey);
  if (!sk || !voteMatrix?.bySeries?.size) return "";

  const m = voteMatrix.bySeries.get(sk);
  if (!m) return "";

  const labelMap = buildMoodLabelMap(defs);

  const rows = Array.from(m.entries())
    .map(([mood, n]) => ({ mood: toText(mood), label: labelMap.get(toText(mood)) || toText(mood), n: Number(n || 0) }))
    .filter(x => x.mood && Number.isFinite(x.n) && x.n > 0)
    .sort((a, b) => (b.n - a.n))
    .slice(0, max);

  if (!rows.length) return "";
  return `
    <div class="pills" style="margin-top:6px;">
      ${rows.map(r => `<span class="pill">${esc(r.label)} <span style="opacity:.7;">(${r.n})</span></span>`).join("")}
    </div>
  `;
}

/* =======================
 * Work：平均★（rate_by_series_key）
 * ======================= */
function buildRateBySeriesKeyMap(json){
  const rows = Array.isArray(json?.rows) ? json.rows
    : Array.isArray(json?.data) ? json.data
    : Array.isArray(json) ? json : [];

  const map = new Map();
  for (const r of rows) {
    const sk = toText(r?.seriesKey);
    const k = toText(r?.k);
    const avg = Number(r?.avg ?? 0);
    const n = Number(r?.n ?? 0);
    if (!sk || !k) continue;
    if (!map.has(sk)) map.set(sk, {});
    map.get(sk)[k] = { avg, n };
  }
  return map;
}
function formatStarAvg(v){
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return "";
  return (Math.round(n * 10) / 10).toFixed(1);
}

/* =======================
 * Work render
 * ======================= */
async function renderWork(worksState, quickDefs, { viewsMap, voteMatrix, rateSeriesMap } = {}) {
  const detail = document.getElementById("detail");
  if (!detail) return;

  const key = qs().get("key");
  if (!key) return;

  const it = await loadWorkFullByKey({ worksState, key, bust: !!qs().get("v") });
  if (!it) {
    detail.innerHTML = `<div class="status">作品が見つかりません</div>`;
    return;
  }

  const seriesKey = toText(pick(it, ["seriesKey"])) || "";
  const title = toText(pick(it, ["title", "vol1.title"])) || seriesKey || "(無題)";

  const imgRaw = toText(pick(it, ["image", "vol1.image"])) || "";
  const img = normalizeImgUrl(imgRaw);

  const amzRaw = toText(pick(it, ["amazonDp", "vol1.amazonDp", "amazonUrl", "vol1.amazonUrl"])) || "";
  const amz = ensureAmazonAffiliate(amzRaw);

  const synopsis = toText(pick(it, ["synopsis", "vol1.synopsis"])) || "";
  const author = toText(pick(it, ["author", "vol1.author"])) || "";
  const magazine = toText(pick(it, ["magazine", "vol1.magazine"])) || "";
  const tagsJa = pickArr(it, ["tags", "vol1.tags"]).map(toText).filter(Boolean);

  const release = formatYmd(pick(it, ["releaseDate", "vol1.releaseDate"])) || "";
  const publisher = toText(pick(it, ["publisher", "vol1.publisher"])) || "";

  const defs = Array.isArray(quickDefs) ? quickDefs : [];
  const voted = getVotedSet(seriesKey);
  const unlocked = isUnlocked(seriesKey);

  // ---- vote reward content (computed now) ----
  const allForReco = Array.isArray(worksState?.listItems) ? worksState.listItems : [];

  let simByVotes = [];
  if (voteMatrix?.bySeries?.size) {
    simByVotes = clamp3(voteSimilarTop3({ baseKey: seriesKey, allItems: allForReco, voteMatrix })).map(toRecItem);
  }
  const moodTop = moodTopHtml({ seriesKey, voteMatrix, defs, max: 4 });

  const voteBox = defs.length ? `
    <div class="vote-box" style="margin-top:12px;">
      <div class="vote-head">
        <h3 class="vote-title">投票で育つ：この作品の「読後感」</h3>
      </div>
      <p class="vote-note">1タップ投票（最大2つ）。集まった投票はランキング・関連作品に反映されます。</p>

      <div class="pills" id="votePills">
        ${defs.map(d => {
          const on = voted.has(d.id);
          return `
            <button type="button" class="pill ${on ? "is-on" : ""}" data-vote="${esc(d.id)}" aria-pressed="${on ? "true" : "false"}">
              ${esc(d.label)}
            </button>
          `;
        }).join("")}
      </div>

      <div id="voteReward" style="
        margin-top:10px;
        padding: 10px 10px;
        border:1px solid rgba(0,0,0,.10);
        border-radius: 14px;
        background: rgba(0,0,0,.02);
      ">
        <div id="voteRewardLocked" style="${unlocked ? "display:none;" : ""}">
          <div class="d-sub" style="opacity:.85;">投票すると、ここに「みんなの読後感」と「同じ読後感の作品」が表示されます。</div>
        </div>

        <div id="voteRewardUnlocked" style="${unlocked ? "" : "display:none;"}">
          <div class="d-sub" style="font-weight:700;">みんなの読後感</div>
          ${moodTop || `<div class="d-sub" style="opacity:.8;">データがまだありません</div>`}

          <div class="d-sub" style="margin-top:10px; font-weight:700;">同じ読後感の作品</div>
          ${recMiniRowHtml(simByVotes)}
        </div>
      </div>

      <div class="vote-status" id="voteStatus"></div>
    </div>
  ` : "";

  // ---- ratings ----
  const recVal = getRatedValue(seriesKey, "rec");
  const artVal = getRatedValue(seriesKey, "art");

  // 平均★（常時表示はせず「★投票したら」表示）
  function avgStarsHtml(){
    if (!rateSeriesMap?.size || !rateSeriesMap.has(seriesKey)) return "";
    const rec = rateSeriesMap.get(seriesKey)?.rec;
    const art = rateSeriesMap.get(seriesKey)?.art;
    const recTxt = rec?.avg ? `おすすめ度: ★${formatStarAvg(rec.avg)} <span style="opacity:.7;">(n=${Number(rec.n || 0)})</span>` : "";
    const artTxt = art?.avg ? `作画: ★${formatStarAvg(art.avg)} <span style="opacity:.7;">(n=${Number(art.n || 0)})</span>` : "";
    const join = [recTxt, artTxt].filter(Boolean).join(" / ");
    if (!join) return "";
    return `<div class="d-sub" style="margin-top:6px;">平均: ${join}</div>`;
  }

  const hasStarVoted = !!(recVal || artVal);

  const rateBox = `
    <div class="vote-box" style="margin-top:12px;">
      <div class="vote-head">
        <h3 class="vote-title">評価</h3>
      </div>
      <p class="vote-note">★を選んで投票（各項目1回）。</p>

      <div id="avgStarsLocked" style="${hasStarVoted ? "display:none;" : ""}">
        <div class="d-sub" style="opacity:.85;">★を投票すると平均★が表示されます。</div>
      </div>
      <div id="avgStarsUnlocked" style="${hasStarVoted ? "" : "display:none;"}">
        ${avgStarsHtml()}
      </div>

      ${starsHtml({ idPrefix: "rec", label: "おすすめ度", selected: recVal })}
      ${starsHtml({ idPrefix: "art", label: "作画クオリティ", selected: artVal })}
      <div class="vote-status" id="rateStatus"></div>
    </div>
  `;

  // ---- reco ----
  const df = getDfCached(allForReco);
  const simByTags = clamp3(tagSimilarTop3({ baseIt: it, allItems: allForReco, df })).map(toRecItem);
  const popular = clamp3(popularSameGenreAudTop3({ baseIt: it, allItems: allForReco, viewsMap })).map(toRecItem);

  const recoHtml = `
    <div class="rec-wrap">
      ${recGridHtml("似ている作品", simByTags)}
      ${recGridHtml("このジャンル×カテゴリーで人気", popular)}
    </div>
  `;

  detail.innerHTML = `
    <div class="d-title">${esc(seriesKey || title)}</div>

    ${author ? `<div class="d-sub">${esc(author)}</div>` : ""}
    ${magazine ? `<div class="d-sub">連載誌: ${esc(magazine)}</div>` : ""}
    ${release ? `<div class="d-sub">発売日: ${esc(release)}</div>` : ""}
    ${publisher ? `<div class="d-sub">出版社: ${esc(publisher)}</div>` : ""}

    ${tagsJa.length ? `<div class="d-sub">タグ</div>${pillsAll(tagsJa)}` : ""}

    <div class="d-row" style="margin-top:10px;">
      ${
        img
          ? `<img class="d-img" src="${IMG_PLACEHOLDER_SRC}" data-src="${esc(img)}" alt="${esc(title)}" loading="lazy" decoding="async"/>`
          : ""
      }
      <div class="d-links">
        ${amz ? `<a class="btn" href="${esc(amz)}" target="_blank" rel="nofollow noopener">Amazon（1巻）</a>` : ""}
        ${favButtonHtml(seriesKey, "work")}
      </div>
    </div>

    ${synopsis ? `
      <div class="d-sub" style="margin-top:14px;">あらすじ</div>
      <div class="d-text">${esc(synopsis)}</div>
    ` : ""}

    ${voteBox}

    ${rateBox}

    ${recoHtml}
  `;

  initLazyImages(detail);

  // work_view：同一セッション1回
  trackWorkViewOnce(seriesKey);

  // ---- helpers: reward show ----
  function showVoteRewardIfNeeded({ newly }){
    const locked = document.getElementById("voteRewardLocked");
    const unlockedEl = document.getElementById("voteRewardUnlocked");
    if (locked) locked.style.display = "none";
    if (unlockedEl) unlockedEl.style.display = "";

    // “解除”という言葉は使わない
    if (newly) showToast("投票ありがとう！みんなの傾向を表示しました。");
    else showToast("投票ありがとう！");
  }

  // vote：最大2 + 選択状態保持、送信はvoteOnceで抑止
  const vp = document.getElementById("votePills");
  if (vp) {
    vp.onclick = (ev) => {
      const btn = ev.target?.closest?.("button[data-vote]");
      if (!btn) return;
      const mood = btn.getAttribute("data-vote") || "";
      if (!mood) return;

      const st = document.getElementById("voteStatus");
      const set = getVotedSet(seriesKey);

      const isOn = set.has(mood);
      if (isOn) {
        set.delete(mood);
        setVotedSet(seriesKey, set);
        btn.classList.remove("is-on");
        btn.setAttribute("aria-pressed", "false");
        if (st) st.textContent = "選択を外しました";
        setTimeout(() => { if (st) st.textContent = ""; }, 900);
        showToast("選択を外しました");
        return;
      }

      if (set.size >= VOTE_MAX) {
        if (st) st.textContent = "最大2つまで選べます";
        setTimeout(() => { if (st) st.textContent = ""; }, 1100);
        showToast("最大2つまで選べます");
        return;
      }

      set.add(mood);
      setVotedSet(seriesKey, set);
      btn.classList.add("is-on");
      btn.setAttribute("aria-pressed", "true");

      const sent = trackVoteOnce(seriesKey, mood);

      // 初回だけ“表示しました”扱いにする
      const newly = setUnlocked(seriesKey);
      showVoteRewardIfNeeded({ newly });

      if (st) {
        st.textContent = sent ? "投票しました" : "投票済み（しばらくしてから）";
        setTimeout(() => { if (st) st.textContent = ""; }, 900);
      }
    };
  }

  // ratings：各項目1回（端末内で固定）
  const rateStatus = document.getElementById("rateStatus");
  const wraps = detail.querySelectorAll?.("[data-starwrap]") || [];
  for (const w of wraps) {
    const id = w.getAttribute("data-starwrap") || "";
    const cur = getRatedValue(seriesKey, id);
    applyStarsUi(w, cur);

    w.addEventListener("click", (ev) => {
      const btn = ev.target?.closest?.("button[data-star]");
      if (!btn) return;

      const k = btn.getAttribute("data-starid") || "";
      const n = toText(btn.getAttribute("data-star") || "");
      if (!k || !n) return;

      const already = getRatedValue(seriesKey, k);
      const sendVal = already || n;

      if (!already) {
        setRatedValue(seriesKey, k, n);
        applyStarsUi(w, n);
      }

      // ★投票したら平均★枠だけ開く（読後感報酬とは混ぜない）
      const locked = document.getElementById("avgStarsLocked");
      const unlockedEl = document.getElementById("avgStarsUnlocked");
      if (locked) locked.style.display = "none";
      if (unlockedEl) unlockedEl.style.display = "";

      const onceKey = `rate:${toText(seriesKey)}:${toText(k)}:${toText(sendVal)}`;
      if (canSendOnce(onceKey)) {
        trackEvent({ type: "rate", page: "work", seriesKey, k, v: sendVal });
      }

      if (rateStatus) {
        const label = (k === "rec") ? "おすすめ度" : (k === "art") ? "作画クオリティ" : "評価";
        rateStatus.textContent = already ? `${label} は投票済み` : `${label} を投票しました`;
        setTimeout(() => { if (rateStatus) rateStatus.textContent = ""; }, 900);
      }
      showToast(already ? "投票済みです" : "投票ありがとう！");
    }, { passive: true });
  }

  refreshFavButtons(document);
}

/* =======================
 * metrics loader helpers
 * ======================= */
function withV(url){
  const v = qs().get("v");
  return v ? `${url}?v=${encodeURIComponent(v)}` : url;
}

/* =======================
 * run
 * ======================= */
async function run() {
  try {
    const v = qs().get("v");
    const bust = !!v;

    const worksState = await loadWorksIndex({ bust });

    const quickUrl = v ? `${QUICK_FILTERS_PATH}?v=${encodeURIComponent(v)}` : QUICK_FILTERS_PATH;
    const quick = await loadJson(quickUrl, { bust });
    const quickDefs = Array.isArray(quick?.items) ? quick.items : [];

    let viewsMap = new Map();
    try {
      const viewUrl = v
        ? `./data/metrics/wae/work_view_by_series.json?v=${encodeURIComponent(v)}`
        : "./data/metrics/wae/work_view_by_series.json";
      const viewJson = await loadJson(viewUrl, { bust });
      const rows = Array.isArray(viewJson?.rows) ? viewJson.rows
        : Array.isArray(viewJson?.data) ? viewJson.data
        : Array.isArray(viewJson) ? viewJson : [];
      viewsMap = buildViewsMap(rows);
    } catch {
      viewsMap = new Map();
    }

    let voteMatrix = null;
    try {
      const voteUrl = v ? `${VOTE_AGG_PATH}?v=${encodeURIComponent(v)}` : VOTE_AGG_PATH;
      const voteJson = await loadJson(voteUrl, { bust });
      voteMatrix = buildVoteMatrix(voteJson);
    } catch {
      voteMatrix = null;
    }

    let rateRecTop = [];
    let rateArtTop = [];
    let rateSeriesMap = new Map();
    try {
      const recJson = await tryLoadJson(withV(METRIC_RATE_REC_TOP_PATH), { bust });
      rateRecTop = normalizeRateTopRows(recJson);
    } catch { rateRecTop = []; }

    try {
      const artJson = await tryLoadJson(withV(METRIC_RATE_ART_TOP_PATH), { bust });
      rateArtTop = normalizeRateTopRows(artJson);
    } catch { rateArtTop = []; }

    try {
      const bySeriesJson = await tryLoadJson(withV(METRIC_RATE_BY_SERIES_KEY_PATH), { bust });
      rateSeriesMap = bySeriesJson ? buildRateBySeriesKeyMap(bySeriesJson) : new Map();
    } catch { rateSeriesMap = new Map(); }

    const itemsByKey = new Map();
    for (const it of (worksState.listItems || [])) {
      const sk = toText(pick(it, ["seriesKey"]));
      if (sk) itemsByKey.set(sk, it);
    }

    if (document.getElementById("homePopular")) {
      renderHomePopular({ items: worksState.listItems, viewsMap, limit: 6 });
    }
    if (document.getElementById("homeRateRec")) {
      renderHomeRateTop({ rootId: "homeRateRec", titleLabel: "おすすめ度", rows: rateRecTop, itemsByKey, limit: 6 });
    }
    if (document.getElementById("homeRateArt")) {
      renderHomeRateTop({ rootId: "homeRateArt", titleLabel: "作画クオリティ", rows: rateArtTop, itemsByKey, limit: 6 });
    }
    if (document.getElementById("genreTabs") && document.getElementById("genreRow")) {
      const st = getHomeState();
      renderGenreTabsRow({ items: worksState.listItems, activeId: st.g });
    }
    if (document.getElementById("audienceTabs") && document.getElementById("audienceRow")) {
      const st = getHomeState();
      renderAudienceTabsRow({ items: worksState.listItems, activeAudId: st.a });
    }
    if (document.getElementById("quickFiltersHome")) {
      const counts = new Map(quickDefs.map(d => [d.id, 0]));
      for (const it of worksState.listItems) {
        for (const d of quickDefs) {
          if (quickEval(it, d).ok) counts.set(d.id, (counts.get(d.id) || 0) + 1);
        }
      }
      renderQuickHome({ defs: quickDefs, counts });
    }

    renderList(worksState.listItems, quickDefs);
    await renderWork(worksState, quickDefs, { viewsMap, voteMatrix, rateSeriesMap });

    patchAmazonAnchors(document);

    bindFavHandlers(document);
    refreshFavButtons(document);
    initLazyImages(document);

    setStatus("");
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

/* END PART 2 - token: A1B2 */
