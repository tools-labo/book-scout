// scripts/lane2/format_lane2.mjs（FULL REPLACE）
import fs from "node:fs/promises";
import path from "node:path";

const IN_ENRICHED = "data/lane2/enriched.json";

// legacy (互換用)
const OUT_WORKS_LEGACY = "data/lane2/works.json";

// new split outputs
const OUT_DIR = "data/lane2/works";
const OUT_INDEX = "data/lane2/works/index.json";

// shard settings
const SHARD_SIZE = 200;

async function loadJson(p, fallback) {
  try {
    return JSON.parse(await fs.readFile(p, "utf8"));
  } catch {
    return fallback;
  }
}
async function saveJson(p, obj) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(obj, null, 2));
}

function norm(s) { return String(s ?? "").trim(); }
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

// ★フロント必須（現行仕様）
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

function pad3(n) { return String(n).padStart(3, "0"); }
function shardFileName(i) { return `works_${pad3(i)}.json`; }

function toListItem(full) {
  // List/Home用の軽量形（author/synopsis無し）
  return compact({
    seriesKey: full.seriesKey ?? null,
    title: full.title ?? null,
    image: full.image ?? null,
    amazonDp: full.amazonDp ?? null,
    amazonUrl: full.amazonUrl ?? null,
    magazine: full.magazine ?? null,
    magazines: full.magazines ?? null,
    audiences: full.audiences ?? null,
    genres: full.genres ?? null,
    tags: full.tags ?? null, // 既に max24
    publisher: full.publisher ?? null,
    releaseDate: full.releaseDate ?? null,
  });
}

async function main() {
  const src = await loadJson(IN_ENRICHED, { items: [], stats: {} });
  const items = Array.isArray(src?.items) ? src.items : [];

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

        // Work詳細で表示
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

  const updatedAt = src?.updatedAt ?? new Date().toISOString();

  // --- legacy works.json（互換） ---
  const legacy = {
    updatedAt,
    total: kept.length,
    droppedTotal: dropped.length,
    droppedSeriesKeys: dropped,
    items: kept,
  };
  await saveJson(OUT_WORKS_LEGACY, legacy);

  // --- new split outputs ---
  await fs.mkdir(OUT_DIR, { recursive: true });

  const shards = [];
  const lookup = {}; // seriesKey -> shardIndex
  const listItems = [];

  let shardIndex = 0;
  for (let i = 0; i < kept.length; i += SHARD_SIZE) {
    const chunk = kept.slice(i, i + SHARD_SIZE);
    const file = shardFileName(shardIndex);

    // shard: full items
    const shardObj = {
      updatedAt,
      shardIndex,
      shardSize: SHARD_SIZE,
      total: chunk.length,
      items: chunk,
    };
    await saveJson(path.join(OUT_DIR, file), shardObj);

    // index metadata
    shards.push({ file, count: chunk.length });

    // lookup + listItems
    for (const it of chunk) {
      const sk = norm(it?.seriesKey);
      if (!sk) continue;
      lookup[sk] = shardIndex;
      listItems.push(toListItem(it));
    }

    shardIndex++;
  }

  const indexObj = {
    version: 1,
    updatedAt,
    total: kept.length,
    droppedTotal: dropped.length,
    droppedSeriesKeys: dropped,
    shardSize: SHARD_SIZE,
    shards,         // [{file,count}]
    lookup,         // { seriesKey: shardIndex }
    listItems,      // List/Home用（author/synopsis無し）
  };

  await saveJson(OUT_INDEX, indexObj);

  console.log(
    `[lane2:format] total_in=${items.length} total_out=${kept.length} dropped=${dropped.length} -> ${OUT_WORKS_LEGACY} + ${OUT_INDEX} + ${OUT_DIR}/works_*.json`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
