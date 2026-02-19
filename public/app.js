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
 * - Amazon.co.jp のみ
 * - 既に tag があればそのまま
 * - tag が無ければ付与
 * - DOM内の a[href] も一括で補正（index.html の直リンク対策）
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
 * /?g=action&a=seinen
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
 * - データの audiences は「少年/青年/少女/女性/その他」
 * - 表示は「少年マンガ」等にする
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
 * 気分（クイックフィルター）
 * - list は AND
 * - 最大2個まで
 * - 0件なら OR 提案
 * ======================= */
const QUICK_FILTERS_PATH = "./data/lane2/quick_filters.json";
const QUICK_MAX = 2;

function parseMoodQuery() {
  const raw = toText(qs().get("mood"));
  if (!raw) return [];
  const ids = raw.split(",").map(s => s.trim()).filter(Boolean);
  // 最大2つまで
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

  // matchNone に当たったら即NG
  if (matchesAny(genres, noneGenres)) return false;
  if (matchesAny(tags, noneTags)) return false;

  // matchAny は genre OR tag のどちらかに当たればOK
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
        return `<a class="pill" href="${esc(href)}" style="text-decoration:none;">${esc(d.label)} <span style="opacity:.7;">(${n})</span></a>`;
      }).join("")}
    </div>
  `;
}

function renderQuickListUI({ defs, counts, selectedIds, onToggle }) {
  const root = document.getElementById("quickFiltersList");
  if (!root) return;

  if (!defs?.length) { root.innerHTML = ""; return; }

  const selected = new Set(selectedIds || []);

  root.innerHTML = `
    <div class="pills">
      ${defs.map(d => {
        const isOn = selected.has(d.id);
        const n = counts.get(d.id) || 0;

        // pill をボタンとして扱う（CSSは既存pillを流用）
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

  root.onclick = (ev) => {
    const btn = ev.target?.closest?.("button[data-mood]");
    if (!btn) return;
    const id = btn.getAttribute("data-mood") || "";
    if (!id) return;
    onToggle(id);
  };
}

function renderQuickHint({ selectedIds, defs, itemsAfterAllFilters, allItems }) {
  const hint = document.getElementById("quickFiltersHint");
  if (!hint) return;

  const selected = (selectedIds || []).filter(Boolean);
  if (!selected.length) {
    hint.innerHTML = "";
    return;
  }

  const labels = selected.map(id => defs.find(d => d.id === id)?.label || id);
  const msg = `気分: <b>${esc(labels.join(" × "))}</b>（AND / 最大2）`;
  hint.innerHTML = msg;

  // 0件時：OR提案（単体にする）
  if (itemsAfterAllFilters.length === 0 && selected.length >= 2) {
    const v = qs().get("v");
    const vq = v ? `&v=${encodeURIComponent(v)}` : "";
    const links = selected.map(id => {
      const lab = defs.find(d => d.id === id)?.label || id;
      const href = `./list.html?mood=${encodeURIComponent(id)}${vq}`;
      return `<a class="pill" href="${esc(href)}" style="text-decoration:none;">${esc(lab)}だけにする</a>`;
    }).join("");

    const clearHref = `./list.html${vq ? `?v=${encodeURIComponent(v)}` : ""}`;
    hint.innerHTML = `
      ${msg}<br/>
      <div style="margin-top:8px;">0件です。ORで広げるなら：</div>
      <div class="pills" style="margin-top:6px;">${links}<a class="pill" href="${esc(clearHref)}" style="text-decoration:none;">気分を解除</a></div>
    `;
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
    // audienceWanted はデータ値（少年/青年…）
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

/* =======================
 * ①「一覧を見る」導線
 * ======================= */
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
    const label = getFirstAudienceLabel(it); // 少年/青年/…
    const tab = CATEGORY_TABS.find(x => x.value === label) || CATEGORY_TABS.find(x => x.id === "other");
    if (!tab) continue;
    map.set(tab.id, (map.get(tab.id) || 0) + 1);
  }
  return map;
}

/* =======================
 * Home：ジャンル
 * ======================= */
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

/* =======================
 * Home：カテゴリー（旧：読者層）
 * ======================= */
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
 * list.html（気分フィルターAND）
 * ======================= */
function renderList(data, quickDefs) {
  const root = document.getElementById("list");
  if (!root) return;

  const all = Array.isArray(data?.items) ? data.items : [];

  const genreWanted = parseGenreQuery();
  const audienceWanted = parseOneQueryParam("aud"); // 少年/青年/…
  const magazineWanted = parseOneQueryParam("mag");

  const moodSelected = parseMoodQuery();

  // 気分: AND（全て満たす）
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

  // list側：気分UI
  if (document.getElementById("quickFiltersList")) {
    const defs = Array.isArray(quickDefs) ? quickDefs : [];
    const counts = quickCounts(all, defs);

    // 解除リンク
    const clear = document.getElementById("moodClearLink");
    if (clear) {
      const v = qs().get("v");
      clear.href = v ? `./list.html?v=${encodeURIComponent(v)}` : "./list.html";
    }

    renderQuickListUI({
      defs,
      counts,
      selectedIds: moodSelected,
      onToggle: (id) => {
        const cur = parseMoodQuery();
        const set = new Set(cur);

        if (set.has(id)) set.delete(id);
        else {
          if (set.size >= QUICK_MAX) return; // 2個制限
          set.add(id);
        }

        const next = Array.from(set);
        setMoodQuery(next);

        // URL変更だけだと再描画されないので、その場で再描画
        renderList(data, quickDefs);
      }
    });

    // ヒント（AND / 2個制限 / 0件時OR提案）
    renderQuickHint({
      selectedIds: moodSelected,
      defs,
      itemsAfterAllFilters: items,
      allItems: all
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
  `;
}

async function run() {
  try {
    const v = qs().get("v");
    const worksUrl = v ? `./data/lane2/works.json?v=${encodeURIComponent(v)}` : "./data/lane2/works.json";
    const quickUrl = v ? `${QUICK_FILTERS_PATH}?v=${encodeURIComponent(v)}` : QUICK_FILTERS_PATH;

    const data = await loadJson(worksUrl, { bust: !!v });
    const quick = await loadJson(quickUrl, { bust: !!v });
    const quickDefs = Array.isArray(quick?.items) ? quick.items : [];

    // Home（URLから復元）
    const st = getHomeState();
    renderGenreTabsRow({ data, activeId: st.g });
    renderAudienceTabsRow({ data, activeAudId: st.a });

    // Home：気分（導線リンク）
    if (document.getElementById("quickFiltersHome")) {
      const all = Array.isArray(data?.items) ? data.items : [];
      const counts = quickCounts(all, quickDefs);
      renderQuickHome({ defs: quickDefs, counts });
    }

    // List / Work
    renderList(data, quickDefs);
    renderWork(data);

    // 静的リンクも含めて、表示後に一括でアフィ付与
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
