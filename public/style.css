// public/app.js (1/2) CLEAN
// - app.js内の重複定義を完全に除去（SyntaxError対策）
// - Home：気分/ジャンル/カテゴリーが確実に出る
// - List：表示は タイトル/作者/連載誌/タグ のみ（ジャンル/出版社/発売日は非表示のまま）
//        ただし genre/aud/mag のURL絞り込みは内部で復活
// - Work：発売日/出版社を復活（ジャンルは表示しない）
// - 読後感投票：最大2つ（選択状態を保持）

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
 * Genre（内部用）
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
 * pills: tags max 6 +N
 * ======================= */
function pillsMax6(list) {
  const xs = (list || []).map(toText).filter(Boolean);
  if (!xs.length) return "";
  const head = xs.slice(0, 6);
  const rest = xs.length - head.length;
  const more = rest > 0 ? `<span class="pill">+${rest}</span>` : "";
  return `<div class="pills">${head.map(x => `<span class="pill">${esc(x)}</span>`).join("")}${more}</div>`;
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
  const disabled = new Set();
  const selectedSet = new Set(sel);

  if (sel.length >= QUICK_MAX) {
    for (const d of defs) if (!selectedSet.has(d.id)) disabled.add(d.id);
  }

  for (const d of defs) {
    let condDefs = [];
    if (sel.length === 0) condDefs = [d];
    else if (sel.length === 1) condDefs = (selectedSet.has(d.id)) ? selDefs : [selDefs[0], d];
    else condDefs = selDefs;

    let n = 0;
    for (const it of baseItems) if (quickEvalAll(it, condDefs).ok) n++;
    counts.set(d.id, n);
  }

  return { counts, disabled };
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
 * List render
 * ======================= */
function renderList(data, quickDefs) {
  const root = document.getElementById("list");
  if (!root) return;

  const all = Array.isArray(data?.items) ? data.items : [];

  // ★ 内部絞り込みを復活（表示は増やさない）
  const genreWanted = parseGenreQuery();      // "Action,Sports" など
  const audienceWanted = parseOneQueryParam("aud"); // "少年" など
  const magazineWanted = parseOneQueryParam("mag"); // 任意

  const moodSelected = parseMoodQuery();
  const byId = new Map((quickDefs || []).map(d => [d.id, d]));
  const moodActiveDefs = moodSelected.map(id => byId.get(id)).filter(Boolean);

  const base = all
    .filter(it => (genreWanted.length ? hasAnyGenre(it, genreWanted) : true))
    .filter(it => hasAudience(it, audienceWanted))
    .filter(it => hasMagazine(it, magazineWanted));

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
  const items = scored.map(x => x.it);

  const clear = document.getElementById("moodClearLink");
  if (clear) {
    clear.onclick = (ev) => {
      ev.preventDefault();
      setMoodQuery([]);
      renderList(data, quickDefs);
      refreshFavButtons(document);
    };
  }

  if (document.getElementById("quickFiltersList")) {
    const defs = Array.isArray(quickDefs) ? quickDefs : [];
    const dyn = quickCountsDynamic(base, defs, moodSelected);

    const rootQ = document.getElementById("quickFiltersList");
    rootQ.innerHTML = `
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

    rootQ.onclick = (ev) => {
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
      setMoodQuery(Array.from(set));
      renderList(data, quickDefs);
      refreshFavButtons(document);
    };

    const hint = document.getElementById("quickFiltersHint");
    if (hint) {
      if (!moodSelected.length) hint.textContent = "";
      else hint.innerHTML = `気分: <b>${esc(moodSelected.map(id => byId.get(id)?.label || id).join(" × "))}</b>（AND / 最大2）`;
    }
  }

  if (!items.length) {
    root.innerHTML = `<div class="status">表示できる作品がありません</div>`;
    return;
  }

  const v = qs().get("v");
  const vq = v ? `&v=${encodeURIComponent(v)}` : "";

  root.innerHTML = items.map((it) => {
    const seriesKey = toText(pick(it, ["seriesKey"])) || "";
    const key = encodeURIComponent(seriesKey);

    const title = toText(pick(it, ["title", "vol1.title"])) || seriesKey || "(無題)";
    const author = toText(pick(it, ["author", "vol1.author"])) || "";
    const magazine = toText(pick(it, ["magazine", "vol1.magazine"])) || "";

    const imgRaw = toText(pick(it, ["image", "vol1.image"])) || "";
    const img = normalizeImgUrl(imgRaw);

    const amzRaw = toText(pick(it, ["amazonDp", "vol1.amazonDp", "amazonUrl", "vol1.amazonUrl"])) || "#";
    const amz = ensureAmazonAffiliate(amzRaw);

    const tagsJa = pickArr(it, ["tags", "vol1.tags"]).map(toText).filter(Boolean);
    const synopsis = toText(pick(it, ["synopsis", "vol1.synopsis"])) || "";

    return `
      <article class="card">
        <div class="card-row">
          <div class="thumb">
            ${
              img
                ? `<a href="./work.html?key=${key}${vq}" aria-label="${esc(title)}"><img src="${esc(img)}" alt="${esc(title)}"/></a>`
                : `<div class="thumb-ph"></div>`
            }
          </div>

          <div class="meta">
            <div class="title"><a href="./work.html?key=${key}${vq}">${esc(seriesKey || title)}</a></div>

            ${author ? `<div class="sub">${esc(author)}</div>` : ""}
            ${magazine ? `<div class="sub">連載誌: ${esc(magazine)}</div>` : ""}

            ${tagsJa.length ? `<div class="sub">タグ</div>${pillsMax6(tagsJa)}` : ""}

            <div class="actions">
              ${amz && amz !== "#" ? `<a class="amz-mini" href="${esc(amz)}" target="_blank" rel="nofollow noopener">Amazon（1巻）</a>` : ""}
              ${favButtonHtml(seriesKey, "list")}
            </div>

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

  refreshFavButtons(document);
}
// public/app.js (2/2) CLEAN
// - Work render（発売日/出版社を表示、ジャンル非表示）
// - Home：気分/ジャンル/カテゴリー棚
// - run()

/* =======================
 * Work render（発売日/出版社を表示）
 * ======================= */
function renderWork(data, quickDefs) {
  const detail = document.getElementById("detail");
  if (!detail) return;

  const key = qs().get("key");
  if (!key) return;

  const items = Array.isArray(data?.items) ? data.items : [];
  const it = items.find((x) => toText(pick(x, ["seriesKey"])) === key);
  if (!it) return;

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

  const voteBox = defs.length
    ? `
      <div class="vote-box">
        <div class="vote-head">
          <h3 class="vote-title">読後感はどれ？</h3>
        </div>
        <p class="vote-note">当てはまるものをタップして投票（最大2つ）。</p>
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
    `
    : "";

  detail.innerHTML = `
    <div class="d-title">${esc(seriesKey || title)}</div>

    ${author ? `<div class="d-sub">${esc(author)}</div>` : ""}
    ${magazine ? `<div class="d-sub">連載誌: ${esc(magazine)}</div>` : ""}
    ${release ? `<div class="d-sub">発売日: ${esc(release)}</div>` : ""}
    ${publisher ? `<div class="d-sub">出版社: ${esc(publisher)}</div>` : ""}

    ${tagsJa.length ? `<div class="d-sub">タグ</div>${pillsMax6(tagsJa)}` : ""}

    <div class="d-row" style="margin-top:10px;">
      ${img ? `<img class="d-img" src="${esc(img)}" alt="${esc(title)}"/>` : ""}
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
  `;

  // work_view：同一セッション1回
  trackWorkViewOnce(seriesKey);

  // vote（最大2 + 選択状態保持、送信はvoteOnceで抑止）
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
        setTimeout(() => { if (st) st.textContent = ""; }, 1200);
        return;
      }

      if (set.size >= VOTE_MAX) {
        if (st) st.textContent = "最大2つまで選べます";
        setTimeout(() => { if (st) st.textContent = ""; }, 1400);
        return;
      }

      set.add(mood);
      setVotedSet(seriesKey, set);
      btn.classList.add("is-on");
      btn.setAttribute("aria-pressed", "true");

      const sent = trackVoteOnce(seriesKey, mood);
      if (st) {
        st.textContent = sent ? "投票しました" : "投票済み（しばらくしてから）";
        setTimeout(() => { if (st) st.textContent = ""; }, 1400);
      }
    };
  }

  refreshFavButtons(document);
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

function renderGenreTabsRow({ data, activeId }) {
  const tabs = document.getElementById("genreTabs");
  const row = document.getElementById("genreRow");
  if (!tabs || !row) return;

  const all = Array.isArray(data?.items) ? data.items : [];
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

function renderAudienceTabsRow({ data, activeAudId }) {
  const tabs = document.getElementById("audienceTabs");
  const row = document.getElementById("audienceRow");
  if (!tabs || !row) return;

  const all = Array.isArray(data?.items) ? data.items : [];
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
 * Home：気分（導線リンク）
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

/* =======================
 * run
 * ======================= */
async function run() {
  try {
    const v = qs().get("v");
    const worksUrl = v ? `./data/lane2/works.json?v=${encodeURIComponent(v)}` : "./data/lane2/works.json";
    const quickUrl = v ? `${QUICK_FILTERS_PATH}?v=${encodeURIComponent(v)}` : QUICK_FILTERS_PATH;

    const data = await loadJson(worksUrl, { bust: !!v });
    const quick = await loadJson(quickUrl, { bust: !!v });
    const quickDefs = Array.isArray(quick?.items) ? quick.items : [];

    // Home：ジャンル/カテゴリー
    const st = getHomeState();
    renderGenreTabsRow({ data, activeId: st.g });
    renderAudienceTabsRow({ data, activeAudId: st.a });

    // Home：気分（導線）
    if (document.getElementById("quickFiltersHome")) {
      const all = Array.isArray(data?.items) ? data.items : [];
      const counts = new Map(quickDefs.map(d => [d.id, 0]));
      for (const it of all) {
        for (const d of quickDefs) {
          if (quickEval(it, d).ok) counts.set(d.id, (counts.get(d.id) || 0) + 1);
        }
      }
      renderQuickHome({ defs: quickDefs, counts });
    }

    // List / Work
    renderList(data, quickDefs);
    renderWork(data, quickDefs);

    // Amazonアフィ付与
    patchAmazonAnchors(document);

    // favorite handler
    bindFavHandlers(document);
    refreshFavButtons(document);
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
