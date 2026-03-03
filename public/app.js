// public/app.js（1/3）FULL REPLACE
// - ✅ List: ジャンルは確定10本（日本語表示 / URLはid）
// - ✅ List: カテゴリー順固定（少年→青年→少女→女性→Web/アプリ→全部）
// - ✅ List: 連載誌は magazine_normalize.json から「主要 + もっと見る」をプルダウン（optgroup）/ 作品数表示
// - ✅ Web/アプリ連載誌は Web/アプリカテゴリ（aud=その他）にだけ表示（「全部」には混ぜない）
// - ✅ genre/mag URL互換（旧クエリ）を拾う
// - ✅ sort(pop/new/rise) + 50件+もっと見る(+50) + 件数表示(A案) + list_filter拡張
//
// 【分割ルール】
// - 1/3 はこの END マーカーで必ず終わる
// - 2/3 は START マーカーから必ず始める
// - 3/3 は START マーカーから必ず始める
// token: C3D4

function qs() { return new URLSearchParams(location.search); }

// ✅ base path: /work/<id>/ 配下でも壊れないようにする
const IS_STATIC_WORK = /\/work\/[^/]+\/?$/.test(location.pathname);
const BASE = IS_STATIC_WORK ? "../../" : "./";

/* =======================
 * perf: tiny placeholder
 * ======================= */
const IMG_PLACEHOLDER_SRC =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";

/* =======================
 * perf: JSON cache (same session)
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
function toTimeMsFromYmd(s) {
  const t = formatYmd(s);
  if (!t) return 0;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (!m) return 0;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d, 0, 0, 0));
  const ms = dt.getTime();
  return Number.isFinite(ms) ? ms : 0;
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
 * base64url helpers + work static URL
 * ======================= */
function b64urlFromUtf8(s) {
  const bytes = new TextEncoder().encode(String(s ?? ""));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  const b64 = btoa(bin);
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function workStaticUrl(seriesKey) {
  const sk = toText(seriesKey);
  if (!sk) return `${BASE}list.html`;
  const id = b64urlFromUtf8(sk);
  const v = qs().get("v");
  return `${BASE}work/${id}/` + (v ? `?v=${encodeURIComponent(v)}` : "");
}

/* =======================
 * works split paths（BASE対応）
 * ======================= */
const WORKS_INDEX_PATH = BASE + "data/lane2/works/index.json";
const WORKS_SHARD_DIR = BASE + "data/lane2/works";
const WORKS_LEGACY_PATH = BASE + "data/lane2/works.json";

/* =======================
 * metrics paths（★集計 / BASE対応）
 * ======================= */
const METRIC_RATE_REC_TOP_PATH = BASE + "data/metrics/wae/rate_rec_top.json";
const METRIC_RATE_ART_TOP_PATH = BASE + "data/metrics/wae/rate_art_top.json";
const METRIC_RATE_BY_SERIES_KEY_PATH = BASE + "data/metrics/wae/rate_by_series_key.json";

/* ✅ NEW: List sort metrics */
const METRIC_WORK_VIEW_BY_SERIES_PATH = BASE + "data/metrics/wae/work_view_by_series.json";
const METRIC_RISING_WORK_VIEW_PATH = BASE + "data/metrics/wae/rising_work_view_since_20260227.json";

/* =======================
 * List: magazine normalize JSON
 * ======================= */
const MAG_NORMALIZE_PATH = BASE + "data/lane2/magazine_normalize.json";

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
  { id: "comedy", label: "コメディ", match: ["Comedy"] },
  { id: "slice", label: "日常", match: ["Slice of Life"] },
  { id: "sports", label: "スポーツ", match: ["Sports"] },
  { id: "drama", label: "ヒューマンドラマ", match: ["Drama"] },
];

/* =======================
 * Home/List：カテゴリー棚（固定順）
 * ======================= */
const HOME_CATEGORY_TABS = [
  { id: "shonen", value: "少年", label: "少年" },
  { id: "seinen", value: "青年", label: "青年" },
  { id: "shojo", value: "少女", label: "少女" },
  { id: "josei", value: "女性", label: "女性" },
  { id: "webapp", value: "その他", label: "Web/アプリ" }, // 表示はJSONで上書きされる想定
];

const WEBAPP_AUD_VALUE = "その他"; // 作品データ上の値は固定（表示名だけWeb/アプリにする）

/* =======================
 * ✅ Audience helpers（複数audiences対応）
 * - 既存の getFirstAudienceLabel は温存（互換）
 * ======================= */
function getAudienceList(it) {
  return pickArr(it, ["audiences", "vol1.audiences"]).map(toText).filter(Boolean);
}
function hasAudience(it, aud) {
  const a = toText(aud);
  if (!a) return true; // ""=全部
  const list = getAudienceList(it);
  return list.includes(a);
}
// “代表audience” が必要な場面だけ使う（順序ブレ対策）
const AUD_PRIORITY = ["少年", "青年", "少女", "女性", WEBAPP_AUD_VALUE];
function pickMainAudience(it) {
  const list = getAudienceList(it);
  for (const a of AUD_PRIORITY) {
    if (list.includes(a)) return a;
  }
  return list[0] || WEBAPP_AUD_VALUE;
}

// ✅ 互換：既存コードが「先頭」を期待している箇所があるので残す
function getFirstAudienceLabel(it) {
  const arr = getAudienceList(it);
  return arr[0] || WEBAPP_AUD_VALUE;
}

function hasAnyGenreByTabId(it, tabId) {
  const t = HOME_GENRE_TABS.find(x => x.id === tabId);
  if (!t) return true;
  const g = pickArr(it, ["genres", "vol1.genres"]).map(toText).filter(Boolean);
  return t.match.some(x => g.includes(x));
}

function hasAnyGenreByTabIds(it, tabIds) {
  const ids = (tabIds || []).map(toText).filter(Boolean);
  if (!ids.length) return true;
  return ids.some(id => hasAnyGenreByTabId(it, id));
}

/* =======================
 * List：URL（genre/aud/mag/mood/sort）
 * ======================= */

// ✅ genre は id で保持する。互換として旧URL(genre=Fantasy 等)も拾う
function parseGenreQueryIds() {
  const raw = toText(qs().get("genre"));
  if (!raw) return [];

  const toks = raw.split(",").map(s => s.trim()).filter(Boolean);
  const out = new Set();

  const byId = new Map(HOME_GENRE_TABS.map(t => [t.id, t]));
  const byLabel = new Map(HOME_GENRE_TABS.map(t => [t.label, t]));
  const byMatch = new Map();
  for (const t of HOME_GENRE_TABS) {
    for (const m of t.match) byMatch.set(m, t);
  }

  for (const x of toks) {
    if (byId.has(x)) { out.add(x); continue; }
    if (byLabel.has(x)) { out.add(byLabel.get(x).id); continue; }
    if (byMatch.has(x)) { out.add(byMatch.get(x).id); continue; }
  }

  return Array.from(out);
}

function setGenreQueryIds(ids) {
  const p = qs();
  const xs = (ids || []).map(toText).filter(Boolean);
  if (xs.length) p.set("genre", xs.join(","));
  else p.delete("genre");
  const url = `${location.pathname}?${p.toString()}`;
  history.replaceState(null, "", url);
}

function parseAudQuery() {
  return toText(qs().get("aud")).trim(); // "" = 全部
}
function setAudQuery(aud) {
  const p = qs();
  const v = toText(aud);
  if (v) p.set("aud", v);
  else p.delete("aud");
  const url = `${location.pathname}?${p.toString()}`;
  history.replaceState(null, "", url);
}

// ✅ mag query: 互換対応（mag / magazine / m）
// 書くのは mag に統一
function parseMagQuery() {
  const p = qs();
  const raw =
    toText(p.get("mag")) ||
    toText(p.get("magazine")) ||
    toText(p.get("m"));
  return raw ? raw.trim() : "";
}
function setMagQuery(mag) {
  const p = qs();
  p.delete("magazine");
  p.delete("m");
  const v = toText(mag);
  if (v) p.set("mag", v);
  else p.delete("mag");
  const url = `${location.pathname}?${p.toString()}`;
  history.replaceState(null, "", url);
}

/* ✅ NEW: sort */
const SORT_KEYS = ["pop","new","rise"];
function parseSortQuery() {
  const raw = toText(qs().get("sort")).trim();
  return SORT_KEYS.includes(raw) ? raw : "pop";
}
function setSortQuery(sortKey) {
  const p = qs();
  const v = toText(sortKey);
  if (v && SORT_KEYS.includes(v)) p.set("sort", v);
  else p.delete("sort");
  const url = `${location.pathname}?${p.toString()}`;
  history.replaceState(null, "", url);
}

/* =======================
 * List: magazine normalize helpers
 * ======================= */
function normalizeBang(s){
  // !/！ や全角スペースを統一（ヤンジャン！問題はここで吸収）
  return toText(s).replaceAll("！", "!").replaceAll("　", " ").trim();
}
function buildMagNormalizer(normJson){
  const alias = normJson?.normalize?.canonicalByAlias || {};
  const drop = new Set((normJson?.normalize?.dropIfMatched || []).map(x => normalizeBang(x)));

  return function normalizeMag(raw){
    const x0 = normalizeBang(raw);
    if (!x0) return "";
    if (drop.has(x0)) return "";
    const x1 = alias[x0] ? normalizeBang(alias[x0]) : x0;
    if (drop.has(x1)) return "";
    return x1;
  };
}

function itMagazinesNormalized(it, normalizeMag){
  const ms = pickArr(it, ["magazines", "vol1.magazines"]).map(toText).filter(Boolean);
  if (ms.length) {
    const out = [];
    for (const m of ms) {
      const x = normalizeMag(m);
      if (x) out.push(x);
    }
    return Array.from(new Set(out));
  }
  const m1 = toText(pick(it, ["magazine", "vol1.magazine"]));
  const x = normalizeMag(m1);
  return x ? [x] : [];
}

function hasMagazineNormalized(it, wantedMag, normalizeMag){
  const w = normalizeMag(wantedMag);
  if (!w) return true;
  const ms = itMagazinesNormalized(it, normalizeMag);
  return ms.includes(w);
}

function countByMag(items, normalizeMag){
  const map = new Map(); // mag -> count(作品数)
  for (const it of (items || [])) {
    const mags = itMagazinesNormalized(it, normalizeMag);
    if (!mags.length) continue;
    for (const m of mags) map.set(m, (map.get(m) || 0) + 1);
  }
  return map;
}

/* =======================
 * List：Quick filters（既存）
 * ======================= */
const QUICK_FILTERS_PATH = BASE + "data/lane2/quick_filters.json";
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
 * List: Facet UI（ジャンル/カテゴリー/連載誌）
 * ======================= */

function renderFacetFilters({ allItems, magNormJson, onChange }) {
  const root = document.getElementById("facetFilters");
  const hint = document.getElementById("facetHint");
  if (!root) return;

  const genreIds = parseGenreQueryIds();
  const audSelected = parseAudQuery();  // "" = 全部
  const magSelectedRaw = parseMagQuery();

  const norm = magNormJson || {};
  const normalizeMag = buildMagNormalizer(norm);

  // --- カテゴリ表示ラベル（JSON側 label を優先）
  const audLabelMap = new Map();
  for (const t of HOME_CATEGORY_TABS) audLabelMap.set(t.value, t.label);
  try{
    const auds = norm?.audiences || {};
    for (const k of Object.keys(auds)) {
      const lb = toText(auds[k]?.label);
      if (lb) audLabelMap.set(k, lb); // ここで「その他」→「Web/アプリ」
    }
  }catch{}

  // --- 連載誌候補：選択audの primary/more（Web/アプリは aud=その他 のときだけ webGroup を使う）
  function magsForAudience(aud) {
    const auds = norm?.audiences || {};
    const webGroup = norm?.webGroup || null;

    const onlyPrintForAll = () => {
      const setP = new Set();
      const setM = new Set();
      for (const key of Object.keys(auds)) {
        const a = auds[key] || {};
        for (const x of (a.primary || [])) setP.add(normalizeMag(x));
        for (const x of (a.more || [])) setM.add(normalizeMag(x));
      }
      const primary = Array.from(setP).filter(Boolean);
      const more = Array.from(setM).filter(Boolean).filter(x => !setP.has(x));
      return { primary, more, web: [] };
    };

    // aud=""（全部）: 印刷系だけ union（Web/アプリは混ぜない）
    if (!aud) return onlyPrintForAll();

    const a = auds[aud] || {};
    const primary = (a.primary || []).map(normalizeMag).filter(Boolean);
    const moreBase = (a.more || []).map(normalizeMag).filter(Boolean);
    const pSet = new Set(primary);
    const more = Array.from(new Set(moreBase)).filter(x => !pSet.has(x));

    // Web/アプリカテゴリ（aud=その他）だけ webGroup を表示
    let web = [];
    if (aud === WEBAPP_AUD_VALUE && webGroup?.items?.length) {
      web = webGroup.items.map(normalizeMag).filter(Boolean);
      // primary/more と重複排除
      const used = new Set([...primary, ...more]);
      web = Array.from(new Set(web)).filter(x => !used.has(x));
    }

    return { primary, more, web };
  }

  // --- 連載誌カウント（mag未選択の状態での候補数）
  // 母集団：allItems を (genreIds + audSelected) で絞ったもの（magは無視）
  const baseForMag = (allItems || [])
    .filter(it => hasAnyGenreByTabIds(it, genreIds))
    .filter(it => (audSelected ? hasAudience(it, audSelected) : true));

  const magCounts = countByMag(baseForMag, normalizeMag);
  const mags = magsForAudience(audSelected);
  const magSelected = normalizeMag(magSelectedRaw);

  // --- UI：ジャンル（ボタン）
  const genreButtons = HOME_GENRE_TABS.map(t => {
    const on = genreIds.includes(t.id);
    return `<button type="button" class="pill ${on ? "is-on" : ""}" data-genreid="${esc(t.id)}" aria-pressed="${on ? "true" : "false"}">${esc(t.label)}</button>`;
  }).join("");

  // --- UI：カテゴリー（ボタン）+ 全部
  const audButtons = HOME_CATEGORY_TABS.map(t => {
    const label = audLabelMap.get(t.value) || t.value;
    const on = (audSelected === t.value);
    return `<button type="button" class="pill ${on ? "is-on" : ""}" data-aud="${esc(t.value)}" aria-pressed="${on ? "true" : "false"}">${esc(label)}</button>`;
  }).join("");

  const audAllOn = !audSelected;
  const audAllBtn = `<button type="button" class="pill ${audAllOn ? "is-on" : ""}" data-aud="" aria-pressed="${audAllOn ? "true" : "false"}">全部</button>`;

  // --- UI：連載誌（プルダウン / optgroup / 件数表示）
  function opt(label, value, n, selected){
    const txt = n > 0 ? `${label} (${n})` : label;
    return `<option value="${esc(value)}" ${selected ? "selected" : ""}>${esc(txt)}</option>`;
  }
  function group(label, optionsHtml){
    if (!optionsHtml) return "";
    return `<optgroup label="${esc(label)}">${optionsHtml}</optgroup>`;
  }

  const optAll = opt("全部", "", 0, !magSelected);

  const primaryOpts = (mags.primary || [])
    .map(m => opt(m, m, (magCounts.get(m) || 0), (magSelected && m === magSelected)))
    .join("");

  const moreOpts = (mags.more || [])
    .map(m => opt(m, m, (magCounts.get(m) || 0), (magSelected && m === magSelected)))
    .join("");

  const webLabel = audLabelMap.get(WEBAPP_AUD_VALUE) || "Web/アプリ";
  const webOpts = (mags.web || [])
    .map(m => opt(m, m, (magCounts.get(m) || 0), (magSelected && m === magSelected)))
    .join("");

  root.innerHTML = `
    <div style="display:grid; gap:10px;">
      <div>
        <div class="status" style="margin:0 0 6px 0;">ジャンル</div>
        <div class="pills" id="facetGenres">${genreButtons}</div>
      </div>

      <div>
        <div class="status" style="margin:0 0 6px 0;">カテゴリー</div>
        <div class="pills" id="facetAud">
          ${audButtons}
          ${audAllBtn}
        </div>
      </div>

      <div>
        <div class="status" style="margin:0 0 6px 0;">連載誌</div>
        <select id="facetMag" style="width:100%; padding:10px 12px; border:1px solid rgba(0,0,0,.12); border-radius:12px; background:#fff;">
          ${optAll}
          ${group("主要", primaryOpts)}
          ${group("もっと見る", moreOpts)}
          ${group(webLabel, webOpts)}
        </select>
      </div>
    </div>
  `;

  // hint（ユーザー向け表記）
  if (hint) {
    const parts = [];

    if (genreIds.length) {
      const labels = genreIds
        .map(id => HOME_GENRE_TABS.find(t => t.id === id)?.label || id)
        .filter(Boolean);
      if (labels.length) parts.push(`ジャンル：${labels.join(" / ")}`);
    }

    if (audSelected) {
      const lb = audLabelMap.get(audSelected) || audSelected;
      parts.push(`カテゴリー：${lb}`);
    }

    if (magSelected) {
      parts.push(`連載誌：${magSelected}`);
    }

    hint.textContent = parts.length ? `絞り込み中：${parts.join(" / ")}` : "";
  }

  const clear = document.getElementById("facetClearLink");
  if (clear) {
    clear.onclick = (ev) => {
      ev.preventDefault();
      setGenreQueryIds([]);
      setAudQuery("");
      setMagQuery("");
      onChange?.({ reason: "facet_clear" });
    };
  }

  const gWrap = document.getElementById("facetGenres");
  if (gWrap) {
    gWrap.onclick = (ev) => {
      const btn = ev.target?.closest?.("button[data-genreid]");
      if (!btn) return;
      const id = btn.getAttribute("data-genreid") || "";
      if (!id) return;
      const cur = new Set(parseGenreQueryIds());
      if (cur.has(id)) cur.delete(id);
      else cur.add(id);
      setGenreQueryIds(Array.from(cur));
      // genre変更時は mag を解除（別ジャンルのmagが残ると0件になりやすい）
      setMagQuery("");
      onChange?.({ reason: "genre" });
    };
  }

  const aWrap = document.getElementById("facetAud");
  if (aWrap) {
    aWrap.onclick = (ev) => {
      const btn = ev.target?.closest?.("button[data-aud]");
      if (!btn) return;
      const a = btn.getAttribute("data-aud") || "";
      const now = parseAudQuery();
      const next = (now === a) ? "" : a;
      setAudQuery(next);
      // aud切替時は mag も解除
      setMagQuery("");
      onChange?.({ reason: "aud" });
    };
  }

  const magSel = document.getElementById("facetMag");
  if (magSel) {
    magSel.onchange = () => {
      setMagQuery(magSel.value || "");
      onChange?.({ reason: "mag" });
    };
  }
}

/* =======================
 * List: list_filter event helper
 * ======================= */
function trackListFilterState({ genreIds, aud, mag, moodIds, sortKey }) {
  const g = (genreIds || []).map(toText).filter(Boolean).join(",");
  const a = toText(aud);
  const m = toText(mag);
  const mood = (moodIds || []).map(toText).filter(Boolean).join(",");
  const s = toText(sortKey);

  const moodVal = mood ? `mood=${mood}` : "";
  const sortVal = s ? `sort=${s}` : "";
  const stateKey = `list_filter:${g}|${a}|${m}|${moodVal}|${sortVal}`;
  if (!canSendOnce(stateKey, 5000)) return false;

  trackEvent({
    type: "list_filter",
    page: "list",
    seriesKey: "",
    mood: moodVal,
    genre: g ? `genre=${g}` : "",
    aud: a ? `aud=${a}` : "",
    mag: m ? `mag=${m}` : "",
    k: "sort",
    v: s,
  });
  return true;
}

/* =======================
 * List: pagination state (50 + more)
 * ======================= */
const LIST_PAGE_SIZE = 50;
let __listVisibleLimit = LIST_PAGE_SIZE;
function resetListVisibleLimit() { __listVisibleLimit = LIST_PAGE_SIZE; }
function addListVisibleLimit() { __listVisibleLimit += LIST_PAGE_SIZE; }

/* =======================
 * List sort helpers
 * ======================= */
function buildCountMapFromMetricJson(json) {
  const rows = Array.isArray(json?.rows) ? json.rows
    : Array.isArray(json?.data) ? json.data
    : Array.isArray(json) ? json : [];

  const map = new Map(); // sk -> n
  for (const r of rows) {
    const sk = toText(r?.seriesKey);
    const n = Number(r?.n || 0);
    if (!sk) continue;
    map.set(sk, Number.isFinite(n) ? n : 0);
  }
  return map;
}
function byTitleAsc(a, b) {
  const ta = toText(pick(a, ["seriesKey", "title", "vol1.title"]));
  const tb = toText(pick(b, ["seriesKey", "title", "vol1.title"]));
  return ta.localeCompare(tb, "ja");
}
function getReleaseMs(it) {
  const s = pick(it, ["releaseDate", "vol1.releaseDate"]);
  return toTimeMsFromYmd(s);
}

/* =======================
 * List render（author/synopsis は出さない）
 * - perf: 段階描画
 * ======================= */
function renderList(items, quickDefs, magNormJson, opt = {}) {
  const root = document.getElementById("list");
  if (!root) return;

  const all = Array.isArray(items) ? items : [];
  const norm = magNormJson || {};
  const normalizeMag = buildMagNormalizer(norm);

  const viewsMap = opt?.viewsMap instanceof Map ? opt.viewsMap : new Map();
  const risingMap = opt?.risingMap instanceof Map ? opt.risingMap : new Map();

  // ✅ Facet UI
  renderFacetFilters({
    allItems: all,
    magNormJson: norm,
    onChange: ({ reason } = {}) => {
      resetListVisibleLimit();
      // facet change -> list_filter (moodは現状維持で送る)
      trackListFilterState({
        genreIds: parseGenreQueryIds(),
        aud: parseAudQuery(),
        mag: parseMagQuery(),
        moodIds: parseMoodQuery(),
        sortKey: parseSortQuery(),
      });
      renderList(all, quickDefs, norm, opt);
      refreshFavButtons(document);
    },
  });

  // ✅ Sort UI
  const sortSel = document.getElementById("sortSelect");
  const sortKey = parseSortQuery();

  // 急上昇が無いなら選べない（UI側：disable）
  if (sortSel) {
    try {
      sortSel.value = sortKey;
      const riseOpt = sortSel.querySelector?.("option[value='rise']");
      if (riseOpt) riseOpt.disabled = !(risingMap && risingMap.size);
      sortSel.onchange = () => {
        const next = toText(sortSel.value);
        resetListVisibleLimit();
        setSortQuery(SORT_KEYS.includes(next) ? next : "pop");

        trackListFilterState({
          genreIds: parseGenreQueryIds(),
          aud: parseAudQuery(),
          mag: parseMagQuery(),
          moodIds: parseMoodQuery(),
          sortKey: parseSortQuery(),
        });

        renderList(all, quickDefs, norm, opt);
        refreshFavButtons(document);
      };
    } catch {}
  }

  const genreIds = parseGenreQueryIds();
  const audienceWanted = parseAudQuery();     // ""=全部
  const magazineWanted = parseMagQuery();     // ""=全部

  const moodSelected = parseMoodQuery();
  const byId = new Map((quickDefs || []).map(d => [d.id, d]));
  const moodActiveDefs = moodSelected.map(id => byId.get(id)).filter(Boolean);

  const base = all
    .filter(it => hasAnyGenreByTabIds(it, genreIds))
    .filter(it => (audienceWanted ? hasAudience(it, audienceWanted) : true))
    .filter(it => hasMagazineNormalized(it, magazineWanted, normalizeMag));

    // ✅ ヒット理由（一致タグ）を取る：優先順位は quick_filters.json の順
  function pickReasonTags(it, defs, max = 3) {
    const tagSet = new Set(itTags(it));
    if (!defs?.length || !tagSet.size) return [];

    const out = [];
    const seen = new Set();

    for (const def of defs) {
      const anyTags = toTagList(def?.matchAny?.tags || []);
      for (const t of anyTags) {
        if (!tagSet.has(t)) continue;
        if (seen.has(t)) continue;
        seen.add(t);
        out.push(t);
        if (out.length >= max) return out;
      }
    }
    return out;
  }

  // --- mood filter (絞り込み) + 理由タグ保持
  const scored = [];
  if (moodActiveDefs.length) {
    for (const it of base) {
      const r = quickEvalAll(it, moodActiveDefs);
      if (!r.ok) continue;
      scored.push({
        it,
        score: r.score,
        reasons: pickReasonTags(it, moodActiveDefs, 3),
      });
    }
  } else {
    for (const it of base) scored.push({ it, score: 0, reasons: [] });
  }

  // --- sort (並び替え)
  // 仕様：気分フィルター中でも sort=pop のときだけスコア順を初期挙動として維持。
  //       sortがpop以外に変わったらソート優先（気分は絞り込み条件のみ）。
  if (moodActiveDefs.length && sortKey === "pop") {
    scored.sort((a, b) => (b.score - a.score) || byTitleAsc(a.it, b.it));
  } else {
    if (sortKey === "new") {
      scored.sort((a, b) => (getReleaseMs(b.it) - getReleaseMs(a.it)) || byTitleAsc(a.it, b.it));
    } else if (sortKey === "rise") {
      scored.sort((a, b) => (
        (risingMap.get(toText(pick(b.it, ["seriesKey"]))) || 0) -
        (risingMap.get(toText(pick(a.it, ["seriesKey"]))) || 0)
      ) || byTitleAsc(a.it, b.it));
    } else {
      // pop
      scored.sort((a, b) => (
        (viewsMap.get(toText(pick(b.it, ["seriesKey"]))) || 0) -
        (viewsMap.get(toText(pick(a.it, ["seriesKey"]))) || 0)
      ) || byTitleAsc(a.it, b.it));
    }
  }

  // ✅ 以降は「it配列」ではなく「{it, score, reasons}配列」を使う
  const outItemsAll = scored;

  // ✅ mood clear
  const clear = document.getElementById("moodClearLink");
  if (clear) {
    clear.onclick = (ev) => {
      ev.preventDefault();
      resetListVisibleLimit();
      setMoodQuery([]);

      trackListFilterState({
        genreIds,
        aud: audienceWanted,
        mag: magazineWanted,
        moodIds: [],
        sortKey: parseSortQuery(),
      });

      renderList(all, quickDefs, norm, opt);
      refreshFavButtons(document);
    };
  }

  // ✅ quick filters UI
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

      resetListVisibleLimit();

      const cur = parseMoodQuery();
      const set = new Set(cur);
      if (set.has(id)) set.delete(id);
      else {
        if (set.size >= QUICK_MAX) return;
        set.add(id);
      }
      const next = Array.from(set);

      trackListFilterState({
        genreIds,
        aud: audienceWanted,
        mag: magazineWanted,
        moodIds: next,
        sortKey: parseSortQuery(),
      });

      setMoodQuery(next);
      renderList(all, quickDefs, norm, opt);
      refreshFavButtons(document);
    };

    const hint = document.getElementById("quickFiltersHint");
    if (hint) {
      if (!moodSelected.length) hint.textContent = "";
      else hint.innerHTML = `気分: <b>${esc(moodSelected.map(id => byId.get(id)?.label || id).join(" × "))}</b>（AND / 最大2）`;
    }
  }

  // ---- empty ----
  if (!outItemsAll.length) {
    root.innerHTML = `<div class="status">表示できる作品がありません</div>`;
    const countEl = document.getElementById("listCount");
    if (countEl) countEl.textContent = "0件";
    const moreWrap = document.getElementById("listMoreWrap");
    if (moreWrap) moreWrap.style.display = "none";
    return;
  }

  // ---- pagination (50 + more) ----
  const visible = outItemsAll.slice(0, Math.max(0, __listVisibleLimit));
  const countEl = document.getElementById("listCount");
  if (countEl) countEl.textContent = `${outItemsAll.length}件`; // ✅ 全ヒット数

  const moreWrap = document.getElementById("listMoreWrap");
  const moreBtn = document.getElementById("listMoreBtn");
  const canMore = outItemsAll.length > visible.length;

  if (moreWrap) moreWrap.style.display = canMore ? "" : "none";

  // ✅ もっと見る：リストDOMを作り直さず append（スクロール位置固定）
  if (moreBtn) {
    moreBtn.onclick = (ev) => {
      try { ev?.preventDefault?.(); } catch {}
      try { moreBtn.blur?.(); } catch {}

      const prevVisibleLen = visible.length;

      addListVisibleLimit();
      renderList(all, quickDefs, norm, { ...opt, appendFrom: prevVisibleLen });
      refreshFavButtons(document);
    };
  }

  // ---- render ----
  const appendFrom = Number(opt?.appendFrom || 0);

  if (!appendFrom) {
    root.innerHTML = "";
  }

  const BATCH = 36;
  let i = appendFrom;

    function itemHtml(row) {
    // row = { it, score, reasons }
    const it = row?.it || {};
    const score = Number(row?.score || 0);
    const reasons = Array.isArray(row?.reasons) ? row.reasons : [];

    const seriesKey = toText(pick(it, ["seriesKey"])) || "";
    const title = toText(pick(it, ["title", "vol1.title"])) || seriesKey || "(無題)";

    const imgRaw = toText(pick(it, ["image", "vol1.image"])) || "";
    const img = normalizeImgUrl(imgRaw);

    const amzRaw = toText(pick(it, ["amazonDp", "vol1.amazonDp", "amazonUrl", "vol1.amazonUrl"])) || "#";
    const amz = ensureAmazonAffiliate(amzRaw);

    const tagsJa = pickArr(it, ["tags", "vol1.tags"]).map(toText).filter(Boolean);

    // 表示用の連載誌：正規化して first
    const mags = itMagazinesNormalized(it, normalizeMag);
    const mag = mags[0] || "";

    // ✅ 気分フィルター中だけ「ヒット理由」を表示
    const showReason = !!moodActiveDefs.length;
    const reasonHtml = showReason
      ? `
        <div class="sub">ヒット理由${score ? `（一致 ${esc(score)}）` : ""}</div>
        ${reasons.length ? pillsMax6(reasons) : `<div class="sub" style="opacity:.7;">（一致タグなし）</div>`}
      `
      : "";

    return `
      <article class="card" data-sk="${esc(seriesKey)}">
        <div class="card-row">
          <div class="thumb">
            ${
              img
                ? `<a href="${esc(workStaticUrl(seriesKey))}" aria-label="${esc(title)}"><img src="${IMG_PLACEHOLDER_SRC}" data-src="${esc(img)}" alt="${esc(title)}" loading="lazy" decoding="async"/></a>`
                : `<div class="thumb-ph"></div>`
            }
          </div>

          <div class="meta">
            <div class="title"><a href="${esc(workStaticUrl(seriesKey))}">${esc(seriesKey || title)}</a></div>

            ${mag ? `<div class="sub">連載誌: ${esc(mag)}</div>` : ""}

            ${reasonHtml}

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
    const end = Math.min(visible.length, i + BATCH);
    let html = "";
    for (; i < end; i++) html += itemHtml(visible[i]);

    if (html) root.insertAdjacentHTML("beforeend", html);

    initLazyImages(root);
    refreshFavButtons(document);

    if (i < visible.length) requestAnimationFrame(pump);
  }

  requestAnimationFrame(pump);
}

/* END PART 1/3 - token: C3D4 */

/* START PART 2/3 - token: C3D4 */

// public/app.js（2/3）FULL REPLACE
// - ✅ Work: 投票(読後感) + ★評価 + レコメンド を復元
// - ✅ metrics を読み込み、Work/ Home へ反映
// - ✅ List は (1/3) の renderList をそのまま利用（ここでは壊さない）
// - ✅ works split(index/shard) 対応維持
// - ✅ NEW: List sort metrics（人気/急上昇）を読み込み、renderList に渡す
// - ✅ NEW: Home「一覧を見る」リンクを、選択中タブに合わせて絞り込みリンクへ（既存機能は壊さない）
// - ✅ FIX: audiences が複数ある作品は該当カテゴリすべてに表示（銀魂対策）
//
// 🔥 NEW(今回の目的):
// - ✅ vote_by_series.json + vote_by_mood_series.json を読み込み
// - ✅ 投票が一定数(>=3)ある作品は「みんなの読後感（投票）」を常時表示（=正解データ）
//   それ未満は断定せず「投票が集まると表示」
// - ✅ 既存の「投票でアンロック」挙動は維持（導線として残す）
/* =======================
 * pills（(1/3) が pillsMax6 を呼ぶので必須）
 * ======================= */
function pillsMax6(list) {
  const xs = (list || []).map(toText).filter(Boolean);
  if (!xs.length) return "";
  const head = xs.slice(0, 6);
  const rest = xs.length - head.length;
  const more = rest > 0 ? `<span class="pill">+${rest}</span>` : "";
  return `<div class="pills">${head.map(x => `<span class="pill">${esc(x)}</span>`).join("")}${more}</div>`;
}
function pillsAll(list) {
  const xs = (list || []).map(toText).filter(Boolean);
  if (!xs.length) return "";
  return `<div class="pills">${xs.map(x => `<span class="pill">${esc(x)}</span>`).join("")}</div>`;
}

/* =======================
 * Works loader (index/shard)
 * ======================= */
function pad3(n){ return String(n).padStart(3, "0"); }

async function loadWorksIndex({ bust }) {
  const v = qs().get("v");
  const idxUrl = v ? `${WORKS_INDEX_PATH}?v=${encodeURIComponent(v)}` : WORKS_INDEX_PATH;

  const idx = await tryLoadJson(idxUrl, { bust });
  // ✅ 正：index.json は listItems を持つ想定
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
    synopsis: it?.synopsis ?? null,
    author: it?.author ?? null,
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
 * Toast
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
  el.style.opacity = "1";
  el.style.transform = "translateX(-50%) translateY(0)";

  __toastTimer = setTimeout(() => {
    el.style.opacity = "0";
    el.style.transform = "translateX(-50%) translateY(6px)";
  }, 1300);
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
 * Home：counts
 * ======================= */
function genreCountMap(allItems) {
  const map = new Map();
  for (const t of HOME_GENRE_TABS) map.set(t.id, 0);
  for (const it of allItems) {
    for (const t of HOME_GENRE_TABS) {
      if (hasAnyGenreByTabId(it, t.id)) map.set(t.id, (map.get(t.id) || 0) + 1);
    }
  }
  return map;
}

/* ✅ FIX: 複数audiencesは該当カテゴリすべてにカウント */
function categoryCountMap(allItems) {
  const map = new Map();
  for (const t of HOME_CATEGORY_TABS) map.set(t.id, 0);

  for (const it of (allItems || [])) {
    for (const t of HOME_CATEGORY_TABS) {
      if (hasAudience(it, t.value)) {
        map.set(t.id, (map.get(t.id) || 0) + 1);
      }
    }
  }
  return map;
}

/* =======================
 * Home：カード列
 * ======================= */
function renderCardRow({ items, limit = 18, moreHref = "" }) {
  const cards = (items || []).slice(0, limit).map((it) => {
    const seriesKey = toText(pick(it, ["seriesKey"])) || "";
    const title = toText(pick(it, ["title", "vol1.title"])) || seriesKey || "(無題)";
    const imgRaw = toText(pick(it, ["image", "vol1.image"])) || "";
    const img = normalizeImgUrl(imgRaw);

    return `
      <a class="row-card" href="${esc(workStaticUrl(seriesKey))}">
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

  const pickedAll = all.filter(it => hasAnyGenreByTabId(it, active.id));
  const picked = shuffleWithSeed(pickedAll, `genre:${active.id}:${daySeedStr()}`);

  const v = qs().get("v");
  const moreHref = `${BASE}list.html?genre=${encodeURIComponent(active.id)}` + (v ? `&v=${encodeURIComponent(v)}` : "");

  // ✅ NEW: 右上「一覧を見る」も選択中ジャンルで絞り込みリンクへ
  try {
    const allLink = document.getElementById("genreAllLink");
    if (allLink) allLink.setAttribute("href", moreHref);
  } catch {}

  row.innerHTML = renderCardRow({ items: picked, limit: 18, moreHref });
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

  /* ✅ FIX: audiences が複数ある作品も該当カテゴリに出す */
  const pickedAll = all.filter(it => hasAudience(it, audValue));
  const picked = shuffleWithSeed(pickedAll, `aud:${active.id}:${daySeedStr()}`);

  const v = qs().get("v");
  const moreHref = `${BASE}list.html?aud=${encodeURIComponent(audValue)}` + (v ? `&v=${encodeURIComponent(v)}` : "");

  // ✅ NEW: 右上「一覧を見る」も選択中カテゴリで絞り込みリンクへ
  try {
    const allLink = document.getElementById("audienceAllLink");
    if (allLink) allLink.setAttribute("href", moreHref);
  } catch {}

  row.innerHTML = renderCardRow({ items: picked, limit: 18, moreHref });
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
 * Home：人気ランキング（閲覧数）
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

/* END PART 2/3 - token: C3D4 */

/* START PART 3/3 - token: C3D4 */

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

  root.innerHTML = `
    <div class="home-rank-grid">
      ${ranked.map((r, idx) => {
        const it = byKey.get(r.seriesKey);
        const title = toText(pick(it, ["title", "vol1.title"])) || r.seriesKey || "(無題)";
        const imgRaw = toText(pick(it, ["image", "vol1.image"])) || "";
        const img = normalizeImgUrl(imgRaw);

        return `
          <a class="home-rank-item" href="${esc(workStaticUrl(r.seriesKey))}" aria-label="${esc(title)}">
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
 * ✅ Home：読後感で探す（renderQuickHome）
 * ======================= */
function renderQuickHome({ defs, counts }) {
  const root = document.getElementById("quickFiltersHome");
  if (!root) return;

  const ds = Array.isArray(defs) ? defs : [];
  if (!ds.length) {
    root.innerHTML = `<div class="status">データがまだありません</div>`;
    return;
  }

  const v = qs().get("v");
  const countMap = (counts instanceof Map) ? counts : new Map();

  root.innerHTML = `
    <div class="pills">
      ${ds.map(d => {
        const id = toText(d?.id);
        const label = toText(d?.label) || id;
        const n = Number(countMap.get(id) || 0);
        const href = `${BASE}list.html?mood=${encodeURIComponent(id)}` + (v ? `&v=${encodeURIComponent(v)}` : "");
        return `
          <a class="pill" href="${esc(href)}" aria-label="${esc(label)}">
            ${esc(label)}
            <span style="opacity:.7;">（${Number.isFinite(n) ? n : 0}）</span>
          </a>
        `;
      }).join("")}
    </div>
  `;
}

/* =======================
 * Home：★ランキング（おすすめ度 / 作画）
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
function renderHomeRateTop({ rootId, rows, itemsByKey, limit = 6 }) {
  const root = document.getElementById(rootId);
  if (!root) return;

  const xs = (rows || []).filter(Boolean).slice(0, limit).filter(r => itemsByKey.has(r.seriesKey));
  if (!xs.length) {
    root.innerHTML = `<div class="status">データがまだありません</div>`;
    return;
  }

  root.innerHTML = `
    <div class="home-rank-grid">
      ${xs.map((r, idx) => {
        const it = itemsByKey.get(r.seriesKey);
        const title = toText(pick(it, ["title", "vol1.title"])) || r.seriesKey || "(無題)";
        const imgRaw = toText(pick(it, ["image", "vol1.image"])) || "";
        const img = normalizeImgUrl(imgRaw);

        return `
          <a class="home-rank-item" href="${esc(workStaticUrl(r.seriesKey))}" aria-label="${esc(title)}">
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
 * Work：rate_by_series_key
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
 * Work：base64url helpers (work key)
 * ======================= */
function resolveWorkKey() {
  const p = qs();
  let key = toText(p.get("key"));
  if (key) return key;

  if (location.pathname.includes("/work/")) {
    const parts = location.pathname.split("/").filter(Boolean);
    const id = parts[parts.length - 1] || "";
    if (id) {
      try{
        const b64 = id.replace(/-/g, "+").replace(/_/g, "/");
        const pad = b64.length % 4 ? "=".repeat(4 - (b64.length % 4)) : "";
        const bin = atob(b64 + pad);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        key = new TextDecoder("utf-8").decode(bytes);
      }catch{ key = ""; }
    }
  }
  return toText(key);
}

function canonicalizeWorkToStatic() {
  try{
    if (IS_STATIC_WORK) return;
    const hasDetail = !!document.getElementById("detail");
    if (!hasDetail) return;

    const key = toText(qs().get("key"));
    if (!key) return;

    // ✅ リロードして BASE を正しく再計算させる
    location.replace(workStaticUrl(key));
  }catch{}
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
 * Work unlock state（導線として維持）
 * ======================= */
const WORK_UNLOCK_PREFIX = "work_unlock:v2:";
function unlockKey(seriesKey){ return `${WORK_UNLOCK_PREFIX}${toText(seriesKey)}`; }
function isUnlocked(seriesKey){
  const sk = toText(seriesKey);
  if (!sk) return false;
  try { if (localStorage.getItem(unlockKey(sk)) === "1") return true; } catch {}
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
    return !prev;
  } catch {
    return true;
  }
}

/* =======================
 * Rating local state
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

function avgStarsHtmlCompact(seriesKey, rateSeriesMap){
  const MIN_N = 3;
  const rec = rateSeriesMap?.get?.(seriesKey)?.rec;
  const art = rateSeriesMap?.get?.(seriesKey)?.art;

  const recOk = rec?.avg && Number(rec?.n || 0) >= MIN_N;
  const artOk = art?.avg && Number(art?.n || 0) >= MIN_N;

  const recTxt = recOk ? `★${formatStarAvg(rec.avg)}` : "—";
  const artTxt = artOk ? `★${formatStarAvg(art.avg)}` : "—";

  return `
    <div style="display:grid; grid-template-columns: 1fr auto; align-items:center; margin-top:6px;">
      <div></div>
      <div style="font-size:12px; color: rgba(107,114,128,.9); font-weight:900;">平均</div>
    </div>

    <div style="display:grid; grid-template-columns: 1fr auto; align-items:center; padding:6px 0; border-top:1px solid rgba(17,24,39,.06);">
      <div style="font-size:12px; color: rgba(107,114,128,.9); font-weight:900;">おすすめ度</div>
      <div style="font-size:13px; font-weight:1000; font-variant-numeric: tabular-nums;">${recTxt}</div>
    </div>

    <div style="display:grid; grid-template-columns: 1fr auto; align-items:center; padding:6px 0; border-top:1px solid rgba(17,24,39,.06);">
      <div style="font-size:12px; color: rgba(107,114,128,.9); font-weight:900;">作画クオリティ</div>
      <div style="font-size:13px; font-weight:1000; font-variant-numeric: tabular-nums;">${artTxt}</div>
    </div>
  `;
}

/* =======================
 * ✅ Vote aggregates（正解データ：常時表示用）
 * ======================= */
const VOTE_AGG_PATH = BASE + "data/metrics/wae/vote_by_mood_series.json";
const VOTE_TOTAL_BY_SERIES_PATH = BASE + "data/metrics/wae/vote_by_series.json";

// ✅ “正解データ”に格上げする閾値
const MOOD_VOTE_MIN = 3;

// 既存：類似作品（投票ベクトル）用
const VOTE_MIN_TOTAL = 5;

function buildVoteMatrix(voteRows) {
  const rows = Array.isArray(voteRows?.rows) ? voteRows.rows
    : Array.isArray(voteRows?.data) ? voteRows.data
    : Array.isArray(voteRows) ? voteRows
    : [];

  const bySeries = new Map(); // sk -> Map(mood -> n)
  const totals = new Map();   // sk -> total（内訳から合算）

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

// ✅ vote_by_series.json を Map 化（総票の一次ソース）
function buildVoteTotalBySeries(json){
  const rows = Array.isArray(json?.rows) ? json.rows
    : Array.isArray(json?.data) ? json.data
    : Array.isArray(json) ? json : [];

  const map = new Map(); // sk -> totalVotes
  for (const r of rows) {
    const sk = toText(r?.seriesKey);
    const n = Number(r?.n || 0);
    if (!sk) continue;
    map.set(sk, Number.isFinite(n) ? n : 0);
  }
  return map;
}

/* =======================
 * Work: mood top helper（投票の表示）
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

function moodTopHtmlFromMatrix({ seriesKey, voteMatrix, defs, max = 4, hideCounts = false }){
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
      ${rows.map(r => `<span class="pill">${esc(r.label)}${hideCounts ? "" : ` <span style="opacity:.7;">(${r.n})</span>`}</span>`).join("")}
    </div>
  `;
}

// ✅ “正解データ”として常時表示するブロック（閾値未満は断定しない）
function moodTruthBlockHtml({ seriesKey, defs, voteMatrix, voteTotalBySeries }) {
  const sk = toText(seriesKey);
  if (!sk) return "";

  const total = Number(voteTotalBySeries?.get?.(sk) || 0);

  // 閾値未満：断定しない
  if (!Number.isFinite(total) || total < MOOD_VOTE_MIN) {
    const t = Number.isFinite(total) ? total : 0;
    return `
      <div class="vote-box" style="margin-top:12px;">
        <div class="vote-head">
          <h3 class="vote-title">みんなの読後感（投票）</h3>
        </div>
        <p class="vote-note">投票が集まるほど、ここが“正解データ”として育ちます。</p>
        <div class="d-sub" style="opacity:.85;">投票が集まると表示されます（現在 ${t}票）</div>
      </div>
    `;
  }

  // 閾値以上：上位を表示
  const pills = moodTopHtmlFromMatrix({ seriesKey: sk, voteMatrix, defs, max: 4, hideCounts: false });
  return `
    <div class="vote-box" style="margin-top:12px;">
      <div class="vote-head">
        <h3 class="vote-title">みんなの読後感（投票）</h3>
      </div>
      <p class="vote-note">投票${total}票分の集計です。</p>
      ${pills || `<div class="d-sub" style="opacity:.85;">データがまだありません</div>`}
    </div>
  `;
}

/* =======================
 * Vote similar reco（既存）
 * ======================= */
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
function clamp3(arr){ return (arr || []).filter(Boolean).slice(0, 3); }

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
    <div class="mini-row">
      ${xs.map(x => `
        <a class="mini-card" href="${esc(workStaticUrl(x.seriesKey))}">
          <div class="mini-cover">
            ${
              x.img
                ? `<img src="${IMG_PLACEHOLDER_SRC}" data-src="${esc(x.img)}" alt="${esc(x.title)}" loading="lazy" decoding="async">`
                : `<div class="thumb-ph"></div>`
            }
          </div>
          <div class="mini-title">${esc(x.seriesKey || x.title)}</div>
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
          <a class="rec-item" href="${esc(workStaticUrl(x.seriesKey))}" aria-label="${esc(x.title)}">
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
/* ✅ FIX: 順序ブレ対策で “代表audience” を使う */
function pickFirstAudience(it) {
  return pickMainAudience(it) || WEBAPP_AUD_VALUE;
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

    const v = viewsMap?.get?.(sk) || 0;
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
 * Work render (Phase1)
 * ======================= */
async function renderWorkPhase1(worksState, quickDefs) {
  const detail = document.getElementById("detail");
  if (!detail) return null;

  const key = resolveWorkKey();
  if (!key) return null;

  detail.innerHTML = `
    <div class="d-title">読み込み中…</div>
    <div class="d-sub">作品情報を読み込んでいます</div>
  `;

  const it = await loadWorkFullByKey({ worksState, key, bust: !!qs().get("v") });
  if (!it) {
    detail.innerHTML = `<div class="status">作品が見つかりません</div>`;
    return null;
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

  // ✅ “正解データ（投票）”は Phase2 で必ず差し込む（ここはプレースホルダ）
  const moodTruthPlaceholder = `<div id="moodTruthBlock"></div>`;

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

      <div class="vote-status" id="voteStatus"></div>
    </div>
  ` : "";

  const recVal = getRatedValue(seriesKey, "rec");
  const artVal = getRatedValue(seriesKey, "art");
  const hasStarVoted = !!(recVal || artVal);

  const rateBox = `
    <div class="vote-box" style="margin-top:12px;">
      <div class="vote-head">
        <h3 class="vote-title">評価</h3>
      </div>
      <p class="vote-note">★を選んで投票（各項目1回）。</p>

      <div id="avgStarsLocked" style="${hasStarVoted ? "display:none;" : ""}">
        <div class="d-sub" style="opacity:.85;">★を投票すると平均が表示されます。</div>
      </div>

      <div id="avgStarsUnlocked" style="${hasStarVoted ? "" : "display:none;"}">
        <div id="avgStarsBox" style="margin-top:10px; padding:10px 12px; border:1px solid rgba(17,24,39,.08); background: rgba(17,24,39,.02); border-radius: 14px;">
          <div class="d-sub" style="opacity:.8;">読み込み中…</div>
        </div>
      </div>

      ${starsHtml({ idPrefix: "rec", label: "おすすめ度", selected: recVal })}
      ${starsHtml({ idPrefix: "art", label: "作画クオリティ", selected: artVal })}
      <div class="vote-status" id="rateStatus"></div>
    </div>
  `;

  const recoHtml = `
    <div class="rec-wrap">
      <div id="recoTagsBlock" class="d-sub" style="opacity:.8;">おすすめを読み込み中…</div>
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

    ${moodTruthPlaceholder}
    ${voteBox}
    ${rateBox}
    ${recoHtml}
  `;

  initLazyImages(detail);
  trackWorkViewOnce(seriesKey);

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
      setUnlocked(seriesKey);
      try { window.__refreshWorkAfterVote?.(); } catch {}

      if (st) {
        st.textContent = sent ? "投票しました" : "投票済み（しばらくしてから）";
        setTimeout(() => { if (st) st.textContent = ""; }, 900);
      }
      showToast(sent ? "投票ありがとう！" : "投票済みです");
    };
  }

  // ✅ ★評価のクリック処理（これが抜けてた）
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

      // 平均表示を開放（投票後に表示）
      const locked = document.getElementById("avgStarsLocked");
      const unlockedEl = document.getElementById("avgStarsUnlocked");
      if (locked) locked.style.display = "none";
      if (unlockedEl) unlockedEl.style.display = "";

      try {
        const avgBox = document.getElementById("avgStarsBox");
        if (avgBox) avgBox.innerHTML = avgStarsHtmlCompact(seriesKey, window.__rateSeriesMap || new Map());
      } catch {}

      // 送信（端末内の重複抑止）
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
  return { it, seriesKey, defs };
}

/* =======================
 * Work hydrate (Phase2)
 * ======================= */
function hydrateWorkExtras({ it, seriesKey, defs, worksState, voteMatrix, voteTotalBySeries, rateSeriesMap, viewsMap }) {
  if (!it || !seriesKey) return;

  // ✅ “正解データ”の常時表示（閾値未満は断定しない）
  try{
    const mount = document.getElementById("moodTruthBlock");
    if (mount) {
      mount.outerHTML = moodTruthBlockHtml({
        seriesKey,
        defs,
        voteMatrix,
        voteTotalBySeries,
      });
    }
  } catch {}

  // ★平均
  try{
    const avgBox = document.getElementById("avgStarsBox");
    if (avgBox) avgBox.innerHTML = avgStarsHtmlCompact(seriesKey, rateSeriesMap);
  } catch {}

  // 同じ読後感（投票ベクトル類似）＋タグ類似＋同ジャンル×カテゴリ人気
  try{
    const root = document.getElementById("recoTagsBlock");
    if (root) {
      const allForReco = Array.isArray(worksState?.listItems) ? worksState.listItems : [];
      const df = getDfCached(allForReco);

            const unlocked = isUnlocked(seriesKey);

      const simByVotes = unlocked
        ? clamp3(voteSimilarTop3({ baseKey: seriesKey, allItems: allForReco, voteMatrix })).map(toRecItem)
        : [];

      const simByTags = clamp3(tagSimilarTop3({ baseIt: it, allItems: allForReco, df })).map(toRecItem);
      const popular = clamp3(popularSameGenreAudTop3({ baseIt: it, allItems: allForReco, viewsMap })).map(toRecItem);

      root.outerHTML = `
        ${unlocked ? recGridHtml("同じ読後感の作品", simByVotes) : ""}
        ${recGridHtml("似ている作品", simByTags)}
        ${recGridHtml("このジャンル×カテゴリーで人気", popular)}
      `;
    }
  } catch {}

  initLazyImages(document);
  refreshFavButtons(document);
}

/* =======================
 * metrics loader helpers
 * ======================= */
function withV(url){
  const v = qs().get("v");
  return v ? `${url}?v=${encodeURIComponent(v)}` : url;
}
function normalizeMetricRows(json){
  const rows = Array.isArray(json?.rows) ? json.rows
    : Array.isArray(json?.data) ? json.data
    : Array.isArray(json) ? json : [];
  return rows;
}

/* =======================
 * 先頭に戻るボタン
 * ======================= */
function ensureBackToTopButton() {
  if (document.getElementById("backToTop")) return;

  const btn = document.createElement("button");
  btn.id = "backToTop";
  btn.type = "button";
  btn.textContent = "↑";
  btn.setAttribute("aria-label", "ページの先頭に戻る");
  btn.style.cssText = `
    position: fixed;
    right: 14px;
    bottom: 14px;
    width: 44px;
    height: 44px;
    border-radius: 999px;
    border: 1px solid rgba(0,0,0,.15);
    background: rgba(255,255,255,.92);
    box-shadow: 0 10px 24px rgba(0,0,0,.18);
    z-index: 9999;
    display: none;
    font-size: 20px;
    line-height: 1;
  `;

  btn.onclick = () => {
    window.scrollTo({ top: 0, left: 0, behavior: "smooth" });
  };

  document.body.appendChild(btn);

  const SHOW_Y = 700;
  const onScroll = () => {
    const y = window.scrollY || 0;
    btn.style.display = (y >= SHOW_Y) ? "" : "none";
  };

  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();
}

/* =======================
 * run
 * ======================= */
async function run() {
  try {
    const v = qs().get("v");
    const bust = !!v;

    canonicalizeWorkToStatic();

    // works
    const worksState = await loadWorksIndex({ bust });

    // quick filters
    const quickUrl = v ? `${QUICK_FILTERS_PATH}?v=${encodeURIComponent(v)}` : QUICK_FILTERS_PATH;
    const quick = await loadJson(quickUrl, { bust });
    const quickDefs = Array.isArray(quick?.items) ? quick.items : [];

    // mag normalize（List用）
    const magNormUrl = v ? `${MAG_NORMALIZE_PATH}?v=${encodeURIComponent(v)}` : MAG_NORMALIZE_PATH;
    const magNormJson = await tryLoadJson(magNormUrl, { bust });

    // Work判定
    const isWorkPage = !!document.getElementById("detail");

    // ✅ Work: Phase1 先描画
    let workCtx = null;
    if (isWorkPage) {
      workCtx = await renderWorkPhase1(worksState, quickDefs);
    }

    // metrics 並列
    const pViews = (async () => {
      try {
        const viewUrl = withV(METRIC_WORK_VIEW_BY_SERIES_PATH);
        const viewJson = await loadJson(viewUrl, { bust });
        const rows = normalizeMetricRows(viewJson);
        return buildViewsMap(rows);
      } catch { return new Map(); }
    })();

    const pRising = (async () => {
      try {
        const riseUrl = withV(METRIC_RISING_WORK_VIEW_PATH);
        const riseJson = await tryLoadJson(riseUrl, { bust });
        if (!riseJson) return new Map();
        // 1/3 側 helper を使って Map 化
        return buildCountMapFromMetricJson(riseJson);
      } catch { return new Map(); }
    })();

    // ✅ vote matrix（内訳）+ total（総票）
    const pVote = (async () => {
      try {
        const voteUrl = withV(VOTE_AGG_PATH);
        const voteJson = await loadJson(voteUrl, { bust });
        return buildVoteMatrix(voteJson);
      } catch { return null; }
    })();

    const pVoteTotal = (async () => {
      try {
        const url = withV(VOTE_TOTAL_BY_SERIES_PATH);
        const json = await loadJson(url, { bust });
        return buildVoteTotalBySeries(json);
      } catch { return new Map(); }
    })();

    const pRateSeries = (async () => {
      try {
        const bySeriesJson = await tryLoadJson(withV(METRIC_RATE_BY_SERIES_KEY_PATH), { bust });
        return bySeriesJson ? buildRateBySeriesKeyMap(bySeriesJson) : new Map();
      } catch { return new Map(); }
    })();

    // ✅ Work: Phase2 hydrate
    if (isWorkPage && workCtx) {
      const [voteMatrix, voteTotalBySeries, rateSeriesMap] = await Promise.all([pVote, pVoteTotal, pRateSeries]);
      const viewsMap = await pViews;

      try { window.__rateSeriesMap = rateSeriesMap; } catch {}

            const args = {
        it: workCtx.it,
        seriesKey: workCtx.seriesKey,
        defs: workCtx.defs,
        worksState,
        voteMatrix,
        voteTotalBySeries,
        rateSeriesMap,
        viewsMap,
      };

      hydrateWorkExtras(args);

      // ✅ 投票後に「同じ読後感の作品」を再描画するために、必要な材料を保持
      try {
        window.__workHydrateArgs = args;
        window.__refreshWorkAfterVote = () => {
          try { hydrateWorkExtras(window.__workHydrateArgs); } catch {}
        };
      } catch {}

      patchAmazonAnchors(document);
      bindFavHandlers(document);
      refreshFavButtons(document);
      initLazyImages(document);
      setStatus("");
      return;
    }

    // ---- Home / List ----
    const [viewsMap, risingMap] = await Promise.all([pViews, pRising]);

    // rate top
    let rateRecTop = [];
    let rateArtTop = [];
    try {
      const recJson = await tryLoadJson(withV(METRIC_RATE_REC_TOP_PATH), { bust });
      rateRecTop = normalizeRateTopRows(recJson);
    } catch {}
    try {
      const artJson = await tryLoadJson(withV(METRIC_RATE_ART_TOP_PATH), { bust });
      rateArtTop = normalizeRateTopRows(artJson);
    } catch {}

    const itemsByKey = new Map();
    for (const it of (worksState.listItems || [])) {
      const sk = toText(pick(it, ["seriesKey"]));
      if (sk) itemsByKey.set(sk, it);
    }

    // Home
    if (document.getElementById("homePopular")) {
      renderHomePopular({ items: worksState.listItems, viewsMap, limit: 6 });
    }
    if (document.getElementById("homeRateRec")) {
      renderHomeRateTop({ rootId: "homeRateRec", rows: rateRecTop, itemsByKey, limit: 6 });
    }
    if (document.getElementById("homeRateArt")) {
      renderHomeRateTop({ rootId: "homeRateArt", rows: rateArtTop, itemsByKey, limit: 6 });
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
      try { if (typeof renderQuickHome === "function") renderQuickHome({ defs: quickDefs, counts }); } catch {}
    }

    // List（(1/3)）
    if (document.getElementById("list")) {
      renderList(worksState.listItems, quickDefs, magNormJson, { viewsMap, risingMap });
    }

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

/* =======================
 * screenshot mode (?ss=1)
 * ======================= */
(function () {
  try {
    if (new URLSearchParams(location.search).get("ss") === "1") {
      document.documentElement.setAttribute("data-ss", "1");
    }
  } catch {}
})();

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    ensureBackToTopButton();
    run();
  }, { once: true });
} else {
  ensureBackToTopButton();
  run();
}

/* END PART 3/3 - token: C3D4 */
