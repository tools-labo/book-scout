// scripts/metrics/export_wae_metrics.mjs
// Cloudflare Analytics Engine (WAE) を SQL で集計して JSON に吐き出す
//
// 必要ENV:
// - CLOUDFLARE_ACCOUNT_ID
// - CLOUDFLARE_AE_READ_TOKEN   (Analytics Engine を読む権限のあるトークン)
//
// 出力先（GitHub Pagesで参照できる場所）
// - public/data/metrics/__verify_latest.json
// - public/data/metrics/type_counts.json
// - public/data/metrics/mood_counts.json
// - public/data/metrics/work_counts.json

import fs from "node:fs/promises";
import path from "node:path";

const DATASET = "book_scout_events";
const OUT_DIR = "public/data/metrics";

function norm(s) {
  return String(s ?? "").trim();
}

async function saveJson(p, obj) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(obj, null, 2));
}

async function sql({ accountId, token, query }) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`;

  const r = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "content-type": "text/plain; charset=utf-8",
    },
    body: String(query || "").trim(),
  });

  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }

  if (!r.ok) {
    throw new Error(`Cloudflare API HTTP ${r.status}: ${text.slice(0, 800)}`);
  }
  if (!json) {
    throw new Error(`Cloudflare API invalid JSON: ${text.slice(0, 800)}`);
  }

  // 返り値形式の差を吸収
  // 1) success/result 形式
  if (Object.prototype.hasOwnProperty.call(json, "success")) {
    if (!json.success) {
      throw new Error(`Cloudflare API success=false: ${text.slice(0, 800)}`);
    }
    return Array.isArray(json.result) ? json.result : [];
  }

  // 2) meta/data 形式（success無し）
  if (Array.isArray(json.data)) return json.data;

  // 3) 念のため
  if (Array.isArray(json.rows)) return json.rows;

  throw new Error(`Cloudflare API unknown response shape: ${text.slice(0, 800)}`);
}

// schema=v2 想定（Workerが書いている blobs の並び）
// blobs[0]=type, blobs[1]=page, blobs[2]=seriesKey, blobs[3]=mood, blobs[4]=genre, blobs[5]=aud, blobs[6]=mag
function qVerifyLatest(limit = 20) {
  return `
SELECT
  blobs[0] AS type,
  blobs[1] AS page,
  blobs[2] AS seriesKey,
  blobs[3] AS mood,
  blobs[4] AS genre,
  blobs[5] AS aud,
  blobs[6] AS mag,
  timestamp AS ts
FROM ${DATASET}
WHERE blobs[0] = '__verify'
ORDER BY ts DESC
LIMIT ${Number(limit) || 20}
`;
}

function qTypeCounts(days = 30) {
  return `
SELECT
  blobs[0] AS type,
  COUNT(*) AS n
FROM ${DATASET}
WHERE timestamp >= NOW() - INTERVAL '${Number(days) || 30}' DAY
GROUP BY type
ORDER BY n DESC
`;
}

function qMoodCounts(days = 30) {
  return `
SELECT
  blobs[3] AS mood,
  COUNT(*) AS n
FROM ${DATASET}
WHERE blobs[0] = 'vote'
  AND timestamp >= NOW() - INTERVAL '${Number(days) || 30}' DAY
  AND blobs[3] != ''
GROUP BY mood
ORDER BY n DESC
`;
}

function qWorkCounts(days = 30) {
  return `
SELECT
  blobs[2] AS seriesKey,
  COUNT(*) AS n
FROM ${DATASET}
WHERE blobs[0] = 'work_view'
  AND timestamp >= NOW() - INTERVAL '${Number(days) || 30}' DAY
  AND blobs[2] != ''
GROUP BY seriesKey
ORDER BY n DESC
LIMIT 200
`;
}

async function main() {
  const accountId = norm(process.env.CLOUDFLARE_ACCOUNT_ID);
  const token = norm(process.env.CLOUDFLARE_AE_READ_TOKEN);

  if (!accountId) throw new Error("Missing env: CLOUDFLARE_ACCOUNT_ID");
  if (!token) throw new Error("Missing env: CLOUDFLARE_AE_READ_TOKEN");

  // 直近verify（列ズレ確認用）
  const verifyLatest = await sql({ accountId, token, query: qVerifyLatest(30) });
  await saveJson(path.join(OUT_DIR, "__verify_latest.json"), {
    version: 1,
    updatedAt: new Date().toISOString(),
    dataset: DATASET,
    rows: verifyLatest,
  });

  // type集計
  const typeCounts = await sql({ accountId, token, query: qTypeCounts(30) });
  await saveJson(path.join(OUT_DIR, "type_counts.json"), {
    version: 1,
    updatedAt: new Date().toISOString(),
    dataset: DATASET,
    rows: typeCounts,
  });

  // mood(vote)集計
  const moodCounts = await sql({ accountId, token, query: qMoodCounts(30) });
  await saveJson(path.join(OUT_DIR, "mood_counts.json"), {
    version: 1,
    updatedAt: new Date().toISOString(),
    dataset: DATASET,
    rows: moodCounts,
  });

  // 作品別(work_view)集計
  const workCounts = await sql({ accountId, token, query: qWorkCounts(30) });
  await saveJson(path.join(OUT_DIR, "work_counts.json"), {
    version: 1,
    updatedAt: new Date().toISOString(),
    dataset: DATASET,
    rows: workCounts,
  });

  console.log(
    `[metrics] ok dataset=${DATASET} verify=${verifyLatest.length} type=${typeCounts.length} mood=${moodCounts.length} work=${workCounts.length} -> ${OUT_DIR}`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
