// scripts/lane2/format_lane2.mjs
// FULL REPLACE
// - input: data/lane2/enriched/index.json + enriched_XXX.json
// - output: data/lane2/works/index.json + works_XXX.json
import fs from "node:fs/promises";
import path from "node:path";

const IN_ENRICH_DIR = "data/lane2/enriched";
const IN_ENRICH_INDEX = `${IN_ENRICH_DIR}/index.json`;

const OUT_WORKS_DIR = "data/lane2/works";
const OUT_WORKS_INDEX = `${OUT_WORKS_DIR}/index.json`;
const OUT_WORKS_PREFIX = "works_";
const SHARD_SIZE = 200;

function norm(s) {
  return String(s ?? "").trim();
}
function uniq(arr) {
  const out = [];
  const seen = new Set();
  for (const x of arr || []) {
    const s = norm(x);
    if (!s) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

async function loadJson(p, fallback) {
  try {
    return JSON.parse(await fs.readFile(p, "utf8"));
  } catch {
    return fallback;
  }
}
async function loadJsonStrict(p) {
  const txt = await fs.readFile(p, "utf8");
  try {
    return JSON.parse(txt);
  } catch (e) {
    const msg = e?.message ? String(e.message) : String(e);
    throw new Error(`[lane2:format] JSON parse failed: ${p} (${msg})`);
  }
}
async function saveJson(p, obj) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(obj, null, 2));
}

function compact(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (v == null) continue;
    if (typeof v === "string" && !v.trim()) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    if (typeof v === "object" && !Array.isArray(v)) {
      const inner = compact(v);
      if (Object.keys(inner).length === 0) continue;
      out[k] = inner;
      continue;
    }
    out[k] = v;
  }
  return out;
}

function shardFileName(prefix, i) {
  return `${prefix}${String(i).padStart(3, "0")}.json`;
}

// ★フロント必須（あなたのUI要件に合わせ）
function isFrontRequiredFilled(v) {
  const req = {
    title: norm(v?.title),
    author: norm(v?.author),
    publisher: norm(v?.publisher),
    releaseDate: norm(v?.releaseDate),
    image: norm(v?.image),
    amazonDp: norm(v?.amazonDp),
    amazonUrl: norm(v?.amazonUrl),
    synopsis: norm(v?.synopsis),
    magazine: norm(v?.magazine),
    audiencesOk: Array.isArray(v?.audiences) && v.audiences.length > 0,
  };

  return !!(
    req.title &&
    req.author &&
    req.publisher &&
    req.releaseDate &&
    req.image &&
    req.amazonDp &&
    req.amazonUrl &&
    req.synopsis &&
    req.magazine &&
    req.audiencesOk
  );
}

async function loadEnrichedItems() {
  const idx = await loadJsonStrict(IN_ENRICH_INDEX);
  const shards = Array.isArray(idx?.shards) ? idx.shards : [];
  const all = [];

  for (const sh of shards) {
    const file = norm(sh?.file);
    if (!file) continue;
    const p = path.join(IN_ENRICH_DIR, file);
    const j = await loadJson(p, { items: [] });
    const items = Array.isArray(j?.items) ? j.items : [];
    all.push(...items);
  }

  return { idx, items: all };
}

async function writeWorksSharded({ items, dropped, updatedAt }) {
  await fs.mkdir(OUT_WORKS_DIR, { recursive: true });

  const total = items.length;
  const nShards = Math.max(1, Math.ceil(total / SHARD_SIZE));

  const shards = [];
  const lookup = {};
  const listItems = [];

  for (let i = 0; i < nShards; i++) {
    const slice = items.slice(i * SHARD_SIZE, (i + 1) * SHARD_SIZE);
    const file = shardFileName(OUT_WORKS_PREFIX, i);

    shards.push({ file, count: slice.length });

    for (const it of slice) {
      const sk = norm(it?.seriesKey);
      if (!sk) continue;
      lookup[sk] = i;

      // index 用の軽量リスト（list.html がこれだけで回る想定）
      listItems.push(
        compact({
          seriesKey: it.seriesKey ?? null,
          title: it.title ?? null,
          image: it.image ?? null,
          amazonDp: it.amazonDp ?? null,
          amazonUrl: it.amazonUrl ?? null,
          magazine: it.magazine ?? null,
          magazines: it.magazines ?? [],
          audiences: it.audiences ?? [],
          genres: it.genres ?? [],
          tags: it.tags ?? [],
          publisher: it.publisher ?? null,
          releaseDate: it.releaseDate ?? null,
        })
      );
    }

    await saveJson(path.join(OUT_WORKS_DIR, file), {
      version: 1,
      shard: i,
      count: slice.length,
      items: slice,
    });
  }

  await saveJson(OUT_WORKS_INDEX, {
    version: 1,
    updatedAt: updatedAt,
    total,
    droppedTotal: dropped.length,
    droppedSeriesKeys: dropped,
    shardSize: SHARD_SIZE,
    shards,
    lookup,
    listItems,
  });
}

async function main() {
  const { idx, items } = await loadEnrichedItems();

  const kept = [];
  const dropped = [];

  for (const x of items) {
    const v = x?.vol1 || {};
    if (!isFrontRequiredFilled(v)) {
      dropped.push(norm(x?.seriesKey) || "(unknown)");
      continue;
    }

    const meta = {
      anilistId: v?.anilistId ?? null,
      wikiTitle: v?.wikiTitle ?? null,
      source: v?.source ?? null,
    };

    kept.push(
      compact({
        seriesKey: x?.seriesKey ?? null,

        // 表示
        title: v?.title ?? null,
        author: v?.author ?? null,
        publisher: v?.publisher ?? null,
        releaseDate: v?.releaseDate ?? null,
        image: v?.image ?? null,

        // Amazon
        amazonUrl: v?.amazonUrl ?? null,
        amazonDp: v?.amazonDp ?? null,
        isbn13: v?.isbn13 ?? null,
        asin: v?.asin ?? null,

        synopsis: v?.synopsis ?? null,

        // 連載誌（表示と分類に使う）
        magazine: v?.magazine ?? null,
        magazines: uniq(v?.magazines),
        audiences: uniq(v?.audiences),
        magazineSource: v?.magazineSource ?? null,

        // AniList
        genres: uniq(v?.genres),
        tags: uniq(v?.tags).slice(0, 24),

        meta,
      })
    );
  }

  const updatedAt = norm(idx?.updatedAt) || new Date().toISOString();

  await writeWorksSharded({ items: kept, dropped, updatedAt });

  console.log(
    `[lane2:format] total_in=${items.length} total_out=${kept.length} dropped=${dropped.length} -> ${OUT_WORKS_INDEX}`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
