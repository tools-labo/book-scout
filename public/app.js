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

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));

async function load(cat) {
  const base = `./data/${cat}/items_master.json`;
  const url = `${base}?v=${Date.now()}`; // キャッシュ回避
  $("status").textContent = `読み込み中: ${base}`;

  try {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const items = await r.json();
    const works = items.filter((x) => x._rep).length;
    $("status").textContent = `${cat}: ${works}作品（data ${items.length}件）`;
    return items;
  } catch {
    $("status").textContent = `データがまだありません（${base}）`;
    return [];
  }
}

function amazonLink(x) {
  if (x?.amazonUrl) return x.amazonUrl;
  if (x?.asin) return `https://www.amazon.co.jp/dp/${encodeURIComponent(x.asin)}`;
  return null;
}

function groupByWork(items) {
  const m = new Map();
  for (const it of items) {
    const k = it.workKey || it.title;
    const g = m.get(k) || [];
    g.push(it);
    m.set(k, g);
  }
  return m;
}

const order = { main: 0, spinoff: 1, guide: 2, art: 3, other: 9 };
const stKey = (t) => order[t] ?? 9;

function pickWorkRep(group) {
  return group.find((x) => x._rep) || group.find((x) => x.seriesType === "main") || group[0] || null;
}

// seriesTypeごとに代表を1つにする（優先: _rep > volumeHint=1 > 先に来たもの）
function repsBySeriesType(group) {
  const map = new Map();
  for (const it of group) {
    const k = it.seriesType || "other";
    const cur = map.get(k);
    if (!cur) {
      map.set(k, it);
      continue;
    }
    if (!cur._rep && it._rep) { map.set(k, it); continue; }
    if (cur.volumeHint !== 1 && it.volumeHint === 1) { map.set(k, it); continue; }
  }
  return [...map.values()].sort((a, b) => stKey(a.seriesType) - stKey(b.seriesType));
}

function showWorkDetail(group, initialItem) {
  const d = $("detail");
  if (!group || group.length === 0) {
    d.innerHTML = `<div class="d-title">作品を選ぶと詳細が表示されます</div>`;
    return;
  }

  const reps = repsBySeriesType(group);

  // ★ここが修正点：クリックした行（initialItem）を優先して表示
  let current =
    (initialItem && group.find((x) => x.isbn13 === initialItem.isbn13)) ||
    group.find((x) => x._rep) ||
    reps.find((x) => x.seriesType === "main") ||
    reps[0];

  const render = () => {
    const meta = [current.author, current.publisher, current.publishedAt].filter(Boolean).join(" / ");

    const a = amazonLink(current) || amazonLink(group.find((x) => amazonLink(x)) || null);
    const btn = a
      ? `<p><a href="${escapeHtml(a)}" target="_blank" rel="noopener noreferrer">Amazonで見る</a></p>`
      : "";

    const chips = reps
      .map((x) => {
        const label = x.seriesType || "other";
        const on = x.seriesType === current.seriesType ? ' style="font-weight:700"' : "";
        return `<button data-st="${escapeHtml(label)}"${on}>${escapeHtml(label)}</button>`;
      })
      .join(" ");

    d.innerHTML = `
      <div class="d-title">${escapeHtml(current.title || "")}</div>
      <div class="d-meta">${escapeHtml(meta)}</div>
      <div class="d-meta">シリーズ: ${chips}</div>
      ${btn}
      <div class="d-desc">${escapeHtml(current.description || "") || '<span class="d-empty">説明文がありません</span>'}</div>
    `;

    d.querySelectorAll("button[data-st]").forEach((el) => {
      el.addEventListener("click", () => {
        const st = el.getAttribute("data-st");
        // seriesTypeの代表へ切り替え（_rep優先で安定）
        current = reps.find((x) => (x.seriesType || "other") === st) || current;
        render();
      });
    });
  };

  render();
}

function render(items, q) {
  const list = $("list");
  list.innerHTML = "";

  const byWork = groupByWork(items);
  const works = [];
  for (const [wk, group] of byWork) {
    const rep = pickWorkRep(group);
    if (!rep) continue;
    works.push({ rep, group });
  }

  const qq = (q || "").trim().toLowerCase();
  const filtered = qq
    ? works.filter((w) => (w.rep.title || "").toLowerCase().includes(qq))
    : works;

  if (filtered.length === 0) {
    list.innerHTML = `<li>該当なし</li>`;
    showWorkDetail(null);
    return;
  }

  filtered.forEach((w, i) => {
    const x = w.rep;
    const li = document.createElement("li");
    li.innerHTML = `
      <div class="title">${escapeHtml(x.title || "（タイトルなし）")}</div>
      <div class="meta">${escapeHtml([x.author, x.publisher].filter(Boolean).join(" / "))}</div>
    `;
    // ★ここが修正点：クリックしたrepを渡す
    li.addEventListener("click", () => showWorkDetail(w.group, w.rep));
    list.appendChild(li);
    if (i === 0) showWorkDetail(w.group, w.rep);
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
