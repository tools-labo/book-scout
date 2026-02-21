// scripts/metrics/export_wae_metrics.mjs
import fs from "node:fs/promises";
import path from "node:path";

const OUT_DIR = "data/metrics/wae";
const DEFAULT_DATASET = "book_scout_events";

// v2 schema (Worker writeDataPoint の blobs の順番)
const COL = {
  type: "blob1",
  page: "blob2",
  seriesKey: "blob3",
  mood: "blob4",
  genre: "blob5",
  aud: "blob6",
  mag: "blob7",
};

function norm(s) {
  return String(s ?? "").trim();
}

async function saveJson(p, obj) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(obj, null, 2));
}

/**
 * Cloudflare Analytics Engine SQL API はレスポンス形が2種類ある:
 *  A) { success:true, result:{ meta:[...], data:[...], ... } }
 *  B) { meta:[...], data:[...], ... }  // 直接 result 相当が返るケース
 *
 * → 両方を受ける
 */
async function cfSql({ accountId, token, sql }) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`;

  const r = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "content-type": "text/plain",
    },
    body: sql,
  });

  const text = await r.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Cloudflare API returned non-JSON: ${text.slice(0, 500)}`);
  }

  if (!r.ok) {
    throw new Error(`Cloudflare API HTTP ${r.status}: ${text.slice(0, 800)}`);
  }

  // A) wrapper あり
  if (typeof json?.success === "boolean") {
    if (!json.success) {
      throw new Error(`Cloudflare API success=false: ${text.slice(0, 800)}`);
    }
    return json.result ?? {};
  }

  // B) wrapper なし
  if (json && (Array.isArray(json.meta) || Array.isArray(json.data))) {
    return json;
  }

  throw new Error(`Cloudflare API unknown response: ${text.slice(0, 800)}`);
}

// sampling を考慮したカウント（推奨）
function sumCountExpr() {
  return "SUM(_sample_interval) AS n";
}

function whereRecent(days = 30) {
  return `timestamp > NOW() - INTERVAL '${Number(days)}' DAY`;
}

function qTypeCounts(dataset, days = 30) {
  return `
SELECT
  ${COL.type} AS type,
  ${sumCountExpr()}
FROM ${dataset}
WHERE ${whereRecent(days)}
GROUP BY ${COL.type}
ORDER BY n DESC
`;
}

function qRecent(dataset, limit = 200) {
  return `
SELECT
  timestamp,
  ${COL.type} AS type,
  ${COL.page} AS page,
  ${COL.seriesKey} AS seriesKey,
  ${COL.mood} AS mood,
  ${COL.genre} AS genre,
  ${COL.aud} AS aud,
  ${COL.mag} AS mag
FROM ${dataset}
ORDER BY timestamp DESC
LIMIT ${Number(limit)}
`;
}

function qWorkViewsBySeries(dataset, days = 30) {
  return `
SELECT
  ${COL.seriesKey} AS seriesKey,
  ${sumCountExpr()}
FROM ${dataset}
WHERE ${whereRecent(days)}
  AND ${COL.type} = 'work_view'
  AND ${COL.seriesKey} != ''
GROUP BY ${COL.seriesKey}
ORDER BY n DESC
`;
}

function qVotesBySeries(dataset, days = 30) {
  return `
SELECT
  ${COL.seriesKey} AS seriesKey,
  ${sumCountExpr()}
FROM ${dataset}
WHERE ${whereRecent(days)}
  AND ${COL.type} = 'vote'
  AND ${COL.seriesKey} != ''
GROUP BY ${COL.seriesKey}
ORDER BY n DESC
`;
}

function qVotesByMood(dataset, days = 30) {
  return `
SELECT
  ${COL.mood} AS mood,
  ${sumCountExpr()}
FROM ${dataset}
WHERE ${whereRecent(days)}
  AND ${COL.type} = 'vote'
  AND ${COL.mood} != ''
GROUP BY ${COL.mood}
ORDER BY n DESC
`;
}

/** ★追加：お気に入り（シリーズ別） */
function qFavoritesBySeries(dataset, days = 30) {
  return `
SELECT
  ${COL.seriesKey} AS seriesKey,
  ${sumCountExpr()}
FROM ${dataset}
WHERE ${whereRecent(days)}
  AND ${COL.type} = 'favorite'
  AND ${COL.seriesKey} != ''
GROUP BY ${COL.seriesKey}
ORDER BY n DESC
`;
}

function qListFilterByQueryKey(dataset, days = 30) {
  return `
SELECT
  ${COL.genre} AS genre,
  ${COL.aud} AS aud,
  ${COL.mag} AS mag,
  ${COL.mood} AS mood,
  ${sumCountExpr()}
FROM ${dataset}
WHERE ${whereRecent(days)}
  AND ${COL.type} = 'list_filter'
GROUP BY ${COL.genre}, ${COL.aud}, ${COL.mag}, ${COL.mood}
ORDER BY n DESC
`;
}

async function main() {
  const accountId = norm(process.env.CLOUDFLARE_ACCOUNT_ID);
  const token =
    norm(process.env.CLOUDFLARE_AE_READ_TOKEN) || norm(process.env.CLOUDFLARE_API_TOKEN);
  const dataset = norm(process.env.CLOUDFLARE_AE_DATASET) || DEFAULT_DATASET;

  if (!accountId) throw new Error("Missing env: CLOUDFLARE_ACCOUNT_ID");
  if (!token) {
    throw new Error("Missing env: CLOUDFLARE_AE_READ_TOKEN (or CLOUDFLARE_API_TOKEN)");
  }

  const days = Number(process.env.CLOUDFLARE_AE_DAYS || 30);

  const now = new Date().toISOString();
  const meta = { version: 1, updatedAt: now, dataset, days };

  const queries = [
    { id: "type_counts", sql: qTypeCounts(dataset, days) },
    { id: "recent_200", sql: qRecent(dataset, 200) },
    { id: "work_view_by_series", sql: qWorkViewsBySeries(dataset, days) },
    { id: "vote_by_series", sql: qVotesBySeries(dataset, days) },
    { id: "vote_by_mood", sql: qVotesByMood(dataset, days) },

    // ★追加
    { id: "favorite_by_series", sql: qFavoritesBySeries(dataset, days) },

    { id: "list_filter_by_query", sql: qListFilterByQueryKey(dataset, days) },
  ];

  const out = {};

  for (const q of queries) {
    const res = await cfSql({ accountId, token, sql: q.sql });
    out[q.id] = {
      ...meta,
      id: q.id,
      columns: Array.isArray(res?.meta) ? res.meta : [],
      rows: Array.isArray(res?.data) ? res.data : [],
      raw: {
        rows: res?.rows ?? null,
        rows_before_limit_at_least: res?.rows_before_limit_at_least ?? null,
      },
    };

    await saveJson(`${OUT_DIR}/${q.id}.json`, out[q.id]);
    console.log(`[wae] wrote ${OUT_DIR}/${q.id}.json rows=${out[q.id].rows.length}`);
  }

  await saveJson(`${OUT_DIR}/index.json`, {
    ...meta,
    outputs: queries.map((q) => ({
      id: q.id,
      file: `${q.id}.json`,
      rows: out[q.id]?.rows?.length ?? 0,
    })),
  });

  console.log(`[wae] done -> ${OUT_DIR}/index.json`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
