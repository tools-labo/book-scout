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
 * Analytics (Cloudflare Worker)
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
      if (ok) return;
    }

    fetch(urlStr, { method: "GET", mode: "cors", keepalive: true }).catch(() => {});
  } catch {
    // noop
  }
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
  const m1 = toText(pick(it, ["magazine", "vol1.magazine"]));
  if (ms.length) return ms.includes(mag);
  return m1.includes(mag);
}

/* =======================
 * 気分（クイックフィルター）仕様A
 * - tags のみ参照（genres無視）
 * - 各フィルターは「一致タグ数>=2」で成立
 * - list は AND（最大2）
 * - 並び順は合算スコア（=一致タグ数合計）降順
 * - 0件ならOR提案しない
 * - 件数は「現在条件」で即時再計算（今回の改良点）
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

// 作品の tags（ユニーク）
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

// 単体フィルター判定（>=2成立） + hits
function quickEval(it, def) {
  if (!def) return { ok: false, hits: 0 };

  const tags = itTags(it);
  const tagSet = new Set(tags);

  const anyTags = toTagList(def.matchAny?.tags || []);
  const noneTags = toTagList(def.matchNone?.tags || []);

  // matchNone 1個でも一致したらNG
  for (const t of noneTags) {
    if (tagSet.has(t)) return { ok: false, hits: 0 };
  }

  const hits = countTagHits(tagSet, anyTags);
  return { ok: hits >= QUICK_MIN_HITS, hits };
}

// 複数フィルター AND + 合算スコア
function quickEvalAll(it, defs) {
  if (!defs?.length) return { ok: true, score: 0, hitsById: {} };

  let score = 0;
  const hitsById = {};

  for (const def of defs) {
    const r = quickEval(it, def);
    hitsById[def.id] = r.hits;
    if (!r.ok) return { ok: false, score: 0, hitsById };
    score += r.hits;
  }

  return { ok: true, score, hitsById };
}

// 「現在条件」で件数を動的に作る
// baseItems = 非mood条件を通った母集団
// selectedIds = 現在選択中mood（最大2）
function quickCountsDynamic(baseItems, defs, selectedIds) {
  const byId = new Map(defs.map(d => [d.id, d]));
  const sel = (selectedIds || []).filter(Boolean);
  const selDefs = sel.map(id => byId.get(id)).filter(Boolean);

  const counts = new Map(defs.map(d => [d.id, 0]));
  const disabled = new Set();

  const selectedSet = new Set(sel);

  // 2個選択中：未選択は押せない（disabled）
  if (sel.length >= QUICK_MAX) {
    for (const d of defs) {
      if (!selectedSet.has(d.id)) disabled.add(d.id);
    }
  }

  for (const d of defs) {
    // count対象の条件セット
    let condDefs = [];

    if (sel.length === 0) {
      condDefs = [d];
    } else if (sel.length === 1) {
      if (selectedSet.has(d.id)) condDefs = selDefs;          // 自分（=1個）
      else condDefs = [selDefs[0], d];                        // 追加したらの想定（AND）
    } else {
      // 2個選択中
      if (selectedSet.has(d.id)) condDefs = selDefs;          // 選択中2つは現在の結果件数
      else condDefs = selDefs;                                // 未選択は増やせないので「現在の結果件数」を表示（disabled）
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
 * 数字送り（カウントアニメ）
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
    // ちょいイージング（見た目重視）
    const eased = 1 - Math.pow(1 - t, 3);
    const cur = Math.round(a + diff * eased);
    el.textContent = String(cur);
    if (t < 1) requestAnimationFrame(step);
    else el.dataset.prev = String(b);
  }
  requestAnimationFrame(step);
}

/* =======================
 * Quick UI render
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
        return `<a class="pill" href="${esc(href)}" style="text-decoration:none;">${esc(d.label)} <span style="opacity:.7;">(<span class="qcount" data-prev="${n}">${n}</span>)</span></a>`;
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
            ${esc(d.label)} <span style="opacity:.7;">(<span class="qcount" data-prev="${n}">${n}</span>)</span>
          </button>
        `;
      }).join("")}
    </div>
  `;

  // 数字送り（差分アニメ）
  for (const el of root.querySelectorAll(".qcount")) {
    const prev = Number(el.dataset.prev || el.textContent || "0");
    const next = Number(el.textContent || "0");
    // 初回はアニメしない（prev==next）
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
  if (!selected.length) {
    hint.innerHTML = "";
    return;
  }

  const labels = selected.map(id => defs.find(d => d.id === id)?.label || id);
  const msg = `気分: <b>${esc(labels.join(" × "))}</b>（AND / 最大2 / 各フィルターはタグ一致2以上）`;
  hint.innerHTML = msg;

  if (itemsAfterAllFilters.length === 0) {
    hint.innerHTML = `${msg}<br/><span style="opacity:.8;">該当なし</span>`;
  }
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
 * 共通：横一列カード列（もっと見る）
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
          ${img ? `<img src="${esc(img)}" alt="${esc(title)}">` : `<div class="thumb-ph"></div>`}
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

function setGenreAllLink(activeTab) {
  const a = document.getElementById("genreAllLink");
  if (!a) return;
  const v = qs().get("v");
  const vq = v ? `&v=${encodeURIComponent(v)}` : "";
  const q = encodeURIComponent(activeTab.match.join(","));
  a.href = `./list.html?genre=${q}${vq}`;
}

function setAudienceAllLink(activeAudValue) {
  const a = document.getElementById("audienceAllLink");
  if (!a) return;
  const v = qs().get("v");
  const vq = v ? `&v=${encodeURIComponent(v)}` : "";
  a.href = `./list.html?aud=${encodeURIComponent(activeAudValue)}${vq}`;
}

function genreCountMap(allItems) {
  const map = new Map();
  for (const t of GENRE_TABS) map.set(t.id, 0);
  for (const it of allItems) {
    for (const t of GENRE_TABS) {
      if (hasAnyGenre(it, t.match)) map.set(t.id, (map.get(t.id) || 0) + 1);
    }
  }
  return map;
}

function categoryCountMap(allItems) {
  const map = new Map();
  for (const t of CATEGORY_TABS) map.set(t.id, 0);
  for (const it of allItems) {
    const label = getFirstAudienceLabel(it);
    const tab = CATEGORY_TABS.find(x => x.value === label) || CATEGORY_TABS.find(x => x.id === "other");
    if (!tab) continue;
    map.set(tab.id, (map.get(tab.id) || 0) + 1);
  }
  return map;
}

function renderGenreTabsRow({ data, activeId }) {
  const tabs = document.getElementById("genreTabs");
  const row = document.getElementById("genreRow");
  if (!tabs || !row) return;

  const all = Array.isArray(data?.items) ? data.items : [];
  if (!all.length) { tabs.innerHTML = ""; row.innerHTML = ""; return; }

  const counts = genreCountMap(all);
  const active = GENRE_TABS.find(x => x.id === activeId) || GENRE_TABS[0];

  tabs.innerHTML = `
    <div class="tabrow">
      ${GENRE_TABS.map((t) => `
        <button class="tab ${t.id === active.id ? "is-active" : ""}" data-genre="${esc(t.id)}" type="button">
          <span class="tab-label">${esc(t.label)}</span>
          <span class="badge">${counts.get(t.id) || 0}</span>
        </button>
      `).join("")}
    </div>
  `;

  const picked = all.filter(it => hasAnyGenre(it, active.match));
  const v = qs().get("v");
  const vq = v ? `&v=${encodeURIComponent(v)}` : "";
  const moreHref = `./list.html?genre=${encodeURIComponent(active.match.join(","))}${vq}`;

  row.innerHTML = renderCardRow({ items: picked, limit: 18, moreHref });

  setGenreAllLink(active);

  tabs.onclick = (ev) => {
    const btn = ev.target?.closest?.("button[data-genre]");
    if (!btn) return;
    const next = btn.getAttribute("data-genre") || "";
    if (!next || next === active.id) return;

    setHomeState({ g: next });
    renderGenreTabsRow({ data, activeId: next });
  };
}

function renderAudienceTabsRow({ data, activeAudId }) {
  const tabs = document.getElementById("audienceTabs");
  const row = document.getElementById("audienceRow");
  if (!tabs || !row) return;

  const all = Array.isArray(data?.items) ? data.items : [];
  if (!all.length) { tabs.innerHTML = ""; row.innerHTML = ""; return; }

  const counts = categoryCountMap(all);
  const active = CATEGORY_TABS.find(x => x.id === activeAudId) || CATEGORY_TABS[0];
  const audValue = active.value;

  tabs.innerHTML = `
    <div class="tabrow">
      ${CATEGORY_TABS.map((t) => `
        <button class="tab ${t.id === active.id ? "is-active" : ""}" data-aud="${esc(t.id)}" type="button">
          <span class="tab-label">${esc(t.label)}</span>
          <span class="badge">${counts.get(t.id) || 0}</span>
        </button>
      `).join("")}
    </div>
  `;

  const picked = all.filter(it => getFirstAudienceLabel(it) === audValue);
  const v = qs().get("v");
  const vq = v ? `&v=${encodeURIComponent(v)}` : "";
  const moreHref = `./list.html?aud=${encodeURIComponent(audValue)}${vq}`;

  row.innerHTML = renderCardRow({ items: picked, limit: 18, moreHref });

  setAudienceAllLink(audValue);

  tabs.onclick = (ev) => {
    const btn = ev.target?.closest?.("button[data-aud]");
    if (!btn) return;
    const next = btn.getAttribute("data-aud") || "";
    if (!next || next === active.id) return;

    setHomeState({ a: next });
    renderAudienceTabsRow({ data, activeAudId: next });
  };
}

/* =======================
 * list.html（気分AND + スコア順 + 件数追従）
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

  // 非moodの母集団（ここがクイック件数のベースになる）
  const base = all
    .filter((it) => (genreWanted.length ? hasAnyGenre(it, genreWanted) : true))
    .filter((it) => hasAudience(it, audienceWanted))
    .filter((it) => hasMagazine(it, magazineWanted));

  // mood AND + スコア
  const scored = [];
  if (moodActiveDefs.length) {
    for (const it of base) {
      const r = quickEvalAll(it, moodActiveDefs);
      if (!r.ok) continue;
      scored.push({ it, score: r.score });
    }
    scored.sort((a, b) => {
      const ds = (b.score || 0) - (a.score || 0);
      if (ds) return ds;
      const ak = toText(pick(a.it, ["seriesKey"])) || "";
      const bk = toText(pick(b.it, ["seriesKey"])) || "";
      return ak.localeCompare(bk);
    });
  } else {
    for (const it of base) scored.push({ it, score: 0 });
  }

  const items = scored.map(x => x.it);

  renderFilterBanner({ genreWanted, audienceWanted, magazineWanted });

  // 計測：list_filter
  const moodParam = moodSelected.join(",");
  trackEvent({
    type: "list_filter",
    page: "list",
    seriesKey: "",
    mood: [
      genreWanted.length ? `genre=${genreWanted.join(",")}` : "",
      audienceWanted ? `aud=${audienceWanted}` : "",
      magazineWanted ? `mag=${magazineWanted}` : "",
      moodParam ? `mood=${moodParam}` : "",
    ].filter(Boolean).join("&"),
  });

  // クイックUI（件数は「現在条件」で動的）
  if (document.getElementById("quickFiltersList")) {
    const defs = Array.isArray(quickDefs) ? quickDefs : [];
    const dyn = quickCountsDynamic(base, defs, moodSelected);

    const clear = document.getElementById("moodClearLink");
    if (clear) {
      const v = qs().get("v");
      clear.href = v ? `./list.html?v=${encodeURIComponent(v)}` : "./list.html";
    }

    renderQuickListUI({
      defs,
      counts: dyn.counts,
      disabledIds: dyn.disabled,
      selectedIds: moodSelected,
      onToggle: (id) => {
        const cur = parseMoodQuery();
        const set = new Set(cur);

        if (set.has(id)) set.delete(id);
        else {
          if (set.size >= QUICK_MAX) return;
          set.add(id);
        }

        const next = Array.from(set);
        setMoodQuery(next);

        renderList(data, quickDefs);
      }
    });

    renderQuickHint({
      selectedIds: moodSelected,
      defs,
      itemsAfterAllFilters: items
    });
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
 * work.html（投票）
 * ======================= */
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

  const defs = Array.isArray(quickDefs) ? quickDefs : [];
  const voteButtons = defs.length
    ? `
      <div class="d-sub" style="margin-top:14px;">読み味投票</div>
      <div class="pills" id="votePills">
        ${defs.map(d => `
          <button type="button" class="pill" data-vote="${esc(d.id)}">
            ${esc(d.label)}
          </button>
        `).join("")}
      </div>
      <div class="d-sub" id="voteStatus" style="margin-top:8px;"></div>
    `
    : "";

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

    ${voteButtons}
  `;

  // work_view
  trackEvent({ type: "work_view", page: "work", seriesKey, mood: "" });

  const vp = document.getElementById("votePills");
  if (vp) {
    vp.onclick = (ev) => {
      const btn = ev.target?.closest?.("button[data-vote]");
      if (!btn) return;
      const mood = btn.getAttribute("data-vote") || "";
      if (!mood) return;

      trackEvent({ type: "vote", page: "work", seriesKey, mood });

      const st = document.getElementById("voteStatus");
      if (st) st.textContent = "投票しました";
      setTimeout(() => { if (st) st.textContent = ""; }, 1200);
    };
  }
}

async function run() {
  try {
    const v = qs().get("v");
    const worksUrl = v ? `./data/lane2/works.json?v=${encodeURIComponent(v)}` : "./data/lane2/works.json";
    const quickUrl = v ? `${QUICK_FILTERS_PATH}?v=${encodeURIComponent(v)}` : QUICK_FILTERS_PATH;

    const data = await loadJson(worksUrl, { bust: !!v });
    const quick = await loadJson(quickUrl, { bust: !!v });
    const quickDefs = Array.isArray(quick?.items) ? quick.items : [];

    const st = getHomeState();
    renderGenreTabsRow({ data, activeId: st.g });
    renderAudienceTabsRow({ data, activeAudId: st.a });

    if (document.getElementById("quickFiltersHome")) {
      const all = Array.isArray(data?.items) ? data.items : [];
      // Homeは全体件数（従来どおり）
      const counts = new Map(quickDefs.map(d => [d.id, 0]));
      for (const it of all) for (const d of quickDefs) if (quickEval(it, d).ok) counts.set(d.id, (counts.get(d.id) || 0) + 1);
      renderQuickHome({ defs: quickDefs, counts });
    }

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
