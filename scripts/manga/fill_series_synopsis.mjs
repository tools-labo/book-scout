// scripts/manga/fill_series_synopsis.mjs（全差し替え・TARGET_ONLY=workKey→AniListID照合・AniList description fallback）
//
// 目的: series_master の各シリーズに synopsis(=vol1.description) を埋める
// 優先: overrides > 既存vol1.description > AniList description > Rakuten(itemCaption by ISBN) > Wikipedia(概要)
//
// 環境変数:
// - RAKUTEN_APP_ID: 楽天API
// - TARGET_ONLY=1 : list_items.json に載ってる作品だけ処理（workKey→anilist_by_work→anilistId で照合）
// - WIKI_MAX=30   : Wikipedia取得は最大N件まで（暴走防止）
// - DEBUG_KEYS=1  : デバッグ出力
//
// NOTE: workflow 側の検知用マーカー → seriesTitleKeys（文字列として残す）

import fs from "node:fs/promises";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const APP_ID = process.env.RAKUTEN_APP_ID || "";
const TARGET_ONLY = process.env.TARGET_ONLY === "1";
const WIKI_MAX = Number(process.env.WIKI_MAX || "30");
const DEBUG_KEYS = process.env.DEBUG_KEYS === "1";

const SERIES_PATH = "data/manga/series_master.json";
const LIST_ITEMS_PATH = "data/manga/list_items.json";
const ANILIST_BY_WORK_PATH = "data/manga/anilist_by_work.json";
const OVERRIDES_PATH = "data/manga/overrides_synopsis.json";
const TODO_PATH = "data/manga/overrides_synopsis.todo.json";

const UA = { "User-Agent": "book-scout-bot" };
const digits = (s) => String(s || "").replace(/\D/g, "");
const isDigits = (s) => /^\d+$/.test(String(s || "").trim());

const norm = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/[【】\[\]（）()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

function stripHtmlToText(html) {
  const s = String(html || "");
  if (!s.trim()) return "";
  // <br>系を改行に
  let t = s.replace(/<\s*br\s*\/?\s*>/gi, "\n");
  // 斜体などは中身だけ残す
  t = t.replace(/<\/?i>/gi, "");
  // 残りタグ除去
  t = t.replace(/<[^>]+>/g, "");
  // 代表的なエンティティだけ最低限
  t = t
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  // 空行/空白整理
  t = t.replace(/\r/g, "");
  t = t.replace(/[ \t]+\n/g, "\n");
  t = t.replace(/\n{3,}/g, "\n\n").trim();
  return t;
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await fs.readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(path, obj) {
  await fs.writeFile(path, JSON.stringify(obj, null, 2));
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
  const isbn = digits(isbn13);
  if (isbn.length !== 13) return null;

  const url =
    "https://app.rakuten.co.jp/services/api/BooksBook/Search/20170404" +
    `?applicationId=${encodeURIComponent(APP_ID)}` +
    `&isbn=${encodeURIComponent(isbn)}` +
    `&format=json`;

  const j = await fetchJson(url);
  const items = j?.Items || [];
  const it = items?.[0]?.Item || null;
  const cap = it?.itemCaption ? String(it.itemCaption).trim() : "";
  return cap || null;
}

// --- Wikipedia summary ---
async function wikiSummaryByTitle(title) {
  const t = String(title || "").trim();
  if (!t) return null;

  // ja Wikipedia の summary API
  const url =
    "https://ja.wikipedia.org/api/rest_v1/page/summary/" +
    encodeURIComponent(t);

  const j = await fetchJson(url);
  // extract の中身が概要
  const ex = j?.extract ? String(j.extract).trim() : "";
  // disambiguationっぽいときは弾く
  if (!ex) return null;
  if (j?.type === "disambiguation") return null;
  return ex || null;
}

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
  const t = it?.title || it?.latest?.title || it?.series?.title || null;
  return t ? String(t).trim() : null;
}

function buildWorkKeyToAnilistId(anilistByWork) {
  const map = new Map();
  if (anilistByWork && typeof anilistByWork === "object" && !Array.isArray(anilistByWork)) {
    for (const [wk, v] of Object.entries(anilistByWork)) {
      const id = String(v?.anilistId || v?.anilist?.id || v?.id || "").trim();
      if (wk && isDigits(id)) map.set(String(wk).trim(), id);
    }
  } else if (Array.isArray(anilistByWork)) {
    for (const v of anilistByWork) {
      const wk = String(v?.workKey || v?.key || v?.seriesKey || "").trim();
      const id = String(v?.anilistId || v?.anilist?.id || v?.id || "").trim();
      if (wk && isDigits(id)) map.set(wk, id);
    }
  }
  return map;
}

async function buildTargetSets() {
  const listRaw = await readJson(LIST_ITEMS_PATH, []);
  const list = Array.isArray(listRaw) ? listRaw : (listRaw?.items || []);

  const anilistByWork = await readJson(ANILIST_BY_WORK_PATH, {});
  const wk2id = buildWorkKeyToAnilistId(anilistByWork);

  const targetWorkKeys = new Set();
  for (const it of list) {
    const wk = pickWorkKeyFromListItem(it);
    if (wk) targetWorkKeys.add(String(wk).trim());
  }

  const targetIds = [];
  const missingWorkKeys = [];
  for (const wk of targetWorkKeys) {
    const id = wk2id.get(wk);
    if (id) targetIds.push(id);
    else missingWorkKeys.push(wk);
  }

  // marker: seriesTitleKeys（grep対策）
  const seriesTitleKeys = new Set();

  // “タイトルキー”としては、workKey をそのまま/正規化したもの両方を持つ（Wiki検索の候補）
  for (const wk of targetWorkKeys) {
    seriesTitleKeys.add(norm(wk));
  }

  if (DEBUG_KEYS) {
    console.log("[fill_series_synopsis] debug targetWorkKeys(sample)=", Array.from(targetWorkKeys).slice(0, 10));
    console.log("[fill_series_synopsis] debug targetIds(sample)=", targetIds.slice(0, 10));
    console.log("[fill_series_synopsis] debug missingWorkKeys(sample)=", missingWorkKeys.slice(0, 10));
    console.log("[fill_series_synopsis] debug seriesTitleKeys(sample)=", Array.from(seriesTitleKeys).slice(0, 10));
  }

  return { listItemsCount: list.length, targetWorkKeys, targetIds, missingWorkKeys, seriesTitleKeys };
}

async function main() {
  const root = await readJson(SERIES_PATH, null);
  const seriesMaster =
    root && typeof root === "object" && root.items && typeof root.items === "object" && !Array.isArray(root.items)
      ? root
      : { meta: { createdAt: new Date().toISOString() }, items: {} };

  const items = seriesMaster.items || {};
  const allIds = Object.keys(items);

  const { listItemsCount, targetWorkKeys, targetIds, missingWorkKeys, seriesTitleKeys } = await buildTargetSets();

  const masterIdSet = new Set(allIds);

  // TARGET_ONLY=1 なら、対象IDが series_master 側に揃っているかチェック
  if (TARGET_ONLY) {
    if (targetIds.length === 0) {
      console.log("[fill_series_synopsis] ERROR: TARGET_ONLY=1 but targetIds is empty");
      process.exit(1);
    }
    const miss = targetIds.filter((id) => !masterIdSet.has(String(id)));
    if (miss.length) {
      console.log("[fill_series_synopsis] ERROR: TARGET_ONLY=1 but some target ids are missing in series_master");
      console.log("[fill_series_synopsis] missingIds(sample)=", miss.slice(0, 10));
      process.exit(1);
    }
  }

  const overrides = await readJson(OVERRIDES_PATH, {});
  const todo = {};

  let seen = 0;
  let target = 0;
  let had = 0;
  let triedRakuten = 0;
  let triedWiki = 0;
  let wikiUsed = 0;
  let updated = 0;
  let filled = 0;
  const needsOverride = [];

  // 処理対象ID
  const targetIdSet = new Set(TARGET_ONLY ? targetIds.map(String) : allIds.map(String));

  // Wikiの暴走防止（TARGET_ONLY時はWIKI_MAXが効く）
  let wikiBudget = TARGET_ONLY ? Math.max(0, WIKI_MAX) : 999999;

  for (const id of allIds) {
    if (!targetIdSet.has(String(id))) continue;

    const s = items[id];
    if (!s || typeof s !== "object") continue;

    seen++;
    target++;

    const seriesKey = s.seriesKey || s.titleNative || s?.anilist?.title?.native || s?.anilist?.title?.romaji || "";
    const title = s.titleNative || s?.anilist?.title?.native || s?.anilist?.title?.romaji || seriesKey || "";

    // 1) overrides
    const ov = overrides?.[id]?.synopsis;
    const ovText = typeof ov === "string" ? ov.trim() : "";
    if (ovText) {
      const cur = s?.vol1?.description ? String(s.vol1.description).trim() : "";
      if (cur !== ovText) {
        s.vol1 = s.vol1 || {};
        s.vol1.description = ovText;
        updated++;
      } else {
        had++;
      }
      continue;
    }

    // 2) existing
    const curDesc = s?.vol1?.description ? String(s.vol1.description).trim() : "";
    if (curDesc) {
      had++;
      continue;
    }

    // 3) AniList description fallback（今回の4件はこれがある）
    const aniDescRaw = s?.anilist?.description || "";
    const aniDesc = stripHtmlToText(aniDescRaw);
    if (aniDesc) {
      s.vol1 = s.vol1 || {};
      s.vol1.description = aniDesc;
      filled++;
      updated++;
      continue;
    }

    // 4) Rakuten by ISBN（isbn13がある場合のみ）
    const isbn13 = s?.vol1?.isbn13 || null;
    if (isbn13) {
      triedRakuten++;
      const cap = await rakutenCaptionByIsbn(isbn13);
      if (cap) {
        s.vol1 = s.vol1 || {};
        s.vol1.description = cap;
        filled++;
        updated++;
        continue;
      }
      await sleep(250);
    }

    // 5) Wikipedia（残っていて、予算がある場合）
    if (wikiBudget > 0) {
      triedWiki++;
      wikiBudget--;

      // 検索は「日本語タイトル優先」→ダメなら seriesKey でもう一回
      const q1 = String(s?.anilist?.title?.native || title || "").trim();
      const q2 = String(seriesKey || "").trim();

      let w = await wikiSummaryByTitle(q1);
      if (!w && q2 && q2 !== q1) w = await wikiSummaryByTitle(q2);

      if (w) {
        s.vol1 = s.vol1 || {};
        s.vol1.description = w;
        wikiUsed++;
        filled++;
        updated++;
        continue;
      }
      await sleep(200);
    }

    // それでも無理 → needsOverride
    needsOverride.push({
      anilistId: String(id),
      title: String(title || ""),
      seriesKey: String(seriesKey || ""),
      vol1Isbn13: s?.vol1?.isbn13 ?? null,
    });

    // TODO には下書き用の箱を作る
    todo[id] = {
      title: String(title || ""),
      seriesKey: String(seriesKey || ""),
      vol1Isbn13: s?.vol1?.isbn13 ?? null,
      synopsis: "",
    };
  }

  // 保存
  if (updated > 0) {
    seriesMaster.meta = seriesMaster.meta || {};
    seriesMaster.meta.updatedAt = new Date().toISOString().slice(0, 10);
    await writeJson(SERIES_PATH, seriesMaster);
  }

  if (needsOverride.length > 0) {
    await writeJson(TODO_PATH, todo);
    console.log(`[fill_series_synopsis] wrote ${TODO_PATH}`);
  }

  console.log(
    `[fill_series_synopsis] seen=${seen} targetOnly=${TARGET_ONLY} had=${had} triedRakuten=${triedRakuten} triedWiki=${triedWiki} wikiUsed=${wikiUsed} updated=${updated} filled=${filled} needsOverride=${needsOverride.length} listItems=${listItemsCount}`
  );

  if (DEBUG_KEYS && needsOverride.length) {
    console.log("[fill_series_synopsis] needsOverride(items)=", needsOverride);
  }

  // ここは落とさない。todoを吐いた上で続行（CIを止めない）
}

await main();
