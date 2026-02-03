// public/app.js （全差し替え）

const $ = (id) => document.getElementById(id);

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));

const uniq = (arr) => [...new Set(arr.filter(Boolean))];

// ---------- URL params ----------
const getParams = () => {
  const sp = new URLSearchParams(location.search);
  const cat = sp.get("cat") || "manga";
  const q = sp.get("q") || "";

  const parseSet = (key) => {
    const v = sp.get(key);
    if (!v) return new Set();
    return new Set(v.split(",").map((x) => x.trim()).filter(Boolean));
  };

  return {
    cat,
    q,
    genre: parseSet("g"),
    demo: parseSet("d"),
    publisher: parseSet("p"),
  };
};

const setParams = (next, replace = true) => {
  const sp = new URLSearchParams(location.search);

  if (next.cat != null) sp.set("cat", next.cat);

  if (next.q != null) {
    const q = String(next.q).trim();
    q ? sp.set("q", q) : sp.delete("q");
  }

  const setSet = (key, set) => {
    const v = [...set].join(",");
    v ? sp.set(key, v) : sp.delete(key);
  };

  if (next.genre) setSet("g", next.genre);
  if (next.demo) setSet("d", next.demo);
  if (next.publisher) setSet("p", next.publisher);

  const url = `${location.pathname}?${sp.toString()}`;
  replace ? history.replaceState(null, "", url) : history.pushState(null, "", url);
};

// ---------- Label helpers ----------
const DEMO_LABEL = {
  shonen: "少年",
  shojo: "少女",
  seinen: "青年",
  josei: "女性",
  unknown: "unknown",
  other: "other",
};

// AniList由来の genreKey を想定（必要に応じて足してOK）
const GENRE_LABEL = {
  action_battle: "アクション",
  adventure: "冒険",
  comedy_gag: "ギャグ",
  drama: "ドラマ",
  mystery: "ミステリー",
  romance_lovecom: "恋愛/ラブコメ",
  sports: "スポーツ",
  fantasy: "ファンタジー",
  sci_fi: "SF",
  horror: "ホラー",
  slice_of_life: "日常",
  supernatural: "超常",
  other: "other",
  unknown: "unknown",
};

const labelGenre = (k) => GENRE_LABEL[k] || k;
const labelDemo = (k) => DEMO_LABEL[k] || k;

// publisherは works.json 内の publisher文字列から逆引きする
// （p_xxxxxxxx -> "集英社" みたいな表示名）
const publisherLabelMap = new Map();

// ---------- Data loading ----------
const cache = {
  works: null,      // { workKey: workObj }
  meta: null,       // _meta.json
  index: new Map(), // key: `${facet}/${value}` -> Set(workKey)
};

async function j(url) {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return await r.json();
}

async function loadWorks(cat) {
  const base = `./data/${cat}`;
  $("status") && ($("status").textContent = `読み込み中: ${base}/works.json`);

  try {
    const works = await j(`${base}/works.json?v=${Date.now()}`);
    cache.works = works;

    // publisher表示名の逆引きテーブルを作る
    for (const wk of Object.keys(works)) {
      const w = works[wk];
      const pubIds = w?.tags?.publisher || [];
      const pubName = w?.publisher || "";
      for (const pid of pubIds) {
        if (!publisherLabelMap.has(pid) && pubName) publisherLabelMap.set(pid, pubName);
      }
    }

    // meta は無くても動く（あれば facet一覧に使う）
    try {
      cache.meta = await j(`${base}/index/_meta.json?v=${Date.now()}`);
    } catch {
      cache.meta = null;
    }

    const total = Object.keys(works).length;
    $("status") && ($("status").textContent = `${cat}: works=${total}`);
    return works;
  } catch (e) {
    $("status") && ($("status").textContent = `データがまだありません（./data/${cat}/works.json）`);
    cache.works = {};
    cache.meta = null;
    return {};
  }
}

async function loadIndexSet(cat, facet, value) {
  const k = `${cat}:${facet}/${value}`;
  if (cache.index.has(k)) return cache.index.get(k);

  const url = `./data/${cat}/index/${facet}/${value}.json?v=${Date.now()}`;
  try {
    const arr = await j(url);
    const set = new Set(arr);
    cache.index.set(k, set);
    return set;
  } catch {
    const set = new Set();
    cache.index.set(k, set);
    return set;
  }
}

// ---------- Filtering ----------
function intersects(a, b) {
  // a,b are Set
  const out = new Set();
  // iterate smaller
  const [s1, s2] = a.size <= b.size ? [a, b] : [b, a];
  for (const x of s1) if (s2.has(x)) out.add(x);
  return out;
}

async function applyFilter(cat, state) {
  const works = cache.works || {};
  const allKeys = new Set(Object.keys(works));

  let cur = allKeys;

  // facet: genre
  if (state.genre.size) {
    let union = new Set();
    for (const g of state.genre) {
      const s = await loadIndexSet(cat, "genre", g);
      for (const x of s) union.add(x);
    }
    cur = intersects(cur, union);
  }

  // facet: demo
  if (state.demo.size) {
    let union = new Set();
    for (const d of state.demo) {
      const s = await loadIndexSet(cat, "demo", d);
      for (const x of s) union.add(x);
    }
    cur = intersects(cur, union);
  }

  // facet: publisher
  if (state.publisher.size) {
    let union = new Set();
    for (const p of state.publisher) {
      const s = await loadIndexSet(cat, "publisher", p);
      for (const x of s) union.add(x);
    }
    cur = intersects(cur, union);
  }

  // search query
  const qq = (state.q || "").trim().toLowerCase();
  let keys = [...cur];
  if (qq) {
    keys = keys.filter((wk) => (works[wk]?.title || "").toLowerCase().includes(qq));
  }

  // sort: title asc (後で人気順とか入れるなら差し替え)
  keys.sort((a, b) => (works[a]?.title || "").localeCompare(works[b]?.title || "", "ja"));

  return keys;
}

// ---------- UI building ----------
function ensureFacetsUI() {
  // 既存HTMLに専用領域が無い前提で、listの上に挿入する
  let wrap = $("facets");
  if (wrap) return wrap;

  const list = $("list");
  if (!list) return null;

  wrap = document.createElement("div");
  wrap.id = "facets";
  wrap.style.margin = "12px 0";

  // facets title
  const h = document.createElement("div");
  h.innerHTML = `<div style="font-weight:700;margin:8px 0;">絞り込み</div>`;
  wrap.appendChild(h);

  list.parentNode.insertBefore(wrap, list);
  return wrap;
}

function chipHTML(label, active, data) {
  const on = active ? ' style="font-weight:700;border:1px solid currentColor;"' : ' style="opacity:.85"';
  return `<button type="button" ${data}${on}>${escapeHtml(label)}</button>`;
}

function renderFacetGroup(title, facet, values, selectedSet, labelFn) {
  const chips = values
    .map((v) => chipHTML(labelFn(v), selectedSet.has(v), `data-f="${facet}" data-v="${escapeHtml(v)}"`))
    .join(" ");

  return `
    <div style="margin:10px 0;">
      <div style="font-weight:600;margin:6px 0;">${escapeHtml(title)}</div>
      <div style="display:flex;flex-wrap:wrap;gap:6px;">${chips || '<span style="opacity:.7">（なし）</span>'}</div>
    </div>
  `;
}

function collectFacetValuesFromMeta(facet) {
  // metaがあれば meta のキー一覧を使う。無ければ works から拾う。
  if (cache.meta?.facets?.[facet]) {
    return Object.keys(cache.meta.facets[facet]);
  }
  // fallback: worksから拾う
  const works = cache.works || {};
  const set = new Set();
  for (const wk of Object.keys(works)) {
    const tags = works[wk]?.tags?.[facet] || [];
    for (const t of tags) set.add(t);
  }
  return [...set];
}

function renderFacets(cat, state) {
  const wrap = ensureFacetsUI();
  if (!wrap) return;

  // 値一覧
  const genres = collectFacetValuesFromMeta("genre").sort((a, b) => labelGenre(a).localeCompare(labelGenre(b), "ja"));
  const demos = collectFacetValuesFromMeta("demo").sort((a, b) => labelDemo(a).localeCompare(labelDemo(b), "ja"));
  const pubs = collectFacetValuesFromMeta("publisher").sort((a, b) => {
    const la = publisherLabelMap.get(a) || a;
    const lb = publisherLabelMap.get(b) || b;
    return la.localeCompare(lb, "ja");
  });

  const labelPublisher = (pid) => publisherLabelMap.get(pid) || pid;

  wrap.innerHTML = `
    ${renderFacetGroup("ジャンル", "genre", genres, state.genre, labelGenre)}
    ${renderFacetGroup("区分（少年/少女/青年）", "demo", demos, state.demo, labelDemo)}
    ${renderFacetGroup("出版社", "publisher", pubs, state.publisher, labelPublisher)}
    <div style="margin:10px 0;">
      <button type="button" id="clearFacets">絞り込みをクリア</button>
    </div>
  `;

  wrap.querySelectorAll("button[data-f][data-v]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const f = btn.getAttribute("data-f");
      const v = btn.getAttribute("data-v");
      const next = cloneState(state);

      next[f].has(v) ? next[f].delete(v) : next[f].add(v);

      setParams({ genre: next.genre, demo: next.demo, publisher: next.publisher }, true);
      await refresh(); // stateはURLから再取得
    });
  });

  wrap.querySelector("#clearFacets")?.addEventListener("click", async () => {
    const next = cloneState(state);
    next.genre.clear();
    next.demo.clear();
    next.publisher.clear();
    setParams({ genre: next.genre, demo: next.demo, publisher: next.publisher }, true);
    await refresh();
  });
}

function cloneState(s) {
  return {
    cat: s.cat,
    q: s.q,
    genre: new Set([...s.genre]),
    demo: new Set([...s.demo]),
    publisher: new Set([...s.publisher]),
  };
}

function amazonButtonHTML(w) {
  const url = w?.amazonUrl;
  if (!url) return `<p style="opacity:.7;">Amazon: 準備中</p>`;
  return `<p><a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">Amazonで見る</a></p>`;
}

function tagsToChips(w) {
  const chips = [];

  // genre chips
  for (const g of (w?.tags?.genre || [])) {
    chips.push({ facet: "genre", value: g, label: labelGenre(g) });
  }
  // demo chips
  for (const d of (w?.tags?.demo || [])) {
    chips.push({ facet: "demo", value: d, label: labelDemo(d) });
  }
  // publisher chips
  for (const p of (w?.tags?.publisher || [])) {
    chips.push({ facet: "publisher", value: p, label: w.publisher || publisherLabelMap.get(p) || p });
  }

  return chips
    .map((c) => chipHTML(c.label, false, `data-tag-f="${c.facet}" data-tag-v="${escapeHtml(c.value)}"`))
    .join(" ");
}

function showWorkDetail(wk, state) {
  const d = $("detail");
  if (!d) return;

  const works = cache.works || {};
  const w = works[wk];

  if (!w) {
    d.innerHTML = `<div class="d-title">作品を選ぶと詳細が表示されます</div>`;
    return;
  }

  const meta = [w.author, w.publisher, w.publishedAt].filter(Boolean).join(" / ");
  const chips = tagsToChips(w);

  d.innerHTML = `
    <div class="d-title">${escapeHtml(w.title || "")}</div>
    <div class="d-meta">${escapeHtml(meta)}</div>
    <div class="d-meta" style="margin:8px 0;">
      <div style="font-weight:600;margin:6px 0;">タグ</div>
      <div style="display:flex;flex-wrap:wrap;gap:6px;">${chips || '<span style="opacity:.7">（なし）</span>'}</div>
    </div>
    ${amazonButtonHTML(w)}
    <div class="d-desc">${escapeHtml(w.description || "") || '<span class="d-empty">説明文がありません</span>'}</div>
  `;

  // タグクリック → 該当facetをトグルして即フィルタ
  d.querySelectorAll("button[data-tag-f][data-tag-v]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const f = btn.getAttribute("data-tag-f");
      const v = btn.getAttribute("data-tag-v");
      const next = cloneState(state);

      next[f].has(v) ? next[f].delete(v) : next[f].add(v);

      setParams({ genre: next.genre, demo: next.demo, publisher: next.publisher }, true);
      await refresh();
    });
  });
}

// ---------- List rendering ----------
let view = {
  keys: [],
  shown: 0,
  pageSize: 50,
  selectedWorkKey: null,
};

function ensureMoreButton() {
  let btn = $("more");
  if (btn) return btn;

  const list = $("list");
  if (!list) return null;

  btn = document.createElement("button");
  btn.id = "more";
  btn.type = "button";
  btn.textContent = "さらに表示";
  btn.style.margin = "12px 0";

  list.parentNode.insertBefore(btn, list.nextSibling);
  return btn;
}

function renderList(keys, state) {
  const list = $("list");
  if (!list) return;

  list.innerHTML = "";

  if (!keys.length) {
    list.innerHTML = `<li>該当なし</li>`;
    showWorkDetail(null, state);
    const more = $("more");
    if (more) more.style.display = "none";
    return;
  }

  const works = cache.works || {};
  const slice = keys.slice(0, view.shown);

  slice.forEach((wk) => {
    const w = works[wk];
    const li = document.createElement("li");
    li.innerHTML = `
      <div class="title">${escapeHtml(w?.title || wk)}</div>
      <div class="meta">${escapeHtml([w?.author, w?.publisher].filter(Boolean).join(" / "))}</div>
    `;
    li.addEventListener("click", () => {
      view.selectedWorkKey = wk;
      showWorkDetail(wk, state);
    });
    list.appendChild(li);
  });

  // 初回は先頭を詳細表示
  const first = slice[0];
  if (first && !view.selectedWorkKey) {
    view.selectedWorkKey = first;
    showWorkDetail(first, state);
  } else if (view.selectedWorkKey && works[view.selectedWorkKey]) {
    showWorkDetail(view.selectedWorkKey, state);
  }

  const moreBtn = ensureMoreButton();
  if (moreBtn) {
    moreBtn.style.display = view.shown < keys.length ? "inline-block" : "none";
    moreBtn.onclick = () => {
      view.shown = Math.min(keys.length, view.shown + view.pageSize);
      renderList(keys, state);
    };
  }
}

// ---------- Main sync ----------
let lock = false;

async function refresh() {
  if (lock) return;
  lock = true;

  const state = getParams();

  // UI reflect
  if ($("cat")) $("cat").value = state.cat;
  if ($("q")) $("q").value = state.q;

  // load data if cat changed or not loaded
  if (!cache.works || view._cat !== state.cat) {
    cache.index.clear();
    view._cat = state.cat;
    view.selectedWorkKey = null;
    await loadWorks(state.cat);
  }

  // facets UI
  renderFacets(state.cat, state);

  // compute filtered keys
  const keys = await applyFilter(state.cat, state);
  view.keys = keys;

  // paging
  view.shown = Math.min(keys.length, view.pageSize);
  renderList(keys, state);

  lock = false;
}

function setup() {
  // search box
  if ($("q")) {
    $("q").addEventListener("input", async () => {
      setParams({ q: $("q").value }, true);
      await refresh();
    });
  }

  // cat selector (optional)
  if ($("cat")) {
    $("cat").addEventListener("change", async () => {
      setParams({ cat: $("cat").value }, false);
      await refresh();
    });
  }

  addEventListener("popstate", refresh);
}

setup();
refresh();
