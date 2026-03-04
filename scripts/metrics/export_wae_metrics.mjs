// scripts/metrics/export_wae_metrics.mjs
// FULL REPLACE
import fs from "node:fs/promises";
import path from "node:path";

const OUT_DIR = "data/metrics/wae";
const DEFAULT_DATASET = "book_scout_events";
const QUICK_FILTERS_PATH = "data/lane2/quick_filters.json";

/**
 * Worker(v2) が writeDataPoint してる blobs の並び（実態）
 *  blob1: type
 *  blob2: schema ("v2")
 *  blob3: page ("work" / "list" / "debug" ...)
 *  blob4: seriesKey
 *  blob5: mood
 *  blob6: genre
 *  blob7: aud
 *  blob8: mag
 *  blob9: country
 *  blob10: user-agent
 *  blob11: method
 *  blob12: path
 *
 * NOTE:
 * - vote: blob5 = moodId
 * - rate: blob5 = k ("rec" / "art"), double1 = rating (1..5)
 */
const COL = {
  type: "blob1",
  schema: "blob2",
  page: "blob3",
  seriesKey: "blob4",
  mood: "blob5",
  genre: "blob6",
  aud: "blob7",
  mag: "blob8",
};

// doubles
const DOUBLE = {
  rating: "double1",
};

// ✅ 急上昇（ノイズの無い期間だけ）
const RISING_SINCE_UTC = "toDateTime('2026-02-27 00:00:00', 'UTC')";

// ✅ JST 表示：+9h 固定
const JST_OFFSET_EXPR = "timestamp + INTERVAL '9' HOUR";
const JST_FMT = "%Y-%m-%d %H:%i:%S";

function norm(s) {
  return String(s ?? "").trim();
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function toJstStringFromIso(iso) {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  const t = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  const y = t.getUTCFullYear();
  const m = pad2(t.getUTCMonth() + 1);
  const dd = pad2(t.getUTCDate());
  const hh = pad2(t.getUTCHours());
  const mi = pad2(t.getUTCMinutes());
  const ss = pad2(t.getUTCSeconds());
  return `${y}-${m}-${dd} ${hh}:${mi}:${ss}`;
}

async function saveJson(p, obj) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(obj, null, 2));
}

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

  if (typeof json?.success === "boolean") {
    if (!json.success) {
      throw new Error(`Cloudflare API success=false: ${text.slice(0, 800)}`);
    }
    return json.result ?? {};
  }

  if (json && (Array.isArray(json.meta) || Array.isArray(json.data))) {
    return json;
  }

  throw new Error(`Cloudflare API unknown response: ${text.slice(0, 800)}`);
}

function sumCountExpr() {
  return "SUM(_sample_interval) AS n";
}
function sumCountRawExpr() {
  return "SUM(_sample_interval)";
}

function whereRecent(days = 30) {
  return `timestamp > NOW() - INTERVAL '${Number(days)}' DAY`;
}

function sqlQuote(s) {
  return `'${String(s).replaceAll("'", "''")}'`;
}

async function loadAllowedMoodIds() {
  try {
    const raw = await fs.readFile(QUICK_FILTERS_PATH, "utf-8");
    const json = JSON.parse(raw);
    const ids = Array.isArray(json?.items)
      ? json.items.map((x) => norm(x?.id)).filter(Boolean)
      : [];
    return Array.from(new Set(ids));
  } catch {
    return [];
  }
}

function whereMoodIn(ids) {
  if (!ids?.length) return "1=1";
  const list = ids.map(sqlQuote).join(", ");
  return `${COL.mood} IN (${list})`;
}

/* =======================
 * Common queries
 * ======================= */
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

// ✅ recent_200 の id 互換維持（件数だけ 5000）
// ✅ JSTを別カラムで付与
// ✅ rating は rate の時だけ double1 を出す（それ以外は NaN）
//    - IF の型制約（2nd/3rd 同型）を満たす：Double / Double
//    - NaN は JSON.stringify で null になるため、非 rate 行が 1 に見える問題を潰せる
function qRecent(dataset, limit = 5000) {
  return `
SELECT
  timestamp,
  formatDateTime(${JST_OFFSET_EXPR}, '${JST_FMT}') AS timestampJst,
  ${COL.type} AS type,
  ${COL.schema} AS schema,
  ${COL.page} AS page,
  ${COL.seriesKey} AS seriesKey,
  ${COL.mood} AS mood,
  ${COL.genre} AS genre,
  ${COL.aud} AS aud,
  ${COL.mag} AS mag,
  if(
    ${COL.type} = 'rate',
    ${DOUBLE.rating},
    (0.0 / 0.0)
  ) AS rating
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

function qVotesBySeries(dataset, days = 30, allowedMoodIds = []) {
  return `
SELECT
  ${COL.seriesKey} AS seriesKey,
  ${sumCountExpr()}
FROM ${dataset}
WHERE ${whereRecent(days)}
  AND ${COL.type} = 'vote'
  AND ${COL.seriesKey} != ''
  AND ${COL.mood} != ''
  AND ${whereMoodIn(allowedMoodIds)}
GROUP BY ${COL.seriesKey}
ORDER BY n DESC
`;
}

function qVotesByMood(dataset, days = 30, allowedMoodIds = []) {
  return `
SELECT
  ${COL.mood} AS mood,
  ${sumCountExpr()}
FROM ${dataset}
WHERE ${whereRecent(days)}
  AND ${COL.type} = 'vote'
  AND ${COL.mood} != ''
  AND ${whereMoodIn(allowedMoodIds)}
GROUP BY ${COL.mood}
ORDER BY n DESC
`;
}

function qVotesByMoodSeries(dataset, days = 30, allowedMoodIds = []) {
  return `
SELECT
  ${COL.mood} AS mood,
  ${COL.seriesKey} AS seriesKey,
  ${sumCountExpr()}
FROM ${dataset}
WHERE ${whereRecent(days)}
  AND ${COL.type} = 'vote'
  AND ${COL.mood} != ''
  AND ${COL.seriesKey} != ''
  AND ${whereMoodIn(allowedMoodIds)}
GROUP BY ${COL.mood}, ${COL.seriesKey}
ORDER BY mood ASC, n DESC
`;
}

function qMoodFbByMoodSeries(dataset, days = 30, allowedMoodIds = []) {
  // 前提（worker側）:
  // - type = 'mood_fb'
  // - blob5(COL.mood) = moodId
  // - blob6(COL.genre) = fb ('yes' | 'no')  ※ genre を流用
  return `
SELECT
  ${COL.mood} AS mood,
  ${COL.seriesKey} AS seriesKey,
  SUMIf(_sample_interval, ${COL.genre} = 'yes') AS yes,
  SUMIf(_sample_interval, ${COL.genre} = 'no')  AS no,
  ${sumCountExpr()}
FROM ${dataset}
WHERE ${whereRecent(days)}
  AND ${COL.type} = 'mood_fb'
  AND ${COL.seriesKey} != ''
  AND ${COL.mood} != ''
  AND ${COL.genre} IN ('yes','no')
  AND ${whereMoodIn(allowedMoodIds)}
GROUP BY ${COL.mood}, ${COL.seriesKey}
ORDER BY mood ASC, n DESC
`;
}

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

/* =======================
 * Rate queries
 * ======================= */
function whereRateCommon() {
  return `
  ${COL.type} = 'rate'
  AND ${COL.seriesKey} != ''
  AND ${COL.mood} != ''
  AND ${DOUBLE.rating} >= 1
  AND ${DOUBLE.rating} <= 5
`;
}

function qRateBySeriesKey(dataset, days = 30) {
  return `
SELECT
  ${COL.seriesKey} AS seriesKey,
  ${COL.mood} AS k,
  AVG(${DOUBLE.rating}) AS avg,
  ${sumCountExpr()}
FROM ${dataset}
WHERE ${whereRecent(days)}
  AND ${whereRateCommon()}
GROUP BY ${COL.seriesKey}, ${COL.mood}
ORDER BY k ASC, avg DESC, n DESC
`;
}

function qRateByKey(dataset, days = 30) {
  return `
SELECT
  ${COL.mood} AS k,
  AVG(${DOUBLE.rating}) AS avg,
  ${sumCountExpr()}
FROM ${dataset}
WHERE ${whereRecent(days)}
  AND ${whereRateCommon()}
GROUP BY ${COL.mood}
ORDER BY avg DESC, n DESC
`;
}

function qRateRecTop(dataset, days = 30, limit = 200) {
  const minN = 1;
  return `
SELECT
  ${COL.seriesKey} AS seriesKey,
  AVG(${DOUBLE.rating}) AS avg,
  ${sumCountExpr()}
FROM ${dataset}
WHERE ${whereRecent(days)}
  AND ${whereRateCommon()}
  AND ${COL.mood} = 'rec'
GROUP BY ${COL.seriesKey}
HAVING ${sumCountRawExpr()} >= ${Number(minN)}
ORDER BY avg DESC, n DESC
LIMIT ${Number(limit)}
`;
}

function qRateArtTop(dataset, days = 30, limit = 200) {
  const minN = 1;
  return `
SELECT
  ${COL.seriesKey} AS seriesKey,
  AVG(${DOUBLE.rating}) AS avg,
  ${sumCountExpr()}
FROM ${dataset}
WHERE ${whereRecent(days)}
  AND ${whereRateCommon()}
  AND ${COL.mood} = 'art'
GROUP BY ${COL.seriesKey}
HAVING ${sumCountRawExpr()} >= ${Number(minN)}
ORDER BY avg DESC, n DESC
LIMIT ${Number(limit)}
`;
}

/* =======================
 * Rising (急上昇)
 * ======================= */
function qRisingWorkViewsSince(dataset, limit = 5000) {
  return `
SELECT
  ${COL.seriesKey} AS seriesKey,
  ${sumCountExpr()}
FROM ${dataset}
WHERE
  ${COL.schema} = 'v2'
  AND ${COL.type} = 'work_view'
  AND ${COL.seriesKey} != ''
  AND timestamp >= ${RISING_SINCE_UTC}
GROUP BY ${COL.seriesKey}
ORDER BY n DESC
LIMIT ${Number(limit)}
`;
}

async function main() {
  const accountId = norm(process.env.CLOUDFLARE_ACCOUNT_ID);
  const token =
    norm(process.env.CLOUDFLARE_AE_READ_TOKEN) || norm(process.env.CLOUDFLARE_API_TOKEN);
  const dataset = norm(process.env.CLOUDFLARE_AE_DATASET) || DEFAULT_DATASET;

  if (!accountId) throw new Error("Missing env: CLOUDFLARE_ACCOUNT_ID");
  if (!token) throw new Error("Missing env: CLOUDFLARE_AE_READ_TOKEN (or CLOUDFLARE_API_TOKEN)");

  const days = Number(process.env.CLOUDFLARE_AE_DAYS || 30);
  const allowedMoodIds = await loadAllowedMoodIds();

  const nowIso = new Date().toISOString();
  const nowJst = toJstStringFromIso(nowIso);

  const meta = { version: 1, updatedAt: nowIso, updatedAtJst: nowJst, dataset, days };

  const queries = [
    { id: "type_counts", sql: qTypeCounts(dataset, days) },
    { id: "recent_200", sql: qRecent(dataset, 5000) },
    { id: "work_view_by_series", sql: qWorkViewsBySeries(dataset, days) },
    { id: "vote_by_series", sql: qVotesBySeries(dataset, days, allowedMoodIds) },
    { id: "vote_by_mood", sql: qVotesByMood(dataset, days, allowedMoodIds) },
    { id: "vote_by_mood_series", sql: qVotesByMoodSeries(dataset, days, allowedMoodIds) },
    { id: "mood_fb_by_mood_series", sql: qMoodFbByMoodSeries(dataset, days, allowedMoodIds) },
    { id: "favorite_by_series", sql: qFavoritesBySeries(dataset, days) },
    { id: "list_filter_by_query", sql: qListFilterByQueryKey(dataset, days) },
    { id: "rate_by_series_key", sql: qRateBySeriesKey(dataset, days) },
    { id: "rate_by_key", sql: qRateByKey(dataset, days) },
    { id: "rate_rec_top", sql: qRateRecTop(dataset, days, 200) },
    { id: "rate_art_top", sql: qRateArtTop(dataset, days, 200) },
    { id: "rising_work_view_since_20260227", sql: qRisingWorkViewsSince(dataset, 5000) },
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
