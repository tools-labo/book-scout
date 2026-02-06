// scripts/manga/anilist_series_master.mjs（全差し替え・TARGET_ONLY対応版）
//
// 目的: series_master.json を「作品単位のマスタ」として積み上げる
// 重要: TARGET_ONLY=1 のときは list_items(29件) に載ってる作品だけを必ず upsert する
//
// 入力:
// - data/manga/list_items.json（29件）
// - data/manga/anilist_by_work.json（workKey -> anilistId を持っている想定）
// 出力:
// - data/manga/series_master.json（{meta, items:{[anilistId]: seriesObj}}）
//
// 環境変数:
// - ANILIST_PER_PAGE / ANILIST_PAGES : （任意）従来のページング拡張を残したい場合
// - TARGET_ONLY=1 : 29件だけを確実に入れる
// - DEBUG_KEYS=1  : デバッグ
//
import fs from "node:fs/promises";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TARGET_ONLY = process.env.TARGET_ONLY === "1";
const DEBUG_KEYS = process.env.DEBUG_KEYS === "1";
const PER_PAGE = Number(process.env.ANILIST_PER_PAGE || "100");
const PAGES = Number(process.env.ANILIST_PAGES || "1");

const SERIES_PATH = "data/manga/series_master.json";
const LIST_ITEMS_PATH = "data/manga/list_items.json";
const ANILIST_BY_WORK_PATH = "data/manga/anilist_by_work.json";

const UA = { "User-Agent": "book-scout-bot" };

const norm = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/[【】\[\]（）()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

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

const ANILIST_URL = "https://graphql.anilist.co";

const QUERY_BY_IDS = `
query ($ids: [Int]) {
  Page(perPage: 50) {
    media(id_in: $ids, type: MANGA) {
      id
      title { romaji native english }
      format
      status
      description(asHtml: false)
      genres
      siteUrl
      coverImage { large medium }
      startDate { year month day }
      staff(sort: [ROLE, RELEVANCE], perPage: 10) {
        edges { role node { name { full native } } }
      }
      studios(isMain: true) { nodes { name } }
    }
  }
}
`;

function toSeriesObj(m) {
  const authors = [];
  const staffEdges = m?.staff?.edges || [];
  for (const e of staffEdges) {
    const role = String(e?.role || "");
    const name = e?.node?.name?.full || e?.node?.name?.native || "";
    if (!name) continue;
    // “Story” “Art” など厳密分類は後回し。とりあえず収集しておく
    authors.push({ role, name });
  }

  return {
    anilist: {
      id: String(m.id),
      title: m.title || null,
      siteUrl: m.siteUrl || null,
      format: m.format || null,
      status: m.status || null,
      genres: Array.isArray(m.genres) ? m.genres : [],
      coverImage: m.coverImage || null,
      startDate: m.startDate || null,
      description: (m.description || "").trim() || null,
      authors,
      studios: m?.studios?.nodes?.map((x) => x?.name).filter(Boolean) || [],
    },
    // synopsis用の箱（後工程がここを埋める）
    vol1: {
      description: null,
      isbn13: null,
    },
    updatedAt: new Date().toISOString(),
  };
}

function deepMergeKeep(dst, src) {
  // dst を優先して保持しつつ、無いところだけ src を埋める（安全寄り）
  if (!dst || typeof dst !== "object") return src;
  if (!src || typeof src !== "object") return dst;

  const out = Array.isArray(dst) ? [...dst] : { ...dst };
  for (const [k, v] of Object.entries(src)) {
    if (v == null) continue;
    if (!(k in out) || out[k] == null) {
      out[k] = v;
      continue;
    }
    if (typeof out[k] === "object" && typeof v === "object" && !Array.isArray(out[k]) && !Array.isArray(v)) {
      out[k] = deepMergeKeep(out[k], v);
    }
  }
  return out;
}

async function upsertByTargetIds(seriesMaster, ids) {
  const uniq = Array.from(new Set(ids)).filter(isDigits);
  const chunks = [];
  for (let i = 0; i < uniq.length; i += 40) chunks.push(uniq.slice(i, i + 40));

  let added = 0;
  let updated = 0;

  for (const chunk of chunks) {
    const vars = { ids: chunk.map((x) => Number(x)) };
    const j = await fetchJson(ANILIST_URL, { query: QUERY_BY_IDS, variables: vars });
    const media = j?.data?.Page?.media || [];

    for (const m of media) {
      const id = String(m?.id || "").trim();
      if (!isDigits(id)) continue;

      const cur = seriesMaster.items[id] || null;
      const next = toSeriesObj(m);

      if (!cur) {
        seriesMaster.items[id] = next;
        added++;
      } else {
        // 既存 vol1.description 等は保持する（消さない）
        const merged = deepMergeKeep(cur, next);
        // vol1.description は cur 優先で保持される設計
        seriesMaster.items[id] = merged;
        updated++;
      }
    }

    await sleep(450);
  }

  return { added, updated };
}

async function main() {
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

  if (DEBUG_KEYS) {
    console.log("[anilist_series_master] debug targetWorkKeys(sample)=", Array.from(targetWorkKeys).slice(0, 10));
    console.log("[anilist_series_master] debug targetIds(sample)=", targetIds.slice(0, 10));
    console.log("[anilist_series_master] debug missingWorkKeys(sample)=", missingWorkKeys.slice(0, 10));
  }

  // series_master 読み込み（構造固定：{meta, items:{...}}）
  const root = await readJson(SERIES_PATH, null);
  const seriesMaster =
    root && typeof root === "object" && root.items && typeof root.items === "object" && !Array.isArray(root.items)
      ? root
      : { meta: { createdAt: new Date().toISOString() }, items: {} };

  if (!seriesMaster.meta) seriesMaster.meta = {};
  seriesMaster.meta.updatedAt = new Date().toISOString();

  // --- 1) まず TARGET_ONLY なら target を必ず入れる ---
  let a1 = { added: 0, updated: 0 };
  if (TARGET_ONLY) {
    if (targetIds.length === 0) {
      console.log("[anilist_series_master] ERROR: TARGET_ONLY=1 but could not resolve target AniList IDs from anilist_by_work");
      process.exit(1);
    }
    a1 = await upsertByTargetIds(seriesMaster, targetIds);
  }

  // --- 2) （任意）従来のページング増殖を残したい場合 ---
  // TARGET_ONLY=1 のときは暴走防止でやらない（必要なら別ジョブに分離）
  let added2 = 0;
  let updated2 = 0;

  if (!TARGET_ONLY && PAGES > 0) {
    // ここは “人気ページングで積む” など、従来方式があるなら実装する余地
    // 今回は安全のため何もしない（将来ここを拡張）
  }

  await writeJson(SERIES_PATH, seriesMaster);

  console.log(
    `[anilist_series_master] targetOnly=${TARGET_ONLY} listItems=${list.length} targetWorkKeys=${targetWorkKeys.size} targetIds=${targetIds.length} added=${a1.added + added2} updated=${a1.updated + updated2}`
  );
}

await main();
