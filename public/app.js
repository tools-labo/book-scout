const $ = (id) => document.getElementById(id);

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

function render(items, q) {
  const list = $("list");
  list.innerHTML = "";
  const qq = (q || "").trim().toLowerCase();

  const filtered = qq
    ? items.filter(x => (x.title || "").toLowerCase().includes(qq))
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

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
}

let all = [];

async function main() {
  const cat = $("cat");
  all = await load(cat.value);
  render(all, $("q").value);

  $("q").addEventListener("input", () => render(all, $("q").value));
  cat.addEventListener("change", async () => {
    all = await load(cat.value);
    render(all, $("q").value);
  });
}

main();
