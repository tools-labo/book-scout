// public/app.js（1/2）FULL REPLACE
// - ✅ List: ジャンルは確定10本（日本語表示 / URLはid）
// - ✅ List: カテゴリー順固定（少年→青年→少女→女性→Web/アプリ→全部）
// - ✅ List: 連載誌は magazine_normalize.json から「主要 + もっと見る」をプルダウン（optgroup）/ 作品数表示
// - ✅ Web/アプリ連載誌は Web/アプリカテゴリ（aud=その他）にだけ表示（「全部」には混ぜない）
// - ✅ genre/mag URL互換（旧クエリ）を拾う
//
// 【分割ルール】
// - 1/2 はこの END マーカーで必ず終わる
// - 2/2 は START マーカーから必ず始める
// token: A1B2

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
 * - 値(value)は作品データの audiences(先頭) の値に合わせる（Web/アプリは value="その他" のまま）
 * - 表示ラベルは magazine_normalize.json の audiences[その他].label で上書き（=Web/アプリ）
 * ======================= */
const HOME_CATEGORY_TABS = [
  { id: "shonen", value: "少年", label: "少年" },
  { id: "seinen", value: "青年", label: "青年" },
  { id: "shojo", value: "少女", label: "少女" },
  { id: "josei", value: "女性", label: "女性" },
  { id: "webapp", value: "その他", label: "Web/アプリ" }, // 表示はJSONで上書きされる想定
];

const WEBAPP_AUD_VALUE = "その他"; // 作品データ上の値は固定（表示名だけWeb/アプリにする）

function getFirstAudienceLabel(it) {
  const arr = pickArr(it, ["audiences", "vol1.audiences"]).map(toText).filter(Boolean);
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
 * List：URL絞り込み（genre/aud/mag）
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
 * List：Facet UI（ジャンル/カテゴリー/連載誌）
 * - list.html 側に #facetFilters #facetHint #facetClearLink がある前提
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
    .filter(it => (audSelected ? (getFirstAudienceLabel(it) === audSelected) : true));

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
        <div class="status" style="margin:0 0 6px 0;">ジャンル（複数OK）</div>
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

  // hint
  if (hint) {
    const parts = [];
    if (genreIds.length) parts.push(`genre=${genreIds.map(id => HOME_GENRE_TABS.find(t => t.id === id)?.label || id).join(",")}`);
    if (audSelected) parts.push(`aud=${audLabelMap.get(audSelected) || audSelected}`);
    if (magSelected) parts.push(`mag=${magSelected}`);
    hint.textContent = parts.length ? `現在: ${parts.join(" / ")}` : "";
  }

  const clear = document.getElementById("facetClearLink");
  if (clear) {
    clear.onclick = (ev) => {
      ev.preventDefault();
      setGenreQueryIds([]);
      setAudQuery("");
      setMagQuery("");
      onChange?.();
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
      onChange?.();
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
      onChange?.();
    };
  }

  const magSel = document.getElementById("facetMag");
  if (magSel) {
    magSel.onchange = () => {
      setMagQuery(magSel.value || "");
      onChange?.();
    };
  }
}

/* =======================
 * List render（author/synopsis は出さない）
 * - perf: 段階描画
 * ======================= */
function renderList(items, quickDefs, magNormJson) {
  const root = document.getElementById("list");
  if (!root) return;

  const all = Array.isArray(items) ? items : [];
  const norm = magNormJson || {};
  const normalizeMag = buildMagNormalizer(norm);

  // ✅ Facet UI
  renderFacetFilters({
    allItems: all,
    magNormJson: norm,
    onChange: () => {
      renderList(all, quickDefs, norm);
      refreshFavButtons(document);
    },
  });

  const genreIds = parseGenreQueryIds();
  const audienceWanted = parseAudQuery();     // ""=全部
  const magazineWanted = parseMagQuery();     // ""=全部

  const moodSelected = parseMoodQuery();
  const byId = new Map((quickDefs || []).map(d => [d.id, d]));
  const moodActiveDefs = moodSelected.map(id => byId.get(id)).filter(Boolean);

  const base = all
    .filter(it => hasAnyGenreByTabIds(it, genreIds))
    .filter(it => (audienceWanted ? (getFirstAudienceLabel(it) === audienceWanted) : true))
    .filter(it => hasMagazineNormalized(it, magazineWanted, normalizeMag));

  function trackListFilterState(nextMoodIds) {
    const g = (genreIds || []).map(toText).filter(Boolean).join(",");
    const a = toText(audienceWanted);
    const m = toText(magazineWanted);
    const mood = (nextMoodIds || []).map(toText).filter(Boolean).join(",");

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

  const clear = document.getElementById("moodClearLink");
  if (clear) {
    clear.onclick = (ev) => {
      ev.preventDefault();
      trackListFilterState([]);
      setMoodQuery([]);
      renderList(all, quickDefs, norm);
      refreshFavButtons(document);
    };
  }

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
      trackListFilterState(next);

      setMoodQuery(next);
      renderList(all, quickDefs, norm);
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

  root.innerHTML = "";
  const BATCH = 36;
  let i = 0;

  function itemHtml(it) {
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

    return `
      <article class="card">
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

    if (i < outItems.length) requestAnimationFrame(pump);
  }

  requestAnimationFrame(pump);
}

/* END PART 1 - token: A1B2 */

/* START PART 2 - token: A1B2 */

// public/app.js（2/2）FULL REPLACE
// 目的：
// - ✅ (1/2) の List フィルター実装は壊さない（触らない）
// - ✅ 作品が読み込まれない致命傷（pillsMax6 未定義など）を (2/2) 側で補完して復旧
// - ✅ Home / List / Work を「以前の動作に戻す」（後退させない）
// - ✅ works split（index/shard）対応を維持
//
// 注意：
// - (1/2) に存在する const/関数名は再宣言しない（const衝突回避）
// - ここは “足りないものを足す + run を復旧” だけ

/* =======================
 * pills（※(1/2) が pillsMax6 を呼ぶので必須）
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

  // split index（期待: { listItems:[], lookup:{seriesKey: shardIndex} }）
  const idx = await tryLoadJson(idxUrl, { bust });
  if (idx && Array.isArray(idx.listItems)) {
    return { mode: "split", index: idx, listItems: idx.listItems, legacyItems: null };
  }

  // legacy fallback（works.json）
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

/* --- 日替わりランダム --- */
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
function categoryCountMap(allItems) {
  const map = new Map();
  for (const t of HOME_CATEGORY_TABS) map.set(t.id, 0);
  for (const it of allItems) {
    const label = getFirstAudienceLabel(it);
    const tab = HOME_CATEGORY_TABS.find(x => x.value === label) || HOME_CATEGORY_TABS[HOME_CATEGORY_TABS.length - 1];
    if (!tab) continue;
    map.set(tab.id, (map.get(tab.id) || 0) + 1);
  }
  return map;
}

/* =======================
 * Home：ジャンル棚（日替わり18件）
 * ======================= */
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

/* =======================
 * Home：カテゴリー棚（日替わり18件）
 * ======================= */
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
  const moreHref = `${BASE}list.html?aud=${encodeURIComponent(audValue)}` + (v ? `&v=${encodeURIComponent(v)}` : "");

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
        const href = `${BASE}list.html?mood=${encodeURIComponent(d.id)}${vq}`;
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
 * Work：URL key resolver
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

    const target = workStaticUrl(key);
    history.replaceState(null, "", target);
  }catch{}
}

/* =======================
 * Work：最低限の描画（既存の詳細UIを壊さない）
 * - ここは “壊れてない状態” を最優先：作品が出ればOK
 * ======================= */
async function renderWorkBasic(worksState) {
  const detail = document.getElementById("detail");
  if (!detail) return null;

  const key = resolveWorkKey();
  if (!key) return null;

  detail.innerHTML = `<div class="status">読み込み中…</div>`;

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
  `;

  initLazyImages(detail);
  trackWorkViewOnce(seriesKey);
  refreshFavButtons(document);
  return it;
}

/* =======================
 * metrics loader helpers
 * ======================= */
function withV(url){
  const v = qs().get("v");
  return v ? `${url}?v=${encodeURIComponent(v)}` : url;
}

/* =======================
 * run（壊さない復旧版）
 * ======================= */
async function run() {
  try {
    const v = qs().get("v");
    const bust = !!v;

    canonicalizeWorkToStatic();

    // works
    const worksState = await loadWorksIndex({ bust });

    // quick filters（List/Home 用）
    const quickUrl = v ? `${QUICK_FILTERS_PATH}?v=${encodeURIComponent(v)}` : QUICK_FILTERS_PATH;
    const quick = await loadJson(quickUrl, { bust });
    const quickDefs = Array.isArray(quick?.items) ? quick.items : [];

    // mag normalize（List 用）
    const magNormUrl = v ? `${MAG_NORMALIZE_PATH}?v=${encodeURIComponent(v)}` : MAG_NORMALIZE_PATH;
    const magNormJson = await tryLoadJson(magNormUrl, { bust });

    // Work
    const isWorkPage = !!document.getElementById("detail");
    if (isWorkPage) {
      await renderWorkBasic(worksState);
      patchAmazonAnchors(document);
      bindFavHandlers(document);
      refreshFavButtons(document);
      initLazyImages(document);
      setStatus("");
      return;
    }

    // Home metrics（閲覧数）
    const viewsMap = await (async () => {
      try {
        const viewUrl = withV(BASE + "data/metrics/wae/work_view_by_series.json");
        const viewJson = await loadJson(viewUrl, { bust });
        const rows = Array.isArray(viewJson?.rows) ? viewJson.rows
          : Array.isArray(viewJson?.data) ? viewJson.data
          : Array.isArray(viewJson) ? viewJson : [];
        return buildViewsMap(rows);
      } catch { return new Map(); }
    })();

    // rate top（Home）
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

    // Home（要素があるページだけ描画）
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
      renderQuickHome({ defs: quickDefs, counts });
    }

    // List
    if (document.getElementById("list")) {
      renderList(worksState.listItems, quickDefs, magNormJson);
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

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", run, { once: true });
} else {
  run();
}

/* END PART 2 - token: A1B2 */
