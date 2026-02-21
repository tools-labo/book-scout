// public/app.js  (1/2)
// - お気に入り / 投票の多重カウント対策：端末ローカルでクールダウン（デフォルト24h）
// - work_view は同一セッション同一作品は1回だけ（既存）
// - クイックフィルター：tagsのみ / 2ヒット以上 / AND最大2 / 数字は条件に応じて即時反映 + 数字送り + 幅固定
// - 巻き戻し防止：イベント抑止キーにバージョン prefix（将来の仕様変更で一括無効化できる）
// - 巻き戻し防止：抑止された時もUIで分かるように track*Once が true/false を返す

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
 * Analytics
 * ======================= */
const EVENTS_ENDPOINT = "https://book-scout-events.dx7qqdcchs.workers.dev/collect";

function trackEvent({ type, page, seriesKey = "", mood = "" }) {
  try {
    const u = new URL(EVENTS_ENDPOINT);
    u.searchParams.set("type", String(type || "unknown"));
    u.searchParams.set("page", String(page || ""));
    if (seriesKey) u.searchParams.set("seriesKey", String(seriesKey));
    if (mood) u.searchParams.set("mood", String(mood));

    const urlStr = u.toString();

    if (navigator.sendBeacon) {
      const ok = navigator.sendBeacon(urlStr);
      if (ok) return true;
    }

    fetch(urlStr, { method: "GET", mode: "cors", keepalive: true }).catch(() => {});
    return true;
  } catch {
    return false;
  }
}

/* =======================
 * 多重カウント抑止（端末ローカル）
 * - 同一端末で連打/何度も押す対策
 * - デフォルト24hで同じキーは再送しない
 * - 巻き戻し防止：キーにバージョン prefix を入れる
 * ======================= */
const EVENT_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const EVENT_KEY_PREFIX = "evt:v1:"; // ←仕様変更時は v2 に上げれば過去の抑止を一括無効化できる

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
    // localStorageが死んでても最低限送る（多重抑止は効かないが機能は壊さない）
    return true;
  }
}

// vote: seriesKey + mood で抑止
function trackVoteOnce(seriesKey, mood) {
  const sk = toText(seriesKey);
  const md = toText(mood);
  if (!sk || !md) return false;
  const key = `vote:${sk}:${md}`;
  if (!canSendOnce(key)) return false;
  trackEvent({ type: "vote", page: "work", seriesKey: sk, mood: md });
  return true;
}

// favorite: seriesKey で抑止（ON操作だけ送る前提）
function trackFavoriteOnce(seriesKey, page) {
  const sk = toText(seriesKey);
  if (!sk) return false;
  const pg = toText(page) || "unknown";
  const key = `favorite:${sk}`;
  if (!canSendOnce(key)) return false;
  trackEvent({ type: "favorite", page: pg, seriesKey: sk, mood: "" });
  return true;
}

/* =======================
 * work_view：同一セッション内で同一作品は1回だけ
 * ======================= */
function trackWorkViewOnce(seriesKey) {
  const sk = toText(seriesKey);
  if (!sk) return false;

  try {
    const k = `work_view:${sk}`;
    if (sessionStorage.getItem(k) === "1") return false;
    sessionStorage.setItem(k, "1");
  } catch {
    // sessionStorage不可でも送ってOK
  }

  trackEvent({ type: "work_view", page: "work", seriesKey: sk, mood: "" });
  return true;
}

/* =======================
 * Favorite（端末内だけ保持）
 * - UIは自由にON/OFFできる
 * - イベント送信は「ONにした時」かつクールダウンで抑止
 * ======================= */
function favKey(seriesKey) {
  return `fav:${toText(seriesKey)}`;
}
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

    // ONにしたときだけ送る（+ クールダウンで多重カウント抑止）
    if (next) {
      const sent = trackFavoriteOnce(seriesKey, page || "unknown");
      // 送れなかった（=抑止された）場合でもUIは壊さない。通知は stats 側では不要なのでここでは何もしない。
      void sent;
    }
  }, { passive: true });
}

/* =======================
 * 表示前の正規化
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
 * Genre map
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
 * ジャンル（確定10本）
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
 * 連載誌（今は残してるが、将来廃止してもOK）
 * ======================= */
function hasMagazine(it, mag) {
  if (!mag) return true;
  const ms = pickArr(it, ["magazines", "vol1.magazines"]).map(toText).filter(Boolean);
  const m1 = toText(pick(it, ["magazine", "vol1.magazine"]));
  if (ms.length) return ms.includes(mag);
  return m1.includes(mag);
}

/* =======================
 * Quick filter（tagsのみ、>=2、AND最大2）
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

  for (const t of noneTags) {
    if (tagSet.has(t)) return { ok: false, hits: 0 };
  }

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

// 「今の絞り込み条件（genre/aud/mag）」で絞った baseItems を渡す想定。
// counts は「もしこのボタンも押したら何件になるか」を即時計算。
function quickCountsDynamic(baseItems, defs, selectedIds) {
  const byId = new Map(defs.map(d => [d.id, d]));
  const sel = (selectedIds || []).filter(Boolean);
  const selDefs = sel.map(id => byId.get(id)).filter(Boolean);

  const counts = new Map(defs.map(d => [d.id, 0]));
  const disabled = new Set();
  const selectedSet = new Set(sel);

  if (sel.length >= QUICK_MAX) {
    for (const d of defs) {
      if (!selectedSet.has(d.id)) disabled.add(d.id);
    }
  }

  for (const d of defs) {
    let condDefs = [];

    if (sel.length === 0) {
      condDefs = [d];
    } else if (sel.length === 1) {
      if (selectedSet.has(d.id)) condDefs = selDefs;
      else condDefs = [selDefs[0], d];
    } else {
      // 2個選択中：未選択は押せないので「現状結果」を表示
      condDefs = selDefs;
    }

    let n = 0;
    for (const it of baseItems) {
      if (quickEvalAll(it, condDefs).ok) n++;
    }
    counts.set(d.id, n);
  }

  return { counts, disabled };
}

/* =======================
 * 数字送り
 * ======================= */
function animateNumber(el, from, to, durationMs = 240) {
  const a = Number.isFinite(from) ? from : 0;
  const b = Number.isFinite(to) ? to : 0;
  if (a === b) {
    el.textContent = String(b);
    el.dataset.prev = String(b);
    return;
  }

  const start = performance.now();
  const diff = b - a;

  function step(now) {
    const t = Math.min(1, (now - start) / durationMs);
    const eased = 1 - Math.pow(1 - t, 3);
    const cur = Math.round(a + diff * eased);
    el.textContent = String(cur);
    if (t < 1) requestAnimationFrame(step);
    else el.dataset.prev = String(b);
  }
  requestAnimationFrame(step);
}

/* =======================
 * Quick UI render（固定幅カウント）
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
            (<span class="qcount-wrap"><span class="qcount" data-prev="${n}">${n}</span></span>)
          </span>
        </a>`;
      }).join("")}
    </div>
  `;
}

function renderQuickListUI({ defs, counts, disabledIds, selectedIds, onToggle }) {
  const root = document.getElementById("quickFiltersList");
  if (!root) return;
  if (!defs?.length) { root.innerHTML = ""; return; }

  const selected = new Set(selectedIds || []);
  const disabled = disabledIds || new Set();

  root.innerHTML = `
    <div class="pills">
      ${defs.map(d => {
        const isOn = selected.has(d.id);
        const isDisabled = !isOn && disabled.has(d.id);
        const n = counts.get(d.id) || 0;

        return `
          <button
            type="button"
            class="pill"
            data-mood="${esc(d.id)}"
            aria-pressed="${isOn ? "true" : "false"}"
            ${isDisabled ? "disabled" : ""}
            style="${isOn ? "outline:2px solid currentColor; outline-offset:1px;" : ""}${isDisabled ? ";opacity:.5;cursor:not-allowed" : ""}"
          >
            ${esc(d.label)}
            <span style="opacity:.7;">
              (<span class="qcount-wrap"><span class="qcount" data-prev="${n}">${n}</span></span>)
            </span>
          </button>
        `;
      }).join("")}
    </div>
  `;

  // 数字送り（初回表示も含めて実行）
  for (const el of root.querySelectorAll(".qcount")) {
    const prev = Number(el.dataset.prev || "0");
    const next = Number(el.textContent || "0");
    animateNumber(el, prev, next, 240);
  }

  root.onclick = (ev) => {
    const btn = ev.target?.closest?.("button[data-mood]");
    if (!btn) return;
    if (btn.disabled) return;
    const id = btn.getAttribute("data-mood") || "";
    if (!id) return;
    onToggle(id);
  };
}

function renderQuickHint({ selectedIds, defs, itemsAfterAllFilters }) {
  const hint = document.getElementById("quickFiltersHint");
  if (!hint) return;

  const selected = (selectedIds || []).filter(Boolean);
  if (!selected.length) { hint.innerHTML = ""; return; }

  const labels = selected.map(id => defs.find(d => d.id === id)?.label || id);
  const msg = `気分: <b>${esc(labels.join(" × "))}</b>（AND / 最大2）`;
  hint.innerHTML = (itemsAfterAllFilters.length === 0)
    ? `${msg}<br/><span style="opacity:.8;">該当なし</span>`
    : msg;
}
