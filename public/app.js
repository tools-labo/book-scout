const $ = (id) => document.getElementById(id);

const getParams = () => {
  const sp = new URLSearchParams(location.search);
  return { cat: sp.get("cat") || "manga", q: sp.get("q") || "" };
};

const setParams = (next, replace = true) => {
  const sp = new URLSearchParams(location.search);
  if (next.cat != null) sp.set("cat", next.cat);
  if (next.q != null) {
    const q = String(next.q).trim();
    q ? sp.set("q", q) : sp.delete("q");
  }
  const url = `${location.pathname}?${sp.toString()}`;
  replace ? history.replaceState(null, "", url) : history.pushState(null, "", url);
};

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, c => ({
  "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
}[c]));

async function load(cat) {
  const url = `./data/${cat}/items_master.json`;
  $("status").textContent = `読み込み中: ${url}`;
  try {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const items = await r.json();
    $("status").textContent = `${cat}: ${items.length}件`;
    return items;
  } catch {
    $("status").textContent = `データがまだありません（${url}）`;
    return [];
  }
}

function showDetail(x) {
  const d = $("detail");
  if (!x) {
    d.innerHTML = `<div class="d-title">作品を選ぶと詳細が表示されます</div>`;
    return;
  }
  const meta = [x.author, x.publisher, x.publishedAt].filter(Boolean).join(" / ");
  d.innerHTML = `
    <div class="d-title">${escapeHtml(x.title || "")}</div>
    <div class="d-meta">${escapeHtml(meta)}</div>
    <div class="d-desc">${escapeHtml(x.description || "") || '<span class="d-empty">説明文がありません</span>'}</div>
  `;
}

function render(items, q) {
  const list = $("list");
  list.innerHTML = "";

  const qq = (q || "").trim().toLowerCase();
  const filtered = qq ? items.filter(x => (x.title || "").toLowerCase().includes(qq)) : items;

  if (filtered.length === 0) {
    list.innerHTML = `<li>該当なし</li>`;
    showDetail(null);
    return;
  }

  filtered.forEach((x, i) => {
    const li = document.createElement("li");
    li.innerHTML = `
      <div class="title">${escapeHtml(x.title || "（タイトルなし）")}</div>
      <div class="meta">${escapeHtml([x.author, x.publisher].filter(Boolean).join(" / "))}</div>
    `;
    li.addEventListener("click", () => showDetail(x));
    list.appendChild(li);

    if (i === 0) showDetail(x); // 最初の1件をデフォ表示（UX改善）
  });
}

let all = [];
let lock = false;

async function sync() {
  if (lock) return;
  lock = true;
  const { cat, q } = getParams();
  $("cat").value = cat;
  $("q").value = q;
  all = await load(cat);
  render(all, q);
  lock = false;
}

function setup() {
  $("q").addEventListener("input", () => {
    setParams({ q: $("q").value }, true);
    render(all, $("q").value);
  });

  $("cat").addEventListener("change", async () => {
    setParams({ cat: $("cat").value }, false);
    all = await load($("cat").value);
    render(all, $("q").value);
  });

  addEventListener("popstate", sync);
}

setup();
sync();
