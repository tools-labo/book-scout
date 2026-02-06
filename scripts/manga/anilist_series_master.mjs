// scripts/manga/anilist_series_master.mjs（全差し替え・TARGET_ONLY堅牢化版）
//
// 目的: series_master.json を「作品単位のマスタ」として積み上げる
// 重要: TARGET_ONLY=1 のときは list_items(29件) に載ってる作品だけを必ず upsert し、
//       29件が series_master に揃ったことをこのスクリプトで保証する（欠けたら exit 1）
//
// 入力:
// - data/manga/list_items.json（29件）
// - data/manga/anilist_by_work.json（workKey -> anilistId を持っている想定）
// 出力:
// - data/manga/series_master.json（{meta, items:{[anilistId]: seriesObj}}）
//
// 環境変数:
// - TARGET_ONLY=1 : 29件だけを確実に入れる
// - DEBUG_KEYS=1  : デバッグ
//
import fs from "node:fs/promises";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TARGET_ONLY = process.env.TARGET_ONLY === "1";
const DEBUG_KEYS = process.env.DEBUG_KEYS === "1";

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

      // 429/5xx はリトライ
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
  // ★表記ゆれ吸収：キーは norm(wk) で保存
  const map = new Map();

  if (anilistByWork && typeof anilistByWork === "object" && !Array.isArray(anilistByWork)) {
    for (const [wkRaw, v] of Object.entries(anilistByWork)) {
      const wk = norm(wkRaw);
      const id = String(v?.anilistId || v?.anilist?.id || v?.id || "").trim();
      if (wk && isDigits(id)) map.set(wk, id);
    }
  } else if (Array.isArray(anilistByWork)) {
    for (const v of anilistByWork) {
      const wk = norm(v?.workKey || v?.key || v?.seriesKey || "");
      const id = String(v?.anilistId || v?.anilist?.id || v?.id || "").trim();
      if (wk && isDigits(id)) map.set(wk, id);
    }
  }
  return map;
}

const ANILIST_URL = "https://graphql.anilist.co";

// Page + media(id_in) でまとめ取得
const QUERY_BY_IDS = `
query ($ids: [Int]) {
  Page(page: 1, perPage: 50) {
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
    authors.push({ role, name });
  }

  return {
    anilistId: Number(m.id),
    seriesKey: null, // 後で必要なら別スクリプトで埋める
    titleNative: m?.title?.native || null,
    titleRomaji: m?.title?.romaji || null,
    publisher: null,
    demo: [],
    genre: [],
    vol1: {
      description: null,
      isbn13: null,
      image: null,
      amazonDp: null,
    },
    wikidataId: null,
    magazines: [],
    anilist: {
      title: m.title || null,
      siteUrl: m.siteUrl || null,
      format: m.format || null,
      status: m.status || null,
      genres: Array.isArray(m.genres) ? m.genres : [],
      tags: [], // tagsは別工程(anilist_tags)で持ってるなら合わせる
      coverImage: m.coverImage || null,
      startDate: m.startDate || null,
      description: (m.description || "").trim() || null,
      authors,
      studios: m?.studios?.nodes?.map((x) => x?.name).filter(Boolean) || [],
    },
    updatedAt: new Date().toISOString().slice(0, 10),
  };
}

function deepMergeKeep(dst, src) {
  // dstを優先保持し、無いところだけsrcを埋める
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

async function upsertByTargetIds(seriesMaster, ids) {
  const uniq = Array.from(new Set(ids)).filter(isDigits);

  // 40ずつ → Page(perPage=50) なので余裕あり
  const chunks = [];
  for (let i = 0; i < uniq.length; i += 40) chunks.push(uniq.slice(i, i + 40));

  let added = 0;
  let updated = 0;
  let apiErr = 0;
  let missing = 0;

  for (const chunk of chunks) {
    const want = new Set(chunk.map((x) => String(x)));
    const vars = { ids: chunk.map((x) => Number(x)) };

    const j = await fetchJson(ANILIST_URL, { query: QUERY_BY_IDS, variables: vars });
    if (!j || !j.data) {
      apiErr++;
      // ここで止める（成功扱いしない）
      console.log("[anilist_series_master] ERROR: AniList API returned null/invalid response");
      process.exit(1);
    }

    const media = j?.data?.Page?.media || [];
    const got = new Set(media.map((m) => String(m?.id || "")).filter(isDigits));

    // 欠けを数える（次工程で死ぬ前にここで止める）
    for (const id of want) {
      if (!got.has(id)) missing++;
    }

    for (const m of media) {
      const id = String(m?.id || "").trim();
      if (!isDigits(id)) continue;

      const cur = seriesMaster.items[id] || null;
      const next = toSeriesObj(m);

      if (!cur) {
        seriesMaster.items[id] = next;
        added++;
      } else {
        seriesMaster.items[id] = deepMergeKeep(cur, next);
        updated++;
      }
    }

    await sleep(450);
  }

  return { added, updated, apiErr, missing, uniqCount: uniq.length };
}

function assertTargetsPresent(seriesMaster, targetIds) {
  const miss = [];
  for (const id of targetIds) {
    const k = String(id);
    if (!seriesMaster.items[k]) miss.push(k);
  }
  return miss;
}

async function main() {
  const listRaw = await readJson(LIST_ITEMS_PATH, []);
  const list = Array.isArray(listRaw) ? listRaw : (listRaw?.items || []);

  const anilistByWork = await readJson(ANILIST_BY_WORK_PATH, {});
  const wk2id = buildWorkKeyToAnilistId(anilistByWork);

  // list_itemsから workKey を集める（normして持つ）
  const targetWorkKeys = new Set();
  for (const it of list) {
    const wk = pickWorkKeyFromListItem(it);
    if (wk) targetWorkKeys.add(norm(wk));
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
  seriesMaster.meta.updatedAt = new Date().toISOString().slice(0, 10);

  // ★ metaに変なものが混ざってたらここで除去（JIS混入対策）
  if (seriesMaster.meta.vol1) delete seriesMaster.meta.vol1;

  let result = { added: 0, updated: 0, apiErr: 0, missing: 0, uniqCount: 0 };

  if (TARGET_ONLY) {
    if (targetIds.length === 0) {
      console.log("[anilist_series_master] ERROR: TARGET_ONLY=1 but could not resolve target AniList IDs (anilist_by_work mismatch)");
      process.exit(1);
    }
    if (missingWorkKeys.length > 0) {
      console.log("[anilist_series_master] ERROR: TARGET_ONLY=1 but some workKeys are missing in anilist_by_work");
      console.log("[anilist_series_master] missingWorkKeys(sample)=", missingWorkKeys.slice(0, 20));
      process.exit(1);
    }

    result = await upsertByTargetIds(seriesMaster, targetIds);

    // ★ここが肝：29件が揃ったことを保証
    const missingIds = assertTargetsPresent(seriesMaster, targetIds);
    if (missingIds.length > 0) {
      console.log("[anilist_series_master] ERROR: TARGET_ONLY=1 but some target ids are still missing in series_master");
      console.log("[anilist_series_master] missingIds(sample)=", missingIds.slice(0, 20));
      process.exit(1);
    }
  } else {
    // 非TARGET運用は今は安全のため何もしない（将来拡張）
  }

  await writeJson(SERIES_PATH, seriesMaster);

  console.log(
    `[anilist_series_master] targetOnly=${TARGET_ONLY} listItems=${list.length} targetWorkKeys=${targetWorkKeys.size} targetIds=${targetIds.length} uniqIds=${result.uniqCount} added=${result.added} updated=${result.updated} apiErr=${result.apiErr} missingFromApi=${result.missing}`
  );
}

await main();
