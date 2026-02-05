// public/app.js（全差し替え / list_items.json 読みの最短版）

const $ = (id) => document.getElementById(id);

const escapeHtml = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));

const getParams = () => {
  const sp = new URLSearchParams(location.search);
  return {
    cat: sp.get("cat") || "manga",
    q: sp.get("q") || "",
    w: sp.get("w") || "", // workKey
  };
};

const setParams = (next, replace = true) => {
  const sp = new URLSearchParams(location.search);

  const cat = next.cat ?? sp.get("cat") ?? "manga";
  sp.set("cat", cat);

  if (next.q != null) {
    const q = String(next.q).trim();
    q ? sp.set("q", q) : sp.delete("q");
  }

  if (next.w != null) {
    const w = String(next.w).trim();
    w ? sp.set("w", w) : sp.delete("w");
  }

  const url = `${location.pathname}?${sp.toString()}`;
  replace ? history.replaceState(null, "", url) : history.pushState(null, "", url);
};

async function j(url) {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return await r.json();
}

function isListPage() {
  return (
    location.pathname.endsWith("/list.html") ||
    location.pathname.endsWith("list.html") ||
    location.pathname.endsWith("/")
  );
}

const cache = {
  cat: null,
  list: [], // list_items
  byWork: new Map(), // workKey -> best item (latest by volumeHint or publishedAt)
};

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function cmpLatest(a, b) {
  // volumeHint 優先（大きい方が新しい想定）。無ければ publishedAt の文字列比較（雑でOK）
  const av = toNum(a?.volumeHint);
  const bv = toNum(b?.volumeHint);
  if (av != null || bv != null) return (bv ?? -1) - (av ?? -1);
  const ap = String(a?.publishedAt ?? "");
  const bp = String(b?.publishedAt ?? "");
  return bp.localeCompare(ap, "ja");
}

function buildWorkMap(list) {
  const m = new Map();
  for (const it of list || []) {
    const wk = it?.workKey;
    if (!wk) continue;
    const cur = m.get(wk);
    if (!cur) m.set(wk, it);
    else if (cmpLatest(it, cur) < 0) {
      // cur の方が新しいので維持
    } else {
      m.set(wk, it);
    }
  }
  return m;
}

async function loadListItems(cat) {
  const base = `./data/${cat}`;
  $("status") && ($("status").textContent = `読み込み中: ${base}/list_items.json`);

  try {
    const list = await j(`${base}/list_items.json?v=${Date.now()}`);
    cache.cat = cat;
    cache.list = Array.isArray(list) ? list : [];
    cache.byWork = buildWorkMap(cache.list);

    $("status") && ($("status").textContent = `${cat}: items=${cache.list.length} works=${cache.byWork.size}`);
  } catch (e) {
    cache.cat = cat;
    cache.list = [];
    cache.byWork = new Map();
    $("status") && ($("status").textContent = `データがありません（${base}/list_items.json）`);
  }
}

function filterWorks(q) {
  const qq = String(q || "").trim().toLowerCase();
  let arr = [...cache.byWork.entries()].map(([workKey, item]) => ({ workKey, item }));

  if (qq) {
    arr = arr.filter(({ item, workKey }) => {
      const t = (item?.seriesTitle || item?.title || workKey || "").toLowerCase();
      return t.includes(qq);
    });
  }

  // 最新巻が上に来るように
  arr.sort((a, b) => cmpLatest(a.item, b.item));
  return arr;
}

function amazonButtonHTML(it) {
  const url = it?.amazonUrl;
  if (!url) return `<p style="opacity:.7;">Amazon: 準備中</p>`;
  return `<p><a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">Amazonで見る</a></p>`;
}

function renderList(rows, state) {
  const listEl = $("list");
  if (!listEl) return;

  listEl.innerHTML = "";

  if (!rows.length) {
    listEl.innerHTML = `<li>該当なし</li>`;
    renderDetail(null, state);
    return;
  }

  for (const { workKey, item } of rows) {
    const li = document.createElement("li");
    const seriesTitle = item?.seriesTitle || item?.title || workKey;
    const vol = item?.volumeHint != null ? ` ${item.volumeHint}` : "";
    const meta = [item?.author, item?.publisher].filter(Boolean).join(" / ");

    li.innerHTML = `
      <div class="title">${escapeHtml(seriesTitle)}<span style="opacity:.8;">${escapeHtml(vol)}</span></div>
      <div class="meta">${escapeHtml(meta)}</div>
    `;

    li.addEventListener("click", () => {
      setParams({ w: workKey }, true);
      renderDetail(workKey, state);
    });

    listEl.appendChild(li);
  }

  // 初期選択（URLのw優先、無ければ先頭）
  const initial = state.w && cache.byWork.has(state.w) ? state.w : rows[0].workKey;
  if (initial) {
    setParams({ w: initial }, true);
    renderDetail(initial, state);
  }
}

function renderDetail(workKey, state) {
  const d = $("detail");
  if (!d) return;

  if (!workKey) {
    d.innerHTML = `<div class="d-title">作品を選ぶと詳細が表示されます</div>`;
    return;
  }

  const it = cache.byWork.get(workKey);
  if (!it) {
    d.innerHTML = `<div class="d-title">作品が見つかりません</div>`;
    return;
  }

  const title = it?.seriesTitle || it?.title || workKey;
  const vol = it?.volumeHint != null ? ` ${it.volumeHint}` : "";
  const meta = [
    it?.author,
    it?.publisher,
    it?.publishedAt ? `発売: ${it.publishedAt}` : null,
  ].filter(Boolean).join(" / ");

  const desc = it?.desc || it?.description || "";

  d.innerHTML = `
    <div class="d-title">${escapeHtml(title)}<span style="opacity:.8;">${escapeHtml(vol)}</span></div>
    <div class="d-meta">${escapeHtml(meta)}</div>
    ${amazonButtonHTML(it)}
    <div class="d-desc">${desc ? escapeHtml(desc) : '<span class="d-empty">説明文がありません</span>'}</div>
  `;
}

let lock = false;

async function refresh() {
  if (lock) return;
  lock = true;

  const state = getParams();

  if ($("cat")) $("cat").value = state.cat;
  if ($("q")) $("q").value = state.q;

  if (cache.cat !== state.cat) {
    await loadListItems(state.cat);
  }

  const rows = filterWorks(state.q);
  renderList(rows, state);

  lock = false;
}

function setup() {
  if ($("q")) {
    $("q").addEventListener("input", async () => {
      setParams({ q: $("q").value }, true);
      await refresh();
    });
  }

  if ($("cat")) {
    $("cat").addEventListener("change", async () => {
      setParams({ cat: $("cat").value, w: "" }, false);
      await loadListItems($("cat").value);
      await refresh();
    });
  }

  addEventListener("popstate", refresh);
}

if (isListPage()) {
  setup();
  refresh();
} else {
  // list.html以外で読み込まれても落ちないように
  setup();
}
