// scripts/manga/fill_series_synopsis.mjs（全差し替え・TARGET_ONLY=workKey→AniList ID 解決版）
//
// 目的: series_master の各シリーズに synopsis(=vol1.description) を埋める
// 優先: overrides > 既存vol1.description > Rakuten(itemCaption by ISBN) > Wikipedia(概要)
//
// 環境変数:
// - RAKUTEN_APP_ID: 楽天API
// - TARGET_ONLY=1 : list_items.json に載ってる「今のN件」だけ処理（※workKey→AniList IDで照合）
// - WIKI_MAX=30   : Wikipedia取得は最大N件まで（暴走防止）
// - DEBUG_KEYS=1  : 照合のデバッグ出力
// - STRICT_MATCH=1: TARGET_ONLY時、照合が弱い/欠損ありなら exit(1)（デフォルトON）
//
// NOTE: workflow 側の検知用マーカー → seriesTitleKeys（文字列として残す）
import fs from "node:fs/promises";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const APP_ID = process.env.RAKUTEN_APP_ID || "";
const TARGET_ONLY = process.env.TARGET_ONLY === "1";
const WIKI_MAX = Number(process.env.WIKI_MAX || "30");
const DEBUG_KEYS = process.env.DEBUG_KEYS === "1";
const STRICT_MATCH =
  process.env.STRICT_MATCH
    ? process.env.STRICT_MATCH === "1"
    : TARGET_ONLY; // TARGET_ONLY時はデフォルトで厳格

const UA = { "User-Agent": "book-scout-bot" };

const SERIES_PATH = "data/manga/series_master.json";
const OVERRIDE_PATH = "data/manga/overrides_synopsis.json";
const LIST_ITEMS_PATH = "data/manga/list_items.json";
const ANILIST_BY_WORK_PATH = "data/manga/anilist_by_work.json";
const WORKS_PATH = "data/manga/works.json";

const digits = (s) => String(s || "").replace(/\D/g, "");
const isDigits = (s) => /^\d+$/.test(String(s || "").trim());

const norm = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/[【】\[\]（）()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

async function readJson(path, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

async function fetchJson(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), 15000);
    try {
      const r = await fetch(url, { cache: "no-store", signal: ac.signal, headers: UA });
      clearTimeout(to);
      const t = await r.text();
      if (r.ok) return JSON.parse(t);
      if ((r.status === 429 || r.status >= 500) && i < tries - 1) {
        await sleep(800 + i * 600);
        continue;
      }
      return null;
    } catch {
      clearTimeout(to);
      if (i < tries - 1) {
        await sleep(800 + i * 600);
        continue;
      }
      return null;
    }
  }
  return null;
}

// --- Rakuten itemCaption by ISBN ---
async function rakutenCaptionByIsbn(isbn13) {
  if (!APP_ID) return null;
  const url =
    "https://app.rakuten.co.jp/services/api/BooksBook/Search/20170404" +
    `?applicationId=${encodeURIComponent(APP_ID)}` +
    `&isbn=${encodeURIComponent(digits(isbn13))}` +
    "&format=json&hits=1&elements=itemCaption";
  const j = await fetchJson(url);
  const cap = (j?.Items?.[0]?.Item?.itemCaption || "").trim();
  return cap || null;
}

// --- Wikipedia (Japanese) ---
async function wikiSearchTitle(q) {
  const url =
    "https://ja.wikipedia.org/w/api.php" +
    `?action=query&list=search&srsearch=${encodeURIComponent(q)}` +
    "&srlimit=5&format=json&origin=*";
  const j = await fetchJson(url);
  return j?.query?.search?.[0]?.title || null;
}

async function wikiExtract(title) {
  if (!title) return null;
  const url =
    "https://ja.wikipedia.org/w/api.php" +
    `?action=query&prop=extracts&explaintext=1&exintro=1&titles=${encodeURIComponent(title)}` +
    "&format=json&origin=*";
  const j = await fetchJson(url);
  const pages = j?.query?.pages || {};
  const firstKey = Object.keys(pages)[0];
  const ex = (pages?.[firstKey]?.extract || "").trim();
  if (!ex) return null;

  const lines = ex.split("\n").map((x) => x.trim()).filter(Boolean);
  const joined = lines.join("\n").trim();
  if (joined.length < 80) return null;

  return joined.length > 900 ? joined.slice(0, 900).trim() + "…" : joined;
}

// --- series_master 構造ゆれ吸収 ---
function unwrapSeriesMaster(root) {
  if (Array.isArray(root)) return { wrapper: null, list: root, kind: "array" };

  if (root && typeof root === "object") {
    if (Array.isArray(root.items)) return { wrapper: root, list: root.items, kind: "wrapper.items.array" };
    if (Array.isArray(root.series)) return { wrapper: root, list: root.series, kind: "wrapper.series.array" };

    if (root.items && typeof root.items === "object" && !Array.isArray(root.items)) {
      return { wrapper: root, list: root.items, kind: "wrapper.items.object" };
    }
    return { wrapper: root, list: root, kind: "object" };
  }
  return { wrapper: null, list: [], kind: "unknown" };
}

function iterSeries(listLike) {
  if (Array.isArray(listLike)) {
    return listLike.map((s, idx) => ({ key: s?.key || s?.id || s?.anilist?.id || s?.title || String(idx), s }));
  }
  if (listLike && typeof listLike === "object") {
    return Object.entries(listLike)
      .filter(([, v]) => v && typeof v === "object")
      .filter(([k]) => k !== "meta" && k !== "items" && k !== "series")
      .map(([key, s]) => ({ key, s }));
  }
  return [];
}

function getSynopsis(s) {
  const cur = s?.vol1?.description;
  return cur ? String(cur).trim() : "";
}
function setSynopsis(s, synopsis) {
  if (!s.vol1) s.vol1 = {};
  s.vol1.description = synopsis;
}

function pickTitleForQuery(key, s) {
  return (
    s?.title ||
    s?.name ||
    s?.workKey ||
    s?.key ||
    s?.anilist?.title?.native ||
    s?.anilist?.title?.romaji ||
    key
  );
}

function pickVol1Isbn(s) {
  const v = s?.vol1 || s?.volume1 || s?.firstVolume || null;
  return v?.isbn13 || v?.isbn || s?.vol1Isbn13 || null;
}

// series_master 側の AniList ID を決める（最優先: keyが数字）
function pickAnilistIdFromSeriesEntry(key, s) {
  const k = String(key || "").trim();
  if (isDigits(k)) return k;

  const cands = [
    s?.anilistId,
    s?.anilist?.id,
    s?.id,
    s?.anilist?.media?.id,
  ];
  for (const v of cands) {
    const ss = String(v || "").trim();
    if (isDigits(ss)) return ss;
  }
  return null;
}

function resolveOverride(overrides, key, seriesId, titleKey) {
  const cands = [
    key,
    seriesId,
    titleKey,
    norm(key),
    norm(seriesId),
    norm(titleKey),
  ].filter(Boolean);

  for (const k of cands) {
    const v = overrides?.[k];
    if (v && String(v).trim()) return String(v).trim();
  }
  return null;
}

// list_items から「今の29件」の workKey/title を集める
function pickWorkKeyFromListItem(it) {
  const cands = [
    it?.workKey,
    it?.seriesKey,
    it?.work?.key,
    it?.work?.workKey,
    it?.series?.key,
    it?.series?.workKey,
    it?.series?.seriesKey,
  ];
  for (const v of cands) {
    const s = String(v || "").trim();
    if (s) return s;
  }
  // 最後の手段: タイトル
  const t = it?.title || it?.latest?.title || it?.series?.title || null;
  return t ? String(t).trim() : null;
}

// anilist_by_work / works から workKey→anilistId を引く
function buildWorkKeyToAnilistId(anilistByWork, works) {
  const map = new Map();

  // anilist_by_work は { key: {...} } or 配列など揺れるので広く拾う
  if (anilistByWork && typeof anilistByWork === "object" && !Array.isArray(anilistByWork)) {
    for (const [k, v] of Object.entries(anilistByWork)) {
      const id = String(v?.anilistId || v?.anilist?.id || v?.id || "").trim();
      if (k && isDigits(id)) map.set(String(k).trim(), id);
    }
  } else if (Array.isArray(anilistByWork)) {
    for (const v of anilistByWork) {
      const k = String(v?.workKey || v?.key || v?.seriesKey || "").trim();
      const id = String(v?.anilistId || v?.anilist?.id || v?.id || "").trim();
      if (k && isDigits(id)) map.set(k, id);
    }
  }

  // works.json も保険で拾う（配列想定）
  if (Array.isArray(works)) {
    for (const w of works) {
      const k = String(w?.workKey || w?.key || w?.seriesKey || w?.id || "").trim();
      const id = String(w?.anilistId || w?.anilist?.id || w?.anilistIdStr || "").trim();
      if (k && isDigits(id) && !map.has(k)) map.set(k, id);
    }
  } else if (works && typeof works === "object") {
    // {items:[...]} などもある
    const arr = Array.isArray(works.items) ? works.items : null;
    if (arr) {
      for (const w of arr) {
        const k = String(w?.workKey || w?.key || w?.seriesKey || w?.id || "").trim();
        const id = String(w?.anilistId || w?.anilist?.id || w?.anilistIdStr || "").trim();
        if (k && isDigits(id) && !map.has(k)) map.set(k, id);
      }
    }
  }

  return map;
}

async function buildTargetSets() {
  const listRaw = await readJson(LIST_ITEMS_PATH, null);
  const list = Array.isArray(listRaw) ? listRaw : (listRaw?.items || []);
  const listItemsCount = Array.isArray(list) ? list.length : 0;

  const targetWorkKeys = new Set();
  const targetSeriesKeys = new Set();
  const seriesTitleKeys = new Set(); // ← marker: seriesTitleKeys（grep対策）

  for (const it of list) {
    const wk = pickWorkKeyFromListItem(it);
    if (wk) targetWorkKeys.add(String(wk).trim());

    const t = it?.title || it?.latest?.title || it?.series?.title || it?.workKey || it?.seriesKey || null;
    if (t) {
      targetSeriesKeys.add(norm(t));
      seriesTitleKeys.add(norm(t));
    }
  }

  // workKey → anilistId を anilist_by_work / works から解決
  const anilistByWork = await readJson(ANILIST_BY_WORK_PATH, null);
  const works = await readJson(WORKS_PATH, null);

  const wk2id = buildWorkKeyToAnilistId(anilistByWork, works);

  const targetAnilistIds = new Set();
  const missingWorkKeys = [];
  for (const wk of targetWorkKeys) {
    const id = wk2id.get(wk);
    if (id) targetAnilistIds.add(id);
    else missingWorkKeys.push(wk);
  }

  return { listItemsCount, targetWorkKeys, missingWorkKeys, targetAnilistIds, targetSeriesKeys, seriesTitleKeys };
}

(async function main() {
  const root = await readJson(SERIES_PATH, {});
  const { list, kind } = unwrapSeriesMaster(root);

  const overridesRaw = await readJson(OVERRIDE_PATH, {});
  const overrides = overridesRaw && typeof overridesRaw === "object" ? overridesRaw : {};

  const seriesEntries = iterSeries(list);

  const { listItemsCount, targetWorkKeys, missingWorkKeys, targetAnilistIds, targetSeriesKeys, seriesTitleKeys } =
    await buildTargetSets();

  // --- 検算（TARGET_ONLY時の事故防止） ---
  const masterIdSet = new Set();
  const masterIdToKey = new Map();

  for (const { key, s } of seriesEntries) {
    const id = pickAnilistIdFromSeriesEntry(key, s);
    if (!id) continue;
    masterIdSet.add(id);
    if (!masterIdToKey.has(id)) masterIdToKey.set(id, String(key).trim());
  }

  const targetIdsArr = Array.from(targetAnilistIds);
  const matched = targetIdsArr.filter((id) => masterIdSet.has(id));
  const missingIds = targetIdsArr.filter((id) => !masterIdSet.has(id));

  if (DEBUG_KEYS) {
    console.log("[fill_series_synopsis] debug targetWorkKeys(sample)=", Array.from(targetWorkKeys).slice(0, 10));
    console.log("[fill_series_synopsis] debug missingWorkKeys(sample)=", missingWorkKeys.slice(0, 10));
    console.log("[fill_series_synopsis] debug targetAnilistIds(sample)=", targetIdsArr.slice(0, 10));
    console.log("[fill_series_synopsis] debug targetSeriesKeys(sample)=", Array.from(targetSeriesKeys).slice(0, 10));
    console.log("[fill_series_synopsis] debug seriesTitleKeys(sample)=", Array.from(seriesTitleKeys).slice(0, 10)); // marker
    console.log("[fill_series_synopsis] debug masterIdSet(sample)=", Array.from(masterIdSet).slice(0, 10));
    console.log("[fill_series_synopsis] check listItems=", listItemsCount, "workKeys=", targetWorkKeys.size, "targetIds=", targetIdsArr.length);
    console.log("[fill_series_synopsis] check matched=", matched.length, "missingIds=", missingIds.length);
    if (missingIds.length) console.log("[fill_series_synopsis] check missingIds(sample)=", missingIds.slice(0, 10));
    if (matched.length) {
      const samp = matched.slice(0, 10).map((id) => `${id}->${masterIdToKey.get(id)}`);
      console.log("[fill_series_synopsis] check matched(sample)=", samp);
    }
  }

  if (TARGET_ONLY && STRICT_MATCH) {
    if (listItemsCount === 0 || targetWorkKeys.size === 0) {
      console.log("[fill_series_synopsis] ERROR: TARGET_ONLY=1 but list_items has no usable workKey/title");
      process.exit(1);
    }
    if (targetIdsArr.length === 0) {
      console.log("[fill_series_synopsis] ERROR: TARGET_ONLY=1 but could not resolve anilist ids from anilist_by_work/works");
      console.log("[fill_series_synopsis] HINT: ensure anilist_by_work.json or works.json has workKey->anilistId mapping");
      process.exit(1);
    }
    if (matched.length === 0) {
      console.log("[fill_series_synopsis] ERROR: TARGET_ONLY=1 but matched=0 (series_master has no matching anilist ids)");
      process.exit(1);
    }
    if (missingIds.length > 0) {
      console.log("[fill_series_synopsis] ERROR: TARGET_ONLY=1 but some target ids are missing in series_master");
      process.exit(1);
    }
  }

  let seen = 0;
  let target = 0;
  let had = 0;
  let triedRakuten = 0;
  let triedWiki = 0;
  let wikiUsed = 0;
  let updated = 0;
  let filled = 0;
  let needsOverride = 0;

  console.log(
    `[fill_series_synopsis] start kind=${kind} entries=${seriesEntries.length} targetOnly=${TARGET_ONLY} wikiMax=${WIKI_MAX} listItems=${listItemsCount} targetWorkKeys=${targetWorkKeys.size} targetAnilistIds=${targetAnilistIds.size}`
  );

  for (const { key, s } of seriesEntries) {
    if (!s || typeof s !== "object") continue;
    seen++;

    const seriesId = pickAnilistIdFromSeriesEntry(key, s);
    const keyId = seriesId ? String(seriesId).trim() : null;

    if (TARGET_ONLY) {
      if (!keyId || !targetAnilistIds.has(keyId)) continue;
      target++;
    }

    const cur = getSynopsis(s);
    const titleKey = norm(pickTitleForQuery(key, s));

    const ov = resolveOverride(overrides, String(key).trim(), keyId, titleKey);
    if (ov) {
      if (ov !== cur) {
        setSynopsis(s, ov);
        updated++;
      } else {
        had++;
      }
      continue;
    }

    if (cur) {
      had++;
      continue;
    }

    let synopsis = null;

    // 1) Rakuten
    const isbn = pickVol1Isbn(s);
    if (APP_ID && isbn) {
      triedRakuten++;
      synopsis = await rakutenCaptionByIsbn(isbn);
      await sleep(180);
    }

    // 2) Wikipedia（予算制限あり）
    if (!synopsis) {
      triedWiki++;
      if (!TARGET_ONLY || wikiUsed < WIKI_MAX) {
        const t = String(pickTitleForQuery(key, s) || "").trim();
        if (t) {
          const page1 = await wikiSearchTitle(t + " 漫画");
          await sleep(200);
          synopsis = await wikiExtract(page1);
          await sleep(200);

          if (!synopsis) {
            const page2 = await wikiSearchTitle(t);
            await sleep(200);
            synopsis = await wikiExtract(page2);
            await sleep(200);
          }

          if (synopsis) wikiUsed++;
        }
      }
    }

    if (synopsis) {
      setSynopsis(s, synopsis);
      filled++;
    } else {
      needsOverride++;
    }
  }

  await fs.writeFile(SERIES_PATH, JSON.stringify(root, null, 2));

  console.log(
    `[fill_series_synopsis] done kind=${kind} seen=${seen} target=${target} had=${had} triedRakuten=${triedRakuten} triedWiki=${triedWiki} wikiUsed=${wikiUsed} updated=${updated} filled=${filled} needsOverride=${needsOverride}`
  );
})();
