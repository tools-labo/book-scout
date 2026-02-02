const $ = (id) => document.getElementById(id);

function getParams() {
  const sp = new URLSearchParams(location.search);
  return {
    cat: sp.get("cat") || "manga",
    q: sp.get("q") || "",
  };
}

function setParams(next, { replace = true } = {}) {
  const sp = new URLSearchParams(location.search);

  if (next.cat != null) sp.set("cat", next.cat);
  if (next.q != null) {
    const q = String(next.q).trim();
    if (q) sp.set("q", q);
    else sp.delete("q");
  }

  const url = `${location.pathname}?${sp.toString()}`;
  if (replace) history.replaceState(null, "", url);
  else history.pushState(null, "", url);
}

async function load(category) {
  const url = `./data/${category}/items_master.json`;
  $("status").textContent = `読み込み中: ${url}`;

  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const items = await res.json();
    $("status").textContent = `${category}: ${items.length}件`;
    return items;
  } catch (e) {
    $("status").textContent = `データがまだありません（${url}）`;
    return [];
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

function render(items, q) {
  const list = $("list");
  list.innerHTML = "";

  const qq = (q || "").trim().toLowerCase();
  const filtered = qq
    ? items.filter((x) => (x.title || "").toLowerCase().includes(qq))
    : items;

  if (filtered.length === 0) {
    list.innerHTML = `<li>該当なし</li>`;
    return;
  }

  for (const x of filtered) {
    const li = document.createElement("li");
    li.innerHTML = `
      <div class="title">${escapeHtml(x.title || "（タイトルなし）")}</div>
      <div class="meta">${escapeHtml([x.author, x.publisher].filter(Boolean).join(" / "))}</div>
    `;
    list.appendChild(li);
  }
}

let all = [];
let loading = false;

async function syncFromUrlAndRender() {
  if (loading) return;
  loading = true;

  const { cat, q } = getParams();

  // UIへ反映
  $("cat").value = cat;
  $("q").value = q;

  // データ読み込み & 描画
  all = await load(cat);
  render(all, q);

  loading = false;
}

function setupEvents() {
  // 検索：入力のたびにURL更新（replace）＋即時描画
  $("q").addEventListener("input", () => {
    const q = $("q").value;
    setParams({ q }, { replace: true });
    render(all, q);
  });

  // カテゴリ変更：pushで履歴を残す（戻る/進むが効く）
  $("cat").addEventListener("change", async () => {
    const cat = $("cat").value;
    setParams({ cat }, { replace: false });
    all = await load(cat);
    render(all, $("q").value);
  });

  // ブラウザの戻る/進む対応
  window.addEventListener("popstate", () => {
    syncFromUrlAndRender();
  });
}

async function main() {
  setupEvents();
  await syncFromUrlAndRender();
}

main();
