// scripts/manga/anilist_series_master.mjs（全差し替え・TARGET_ONLY対応・既存スキーマ維持）
//
// 目的: data/manga/series_master.json の items を「AniList IDキー」で積み上げる
// TARGET_ONLY=1 のときは list_items(29件) を必ず upsert（既存スキーマを壊さない）
//
// 入力:
// - data/manga/list_items.json（29件）
// - data/manga/anilist_by_work.json（workKey -> anilistId）
// 出力:
// - data/manga/series_master.json（{ meta, items:{ [anilistId]: seriesObj } }）
//
// 環境変数:
// - TARGET_ONLY=1
// - DEBUG_KEYS=1
//
import fs from "node:fs/promises";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TARGET_ONLY = process.env.TARGET_ONLY === "1";
const DEBUG_KEYS = process.env.DEBUG_KEYS === "1";

const SERIES_PATH = "data/manga/series_master.json";
const LIST_ITEMS_PATH = "data/manga/list_items.json";
const ANILIST_BY_WORK_PATH = "data/manga/anilist_by_work.json";

const UA = { "User-Agent": "book-scout-bot" };
const isDigits = (s) => /^\d+$/.test(String(s || "").trim());

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

async function fetchJson(url, body, tries = 3) {
  for (let i = 0; i < tries; i++) {
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), 20000);
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...UA },
        body: JSON.stringify(body),
        cache: "no-store",
        signal: ac.signal,
      });
      clearTimeout(to);
      const t = await r.text();
      if (r.ok) return JSON.parse(t);
      if ((r.status === 429 || r.status >= 500) && i < tries - 1) {
        await sleep(900 + i * 700);
        continue;
      }
      return null;
    } catch {
      clearTimeout(to);
      if (i < tries - 1) {
        await sleep(900 + i * 700);
        continue;
      }
      return null;
    }
  }
  return null;
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

// 既存を優先して保持（破壊しない）。無いところだけ埋める。
function deepMergeKeep(dst, src) {
  if (!dst || typeof dst !== "object") return src;
  if (!src || typeof src !== "object") return dst;

  const out = Array.isArray(dst) ? [...dst] : { ...dst };
  for (const [k, v] of Object.entries(src)) {
    if (v == null) continue;

    if (!(k in out) || out[k] == null) {
      out[k] = v;
      continue;
    }

    if (
      typeof out[k] === "object" &&
      typeof v === "object" &&
      !Array.isArray(out[k]) &&
      !Array.isArray(v)
    ) {
      out[k] = deepMergeKeep(out[k], v);
    }
  }
  return out;
}

const ANILIST_URL = "https://graphql.anilist.co";
const QUERY_BY_IDS = `
query ($ids: [Int]) {
  Page(perPage: 50) {
    media(id_in: $ids, type: MANGA) {
      id
      title { romaji native english }
      format
      status
      genres
      startDate { year month day }
      tags { name rank isAdult }
      siteUrl
    }
  }
}
`;

function toAnilistBlock(m) {
  const tags = Array.isArray(m?.tags) ? m.tags : [];
  const safeTags = tags
    .filter((t) => t && !t.isAdult)
    .map((t) => t.name)
    .filter(Boolean);

  return {
    genres: Array.isArray(m?.genres) ? m.genres : [],
    tags: safeTags,
    format: m?.format || null,
    status: m?.status || null,
    startDate: m?.startDate || null,
    siteUrl: m?.siteUrl || null,
    title: m?.title || null,
  };
}

async function fetchMediaByIds(ids) {
  const uniq = Array.from(new Set(ids)).filter(isDigits);
  const chunks = [];
  for (let i = 0; i < uniq.length; i += 40) chunks.push(uniq.slice(i, i + 40));

  const map = new Map();
  let apiErr = 0;

  for (const chunk of chunks) {
    const vars = { ids: chunk.map((x) => Number(x)) };
    const j = await fetchJson(ANILIST_URL, { query: QUERY_BY_IDS, variables: vars });
    if (!j?.data?.Page?.media) {
      apiErr++;
      await sleep(800);
      continue;
    }
    for (const m of j.data.Page.media) {
      const id = String(m?.id || "").trim();
      if (isDigits(id)) map.set(id, m);
    }
    await sleep(450);
  }

  return { map, apiErr };
}

async function main() {
  const listRaw = await readJson(LIST_ITEMS_PATH, []);
  const list = Array.isArray(listRaw) ? listRaw : (listRaw?.items || []);

  const anilistByWork = await readJson(ANILIST_BY_WORK_PATH, {});
  const wk2id = buildWorkKeyToAnilistId(anilistByWork);

  // list_items -> { workKey, anilistId } を確定
  const target = [];
  const missingWorkKeys = [];

  for (const it of list) {
    const wk = pickWorkKeyFromListItem(it);
    if (!wk) continue;
    const id = wk2id.get(wk);
    if (id) target.push({ workKey: wk, anilistId: id });
    else missingWorkKeys.push(wk);
  }

  const targetIds = target.map((x) => x.anilistId);

  if (DEBUG_KEYS) {
    console.log("[anilist_series_master] debug targetWorkKeys(sample)=", target.map(x => x.workKey).slice(0, 10));
    console.log("[anilist_series_master] debug targetIds(sample)=", targetIds.slice(0, 10));
    console.log("[anilist_series_master] debug missingWorkKeys(sample)=", missingWorkKeys.slice(0, 10));
  }

  // series_master 読み込み（固定：{meta, items:{...}}）
  const root = await readJson(SERIES_PATH, null);
  const seriesMaster =
    root &&
    typeof root === "object" &&
    root.items &&
    typeof root.items === "object" &&
    !Array.isArray(root.items)
      ? root
      : { meta: { createdAt: new Date().toISOString() }, items: {} };

  if (!seriesMaster.meta) seriesMaster.meta = {};
  seriesMaster.meta.updatedAt = new Date().toISOString();

  if (TARGET_ONLY && targetIds.length === 0) {
    console.log("[anilist_series_master] ERROR: TARGET_ONLY=1 but could not resolve target AniList IDs from anilist_by_work");
    process.exit(1);
  }

  // AniList から media をまとめて取る
  const { map: mediaMap, apiErr } = await fetchMediaByIds(targetIds);

  let added = 0;
  let updated = 0;
  let missingFromApi = 0;

  // ここが肝：既存スキーマを維持しつつ、足りない所だけ埋める
  for (const t of target) {
    const id = String(t.anilistId).trim();
    const m = mediaMap.get(id);
    if (!m) {
      missingFromApi++;
      continue;
    }

    const cur = seriesMaster.items[id] || null;

    // 「今のプロジェクトの series_master item 形」に合わせて next を作る
    const next = {
      anilistId: Number(id),
      seriesKey: String(t.workKey || "").trim() || (cur?.seriesKey ?? null),

      titleNative: m?.title?.native || cur?.titleNative || null,
      titleRomaji: m?.title?.romaji || cur?.titleRomaji || null,

      // これらは既存のパイプ（apply_anilist_genres 等）で後から埋めることが多いので、
      // ここでは破壊しない：cur 優先、無ければ null/空
      publisher: cur?.publisher ?? null,
      demo: Array.isArray(cur?.demo) ? cur.demo : [],
      genre: Array.isArray(cur?.genre) ? cur.genre : [],

      vol1: cur?.vol1 && typeof cur.vol1 === "object"
        ? cur.vol1
        : { isbn13: null, description: null, image: null, amazonDp: null },

      wikidataId: cur?.wikidataId ?? null,
      magazines: Array.isArray(cur?.magazines) ? cur.magazines : [],

      // anilist ブロックは更新してOK（ただし既存優先で保持したいものがあれば deepMergeKeep が効く）
      anilist: toAnilistBlock(m),

      updatedAt: new Date().toISOString().slice(0, 10),
    };

    if (!cur) {
      seriesMaster.items[id] = next;
      added++;
    } else {
      seriesMaster.items[id] = deepMergeKeep(cur, next);
      updated++;
    }
  }

  await writeJson(SERIES_PATH, seriesMaster);

  console.log(
    `[anilist_series_master] targetOnly=${TARGET_ONLY} listItems=${list.length} targetWorkKeys=${target.length} targetIds=${targetIds.length} uniqIds=${new Set(targetIds).size} added=${added} updated=${updated} apiErr=${apiErr} missingFromApi=${missingFromApi}`
  );

  if (TARGET_ONLY && missingWorkKeys.length) {
    console.log("[anilist_series_master] WARN missingWorkKeys(sample)=", missingWorkKeys.slice(0, 10));
  }
}

await main();
