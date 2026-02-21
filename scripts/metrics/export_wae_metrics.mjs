// scripts/metrics/export_wae_metrics.mjs
import fs from "node:fs/promises";
import path from "node:path";

const OUT_DIR = "public/data/metrics";

// ===== 設定（あなたの運用に合わせて固定） =====
const DATASET = "book_scout_events";

// blob割り当て（Worker側 writeDataPoint の blobs 配列順）
// blob1: type
// blob2: page
// blob3: seriesKey
// blob4: mood
// blob5: genre
// blob6: aud
// blob7: mag
const B = {
  type: "blob1",
  page: "blob2",
  seriesKey: "blob3",
  mood: "blob4",
  genre: "blob5",
  aud: "blob6",
  mag: "blob7",
};

// double1 を「1カウント」として使う
const D1 = "double1";

function nowIso() {
  return new Date().toISOString();
}

async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true });
}

async function saveJson(file, obj) {
  await ensureDir(path.dirname(file));
  await fs.writeFile(file, JSON.stringify(obj, null, 2));
}

function envOrThrow(k) {
  const v = String(process.env[k] || "").trim();
  if (!v) throw new Error(`Missing env: ${k}`);
  return v;
}

async function sql({ accountId, token, query }) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ query }),
  });

  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }

  if (!r.ok) {
    throw new Error(`Cloudflare API HTTP ${r.status}: ${text.slice(0, 300)}`);
  }
  if (!json?.success) {
    throw new Error(`Cloudflare API success=false: ${text.slice(0, 300)}`);
  }
  return json?.result || [];
}

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function pickStr(v) {
  return (v == null ? "" : String(v)).trim();
}

async function main() {
  const accountId = envOrThrow("CLOUDFLARE_ACCOUNT_ID");
  const token = envOrThrow("CLOUDFLARE_API_TOKEN");

  // 期間：直近90日（必要なら後で伸ばす）
  const SINCE_DAYS = 90;

  // ===== 0) デバッグ：__verify の最新5件（列ズレ確認用） =====
  const verifyRows = await sql({
    accountId,
    token,
    query: `
      SELECT
        ${B.type}  AS type,
        ${B.page}  AS page,
        ${B.seriesKey} AS seriesKey,
        ${B.mood}  AS mood,
        ${B.genre} AS genre,
        ${B.aud}   AS aud,
        ${B.mag}   AS mag,
        ${D1}      AS c,
        timestamp
      FROM ${DATASET}
      WHERE ${B.type}='__verify'
      ORDER BY timestamp DESC
      LIMIT 5
    `,
  });

  await saveJson(`${OUT_DIR}/__verify_latest.json`, {
    version: 1,
    updatedAt: nowIso(),
    note: "最新の__verify（列ズレ確認用）。type/page/seriesKey/mood/genre/aud/mag が期待通りか見る。",
    items: verifyRows,
  });

  // ===== 1) work_view：作品別 表示数（直近90日） =====
  const workViewBySeries = await sql({
    accountId,
    token,
    query: `
      SELECT
        ${B.seriesKey} AS seriesKey,
        SUM(${D1}) AS count
      FROM ${DATASET}
      WHERE ${B.type}='work_view'
        AND timestamp > now() - INTERVAL '${SINCE_DAYS}' DAY
      GROUP BY ${B.seriesKey}
      ORDER BY count DESC
      LIMIT 5000
    `,
  });

  await saveJson(`${OUT_DIR}/work_view_by_series.json`, {
    version: 1,
    updatedAt: nowIso(),
    windowDays: SINCE_DAYS,
    totalSeries: workViewBySeries.length,
    items: workViewBySeries.map((r) => ({
      seriesKey: pickStr(r.seriesKey),
      count: toNum(r.count),
    })),
  });

  // ===== 2) list_filter：フィルター利用回数（直近90日） =====
  // 使ったクエリの中身（genre/aud/mag/mood）は URL クエリをそのまま送る想定で集計する
  const listFilterByCombo = await sql({
    accountId,
    token,
    query: `
      SELECT
        ${B.page} AS page,
        ${B.genre} AS genre,
        ${B.aud} AS aud,
        ${B.mag} AS mag,
        ${B.mood} AS mood,
        SUM(${D1}) AS count
      FROM ${DATASET}
      WHERE ${B.type}='list_filter'
        AND timestamp > now() - INTERVAL '${SINCE_DAYS}' DAY
      GROUP BY page, genre, aud, mag, mood
      ORDER BY count DESC
      LIMIT 5000
    `,
  });

  await saveJson(`${OUT_DIR}/list_filter_by_combo.json`, {
    version: 1,
    updatedAt: nowIso(),
    windowDays: SINCE_DAYS,
    items: listFilterByCombo.map((r) => ({
      page: pickStr(r.page),
      genre: pickStr(r.genre),
      aud: pickStr(r.aud),
      mag: pickStr(r.mag),
      mood: pickStr(r.mood),
      count: toNum(r.count),
    })),
  });

  // ===== 3) vote：mood別 投票数（直近90日） =====
  const voteByMood = await sql({
    accountId,
    token,
    query: `
      SELECT
        ${B.mood} AS mood,
        SUM(${D1}) AS count
      FROM ${DATASET}
      WHERE ${B.type}='vote'
        AND timestamp > now() - INTERVAL '${SINCE_DAYS}' DAY
      GROUP BY ${B.mood}
      ORDER BY count DESC
      LIMIT 1000
    `,
  });

  await saveJson(`${OUT_DIR}/vote_by_mood.json`, {
    version: 1,
    updatedAt: nowIso(),
    windowDays: SINCE_DAYS,
    items: voteByMood.map((r) => ({
      mood: pickStr(r.mood),
      count: toNum(r.count),
    })),
  });

  // ===== 4) vote：作品別 投票数（直近90日） =====
  const voteBySeries = await sql({
    accountId,
    token,
    query: `
      SELECT
        ${B.seriesKey} AS seriesKey,
        SUM(${D1}) AS count
      FROM ${DATASET}
      WHERE ${B.type}='vote'
        AND timestamp > now() - INTERVAL '${SINCE_DAYS}' DAY
      GROUP BY ${B.seriesKey}
      ORDER BY count DESC
      LIMIT 5000
    `,
  });

  await saveJson(`${OUT_DIR}/vote_by_series.json`, {
    version: 1,
    updatedAt: nowIso(),
    windowDays: SINCE_DAYS,
    totalSeries: voteBySeries.length,
    items: voteBySeries.map((r) => ({
      seriesKey: pickStr(r.seriesKey),
      count: toNum(r.count),
    })),
  });

  // ===== 5) favorite：作品別 お気に入り数（直近90日） =====
  const favoriteBySeries = await sql({
    accountId,
    token,
    query: `
      SELECT
        ${B.seriesKey} AS seriesKey,
        SUM(${D1}) AS count
      FROM ${DATASET}
      WHERE ${B.type}='favorite'
        AND timestamp > now() - INTERVAL '${SINCE_DAYS}' DAY
      GROUP BY ${B.seriesKey}
      ORDER BY count DESC
      LIMIT 5000
    `,
  });

  await saveJson(`${OUT_DIR}/favorite_by_series.json`, {
    version: 1,
    updatedAt: nowIso(),
    windowDays: SINCE_DAYS,
    totalSeries: favoriteBySeries.length,
    items: favoriteBySeries.map((r) => ({
      seriesKey: pickStr(r.seriesKey),
      count: toNum(r.count),
    })),
  });

  console.log(`[metrics] wrote JSON files into ${OUT_DIR}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
