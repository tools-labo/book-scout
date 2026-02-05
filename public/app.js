// public/app.js（全差し替え：list_items.json 読みの最短版）

const $ = (id) => document.getElementById(id);

const escapeHtml = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));

const uniq = (arr) => [...new Set((arr || []).filter(Boolean))];

const clamp3Style = `
display:-webkit-box;
-webkit-line-clamp:3;
-webkit-box-orient:vertical;
overflow:hidden;
`;

// ---------- URL params ----------
function getParams() {
  const sp = new URLSearchParams(location.search);
  return {
    cat: sp.get("cat") || "manga",
    q: sp.get("q") || "",
    // facet filters
    genre: new Set((sp.get("g") || "").split(",").map(x => x.trim()).filter(Boolean)),
    demo: new Set((sp.get("d") || "").split(",").map(x => x.trim()).filter(Boolean)),
    publisher: new Set((sp.get("p") || "").split(",").map(x => x.trim()).filter(Boolean)),
  };
}

function setParams(next, replace = true) {
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
}

// ---------- Labels（最低限：表示は key をそのままでも成立） ----------
const DEMO_LABEL = { shonen: "少年", shojo: "少女", seinen: "青年", josei: "女性" };
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
};

const labelDemo = (k) => DEMO_LABEL[k] || k;
const labelGenre = (k) => GENRE_LABEL[k] || k;

// publisherはIDが来る可能性があるので、とりあえずそのまま表示（後で map を入れる）
const labelPublisher = (k) => k;

// ---------- Data loading ----------
async function j(url) {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return await r.json();
}

let cache = {
  cat: null,
  list: [], // list_items.json
};

async function loadList(cat) {
  $("status") && ($("status").textContent = `読み込み中: data/${cat}/list_items.json`);

  try {
    const list = await j(`./data/${cat}/list_items.json?v=${Date.now()}`);
    cache.cat = cat;
    cache.list = Array.isArray(list) ? list : [];
    $("status") && ($("status").textContent = `${cat}: items=${cache.list.length}`);
    return cache.list;
  } catch (e) {
    cache.cat = cat;
    cache.list = [];
    $("status") && ($("status").textContent = `データがありません（data/${cat}/list_items.json）`);
    return [];
  }
}

// ---------- Filtering ----------
function intersectsTag(item, facetKey, selectedSet) {
  if (!selectedSet || selectedSet.size === 0) return true;
  const tags = item?.tags?.[facetKey] || [];
  for (const t of tags) if (selectedSet.has(t)) return true;
  return false;
}

function applyFilter(list, state) {
  const qq = (state.q || "").trim().toLowerCase();

  return list
    .filter((it) => {
      if (qq) {
        const t = (it?.title || "").toLowerCase();
        if (!t.includes(qq)) return false;
      }
      if (!intersectsTag(it, "genre", state.genre)) return false;
      if (!intersectsTag(it, "demo", state.demo)) return false;
      if (!intersectsTag(it, "publisher", state.publisher)) return false;
      return true;
    })
    // “最新刊が新しい順” を基本に（publishedAtが "YYYY年MM月DD日" なので文字列比較は弱いが、まずは volume も併用）
    .sort((a, b) => {
      const da = a?.latest?.publishedAt || "";
      const db = b?.latest?.publishedAt || "";
      if (da !== db) return db.localeCompare(da, "ja");
      const va = Number(a?.latest?.volume || 0);
      const vb = Number(b?.latest?.volume || 0);
      return vb - va;
    });
}

// ---------- Facets UI（最短：list_itemsから収集してチップ表示） ----------
function ensureFacetsUI() {
  let wrap = $("facets");
  if (wrap) return wrap;

  const list = $("list");
  if (!list) return null;

  wrap = document.createElement("div");
  wrap.id = "facets";
  wrap.style.margin = "12px 0";
  list.parentNode.insertBefore(wrap, list);
  return wrap;
}

function chipHTML(label, active, attrs) {
  const on = active ? ' style="font-weight:700;border:1px solid currentColor;"' : ' style="opacity:.85"';
  return `<button type="button" ${attrs}${on}>${escapeHtml(label)}</button>`;
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

function collectFacetValues(list, facetKey) {
  const set = new Set();
  for (const it of list) {
    for (const t of (it?.tags?.[facetKey] || [])) set.add(t);
  }
  return [...set];
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

function renderFacets(state, list) {
  const wrap = ensureFacetsUI();
  if (!wrap) return;

  const genres = collectFacetValues(list, "genre").sort((a, b) => labelGenre(a).localeCompare(labelGenre(b), "ja"));
  const demos = collectFacetValues(list, "demo").sort((a, b) => labelDemo(a).localeCompare(labelDemo(b), "ja"));
  const pubs = collectFacetValues(list, "publisher").sort((a, b) => labelPublisher(a).localeCompare(labelPublisher(b), "ja"));

  wrap.innerHTML = `
    ${renderFacetGroup("ジャンル", "genre", genres, state.genre, labelGenre)}
    ${renderFacetGroup("区分", "demo", demos, state.demo, labelDemo)}
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
      await refresh();
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

// ---------- List rendering ----------
let view = { pageSize: 50, shown: 50 };

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

function tagChipsHTML(it) {
  const chips = [];
  for (const g of (it?.tags?.genre || [])) chips.push({ facet: "genre", value: g, label: labelGenre(g) });
  for (const d of (it?.tags?.demo || [])) chips.push({ facet: "demo", value: d, label: labelDemo(d) });
  for (const p of (it?.tags?.publisher || [])) chips.push({ facet: "publisher", value: p, label: labelPublisher(p) });

  return chips
    .map((c) => chipHTML(c.label, false, `data-tag-f="${c.facet}" data-tag-v="${escapeHtml(c.value)}"`))
    .join(" ");
}

function bindTagClicks(container, state) {
  container.querySelectorAll("button[data-tag-f][data-tag-v]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.preventDefault();
      const f = btn.getAttribute("data-tag-f");
      const v = btn.getAttribute("data-tag-v");
      const next = cloneState(state);
      next[f].has(v) ? next[f].delete(v) : next[f].add(v);
      setParams({ genre: next.genre, demo: next.demo, publisher: next.publisher }, true);
      await refresh();
    });
  });
}

function renderList(listFiltered, state) {
  const ul = $("list");
  if (!ul) return;

  ul.innerHTML = "";

  if (!listFiltered.length) {
    ul.innerHTML = `<li>該当なし</li>`;
    const more = $("more");
    if (more) more.style.display = "none";
    return;
  }

  const slice = listFiltered.slice(0, view.shown);

  for (const it of slice) {
    const seriesKey = it?.seriesKey || "";
    const seriesUrl = `./work.html?cat=${encodeURIComponent(state.cat)}&w=${encodeURIComponent(seriesKey)}`;

    const title = it?.title || seriesKey;
    const author = it?.author || "";
    const publisher = it?.publisher || "";
    const latestVol = it?.latest?.volume ?? "";
    const latestDate = it?.latest?.publishedAt || "";

    // 1巻（メイン）→ 無ければ準備中
    const vol1Amazon = it?.vol1?.amazonDp || null;
    const latestAmazon = it?.latest?.amazonDp || null;

    const img = it?.vol1?.image || it?.latest?.image || null; // latest.imageが無い場合もあるので保険
    const desc = it?.vol1?.description || "";

    const tagsHTML = tagChipsHTML(it);

    const li = document.createElement("li");
    li.innerHTML = `
      <div style="display:flex;gap:10px;align-items:flex-start;">
        <a href="${seriesUrl}" style="display:block;flex:0 0 auto;">
          ${img ? `<img src="${escapeHtml(img)}" alt="" style="width:64px;height:96px;object-fit:cover;border-radius:6px;">`
                : `<div style="width:64px;height:96px;border-radius:6px;background:#eee;"></div>`}
        </a>

        <div style="flex:1 1 auto;min-width:0;">
          <div class="title" style="display:flex;gap:8px;align-items:baseline;flex-wrap:wrap;">
            <a href="${seriesUrl}" style="color:inherit;text-decoration:none;font-weight:700;">
              ${escapeHtml(title)}
            </a>
            <span style="opacity:.7;">最新 ${escapeHtml(String(latestVol))}巻 / ${escapeHtml(latestDate)}</span>
          </div>

          <div class="meta" style="margin-top:4px;">
            ${escapeHtml([author, publisher].filter(Boolean).join(" / "))}
          </div>

          <div style="margin-top:8px;">
            <a href="${vol1Amazon ? escapeHtml(vol1Amazon) : "#"}"
               target="${vol1Amazon ? "_blank" : "_self"}"
               rel="noopener noreferrer"
               style="${vol1Amazon ? "" : "pointer-events:none;opacity:.5;"}">
              Amazon（1巻）で見る
            </a>
            ${latestAmazon ? ` <span style="opacity:.6;">|</span>
              <a href="${escapeHtml(latestAmazon)}" target="_blank" rel="noopener noreferrer">
                Amazon（最新巻）
              </a>` : ""}
          </div>

          <div style="margin-top:8px;">
            <div class="desc" style="${clamp3Style}">
              ${desc ? escapeHtml(desc) : '<span style="opacity:.7;">説明文がありません（1巻DBが未整備）</span>'}
            </div>
            ${desc ? `<button type="button" class="toggleDesc" style="margin-top:6px;">続きを読む</button>` : ""}
          </div>

          <div style="margin-top:10px;">
            <div style="display:flex;flex-wrap:wrap;gap:6px;">
              ${tagsHTML || '<span style="opacity:.7">（タグなし）</span>'}
            </div>
          </div>
        </div>
      </div>
    `;

    // 「続きを読む」トグル
    const btn = li.querySelector(".toggleDesc");
    if (btn) {
      const descEl = li.querySelector(".desc");
      let open = false;
      btn.addEventListener("click", () => {
        open = !open;
        if (open) {
          descEl.style.display = "block";
          descEl.style.overflow = "visible";
          descEl.style.webkitLineClamp = "unset";
          descEl.style.webkitBoxOrient = "unset";
          btn.textContent = "折りたたむ";
        } else {
          descEl.setAttribute("style", clamp3Style);
          btn.textContent = "続きを読む";
        }
      });
    }

    bindTagClicks(li, state);
    ul.appendChild(li);
  }

  const moreBtn = ensureMoreButton();
  if (moreBtn) {
    moreBtn.style.display = view.shown < listFiltered.length ? "inline-block" : "none";
    moreBtn.onclick = () => {
      view.shown = Math.min(listFiltered.length, view.shown + view.pageSize);
      renderList(listFiltered, state);
    };
  }
}

// ---------- Main ----------
let lock = false;

async function refresh() {
  if (lock) return;
  lock = true;

  const state = getParams();

  if ($("cat")) $("cat").value = state.cat;
  if ($("q")) $("q").value = state.q;

  if (cache.cat !== state.cat) {
    await loadList(state.cat);
    view.shown = view.pageSize;
  }

  const list = cache.list || [];
  renderFacets(state, list);

  const filtered = applyFilter(list, state);
  $("status") && ($("status").textContent = `${state.cat}: 表示 ${filtered.length} 件`);
  renderList(filtered, state);

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
      setParams({ cat: $("cat").value }, false);
      await refresh();
    });
  }

  addEventListener("popstate", refresh);
}

setup();
loadList(getParams().cat).then(refresh);
