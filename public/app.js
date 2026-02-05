// public/app.js （list_items.json 読みの最短版：全差し替え）

const $ = (id) => document.getElementById(id);

const escapeHtml = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));

const digits = (s) => String(s || "").replace(/\D/g, "");

const getParams = () => {
  const sp = new URLSearchParams(location.search);
  return {
    cat: sp.get("cat") || "manga",
    q: sp.get("q") || "",
    s: sp.get("s") || "", // seriesKey
  };
};

const setParams = (next, replace = true) => {
  const sp = new URLSearchParams(location.search);

  if (next.cat != null) sp.set("cat", String(next.cat));

  if (next.q != null) {
    const q = String(next.q).trim();
    q ? sp.set("q", q) : sp.delete("q");
  }

  if (next.s != null) {
    const s = String(next.s).trim();
    s ? sp.set("s", s) : sp.delete("s");
  }

  const url = `${location.pathname}?${sp.toString()}`;
  replace ? history.replaceState(null, "", url) : history.pushState(null, "", url);
};

async function j(url) {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return await r.json();
}

function safeStr(v) {
  const s = (v == null ? "" : String(v)).trim();
  return s ? s : null;
}

function normAmazonDp(u) {
  if (!u) return null;
  const s = String(u).trim();
  const m = s.match(/^https:\/\/www\.amazon\.co\.jp\/dp\/([A-Z0-9]{10}|[0-9]{9}X|[0-9]{10})(?:[/?].*)?$/i);
  if (m) return `https://www.amazon.co.jp/dp/${m[1]}`;
  const asin = s.toUpperCase().replace(/[^0-9A-Z]/g, "");
  if (/^[A-Z0-9]{10}$/.test(asin)) return `https://www.amazon.co.jp/dp/${asin}`;
  return null;
}

function parseJpDateToSortKey(s) {
  // "2026年03月04日" -> 20260304（ダメなら 0）
  const d = digits(s);
  if (d.length >= 8) return Number(d.slice(0, 8));
  return 0;
}

function sortLatestDesc(a, b) {
  const ad = parseJpDateToSortKey(a?.latest?.publishedAt);
  const bd = parseJpDateToSortKey(b?.latest?.publishedAt);
  if (ad !== bd) return bd - ad;

  const av = Number.isFinite(Number(a?.latest?.volume)) ? Number(a.latest.volume) : -1;
  const bv = Number.isFinite(Number(b?.latest?.volume)) ? Number(b.latest.volume) : -1;
  if (av !== bv) return bv - av;

  const at = String(a?.title || "");
  const bt = String(b?.title || "");
  return at.localeCompare(bt, "ja");
}

function matchQuery(it, q) {
  if (!q) return true;
  const needle = q.toLowerCase();
  const hay = [
    it?.title,
    it?.seriesKey,
    it?.author,
    it?.publisher,
  ].map((x) => String(x || "").toLowerCase()).join(" ");
  return hay.includes(needle);
}

function latestLine(it) {
  const v = it?.latest?.volume ?? null;
  const pub = safeStr(it?.latest?.publishedAt);
  const parts = [];
  if (v != null) parts.push(`最新 ${v}巻`);
  if (pub) parts.push(pub);
  return parts.join(" / ");
}

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

function renderList(items, state, view) {
  const list = $("list");
  if (!list) return;

  list.innerHTML = "";

  if (!items.length) {
    list.innerHTML = `<li>該当なし</li>`;
    renderDetail(null);
    const more = $("more");
    if (more) more.style.display = "none";
    return;
  }

  const slice = items.slice(0, view.shown);

  for (const it of slice) {
    const sk = it.seriesKey;
    const title = it?.title || sk;

    const li = document.createElement("li");
    li.innerHTML = `
      <div class="title">${escapeHtml(title)}</div>
      <div class="meta">${escapeHtml([safeStr(it.author), safeStr(it.publisher)].filter(Boolean).join(" / "))}</div>
      <div class="meta">${escapeHtml(latestLine(it))}</div>
    `;

    li.addEventListener("click", () => {
      view.selected = sk;
      setParams({ s: sk }, true);
      renderDetail(it);
    });

    list.appendChild(li);
  }

  // 初回は selected が無ければ先頭を詳細表示
  if (!view.selected) {
    view.selected = slice[0]?.seriesKey || null;
    setParams({ s: view.selected }, true);
  }

  const selectedItem = items.find((x) => x.seriesKey === view.selected) || slice[0] || null;
  renderDetail(selectedItem);

  const moreBtn = ensureMoreButton();
  if (moreBtn) {
    moreBtn.style.display = view.shown < items.length ? "inline-block" : "none";
    moreBtn.onclick = () => {
      view.shown = Math.min(items.length, view.shown + view.pageSize);
      renderList(items, state, view);
    };
  }
}

function tagsHTML(tags) {
  if (!tags) return "";
  const chips = [];
  for (const g of (tags.genre || [])) chips.push(`ジャンル:${g}`);
  for (const d of (tags.demo || [])) chips.push(`区分:${d}`);
  for (const p of (tags.publisher || [])) chips.push(`出版社:${p}`);
  if (!chips.length) return "";
  return `
    <div class="d-meta" style="margin:10px 0;">
      <div style="font-weight:600;margin:6px 0;">タグ</div>
      <div style="display:flex;flex-wrap:wrap;gap:6px;">
        ${chips.map((t) => `<span style="border:1px solid rgba(0,0,0,.15);padding:2px 8px;border-radius:999px;font-size:.9em;">${escapeHtml(t)}</span>`).join("")}
      </div>
    </div>
  `;
}

function renderDetail(it) {
  const d = $("detail");
  if (!d) return;

  if (!it) {
    d.innerHTML = `<div class="d-title">作品を選ぶと詳細が表示されます</div>`;
    return;
  }

  const title = it?.title || it?.seriesKey || "";
  const meta = [safeStr(it.author), safeStr(it.publisher)].filter(Boolean).join(" / ");

  const latest = it.latest || {};
  const latestDp = normAmazonDp(latest.amazonDp);
  const latestAsin = safeStr(latest.asin);

  const vol1 = it.vol1 || {};
  const vol1Desc = safeStr(vol1.description);
  const vol1Img = safeStr(vol1.image);
  const vol1Dp = normAmazonDp(vol1.amazonDp);

  const latestText = latestLine(it);
  const latestLinkHTML = latestDp
    ? `<p><a href="${escapeHtml(latestDp)}" target="_blank" rel="noopener noreferrer">Amazonで最新巻を見る</a>${latestAsin ? ` <span style="opacity:.6;font-size:.9em;">(${escapeHtml(latestAsin)})</span>` : ""}</p>`
    : `<p style="opacity:.7;">Amazon（最新巻）: 準備中</p>`;

  const vol1LinkHTML = vol1Dp
    ? `<p><a href="${escapeHtml(vol1Dp)}" target="_blank" rel="noopener noreferrer">Amazonで1巻を見る</a></p>`
    : "";

  const imgHTML = vol1Img
    ? `<div style="margin:10px 0;"><img src="${escapeHtml(vol1Img)}" alt="${escapeHtml(title)}" style="max-width:100%;height:auto;border-radius:8px;" /></div>`
    : "";

  const descHTML = vol1Desc
    ? `<div class="d-desc">${escapeHtml(vol1Desc)}</div>`
    : `<div class="d-desc"><span class="d-empty">説明文がありません</span></div>`;

  d.innerHTML = `
    <div class="d-title">${escapeHtml(title)}</div>
    <div class="d-meta">${escapeHtml(meta)}</div>
    <div class="d-meta" style="margin-top:6px;">${escapeHtml(latestText)}</div>

    ${imgHTML}
    ${latestLinkHTML}
    ${vol1LinkHTML}
    ${tagsHTML(it.tags)}
    ${descHTML}
  `;
}

// ---------- Main ----------
const cache = { items: null, cat: null };

const view = {
  pageSize: 50,
  shown: 50,
  selected: null,
};

async function loadListItems(cat) {
  const base = `./data/${cat}`;
  $("status") && ($("status").textContent = `読み込み中: ${base}/list_items.json`);

  try {
    const items = await j(`${base}/list_items.json?v=${Date.now()}`);
    $("status") && ($("status").textContent = `${cat}: items=${items.length}`);
    return Array.isArray(items) ? items : [];
  } catch {
    $("status") && ($("status").textContent = `データがまだありません（./data/${cat}/list_items.json）`);
    return [];
  }
}

let lock = false;

async function refresh() {
  if (lock) return;
  lock = true;

  const state = getParams();

  // cat切替時に再ロード
  if (!cache.items || cache.cat !== state.cat) {
    cache.cat = state.cat;
    cache.items = await loadListItems(state.cat);
  }

  // UI同期
  if ($("cat")) $("cat").value = state.cat;
  if ($("q")) $("q").value = state.q;

  view.selected = state.s || null;
  view.shown = view.pageSize;

  const items = (cache.items || [])
    .filter((it) => matchQuery(it, state.q))
    .slice()
    .sort(sortLatestDesc);

  renderList(items, state, view);

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
      setParams({ cat: $("cat").value, s: "" }, false);
      // cat変えたらキャッシュ捨て
      cache.items = null;
      await refresh();
    });
  }

  addEventListener("popstate", refresh);
}

setup();
refresh();
