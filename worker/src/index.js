// worker/src/index.js
// FULL REPLACE
// - JSビルドなので TypeScript(interface / 型注釈) を完全撤去
// - GETは query params でも受ける（app.js がPOSTでもOK）
// - blobs の並びは固定（schema=v2）
// - ✅ rate: doubles[0] に ★(1..5) を格納（案A）
// - ✅ rate: 集計しやすいよう blob5(mood) に k(rec/art) を入れる（moodが空でもOK）

const SCHEMA = "v2";

// 安全に数値化（NaNなら null）
function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// blobs の並びを“絶対固定”する（空でも必ず埋める）
function toBlobs(e, req) {
  const cf = req.cf || {};
  const ua = req.headers.get("user-agent") || "";
  const method = req.method || "";
  const url = new URL(req.url);

  const type = String(e?.type ?? "");
  const page = String(e?.page ?? "");
  const seriesKey = String(e?.seriesKey ?? "");

  const k = String(e?.k ?? ""); // rate 用キー（rec/art）
  const v = String(e?.v ?? ""); // rate 用値（1..5）

  // blob5 は “mood” 列として集計で使ってるので：
  // - vote: mood をそのまま
  // - rate: mood に k(rec/art) を入れる
  const moodRaw = String(e?.mood ?? "");
  const mood = (type === "rate") ? (k || moodRaw) : moodRaw;

  const genre = String(e?.genre ?? "");
  const aud = String(e?.aud ?? "");
  const mag = String(e?.mag ?? "");

  const country = String(cf?.country ?? "");

  const path = url.pathname || "";
  const ref = req.headers.get("referer") || "";

  const sid = String(e?.sid ?? "");

  // blob1..blob15 を固定
  return [
    type,       // blob1
    SCHEMA,     // blob2
    page,       // blob3
    seriesKey,  // blob4
    mood,       // blob5  (vote: mood / rate: k)
    genre,      // blob6
    aud,        // blob7
    mag,        // blob8
    country,    // blob9
    ua,         // blob10
    method,     // blob11
    path,       // blob12
    ref,        // blob13
    sid,        // blob14
    `${k}:${v}` // blob15（任意KV。デバッグ用）
  ];
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type",
    },
  });
}

async function readBody(req) {
  const url = new URL(req.url);

  // GET: query params を素直に読む（sendBeacon/POST じゃない場合の保険）
  if (req.method === "GET") {
    const obj = {};
    for (const [k, v] of url.searchParams.entries()) obj[k] = v;
    return Object.keys(obj).length ? obj : null;
  }

  // POST: JSON
  if (req.method === "POST") {
    const ct = req.headers.get("content-type") || "";
    if (ct.includes("application/json")) {
      try { return await req.json(); } catch { return null; }
    }
    // text/plain でも受ける
    try {
      const t = await req.text();
      return t ? JSON.parse(t) : null;
    } catch {
      return null;
    }
  }

  return null;
}

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return jsonResponse({ ok: true });

    const url = new URL(req.url);

    // ヘルスチェック
    if (url.pathname === "/" || url.pathname === "/health") {
      return jsonResponse({ ok: true, service: "book-scout-events", schema: SCHEMA });
    }

    if (url.pathname !== "/collect") {
      return jsonResponse({ ok: false, error: "not_found" }, 404);
    }

    const body = await readBody(req);
    if (!body || typeof body !== "object") {
      return jsonResponse({ ok: false, wrote: false, error: "invalid_payload" }, 400);
    }

    // rid はクライアントから来てもOK、無ければ生成
    const rid = String(body?.rid ?? crypto.randomUUID());

    // 必須：type
    const type = String(body?.type ?? "");
    if (!type) {
      return jsonResponse({ ok: false, wrote: false, rid, error: "missing_type" }, 400);
    }

    // rate の場合：k(rec/art) と v(1..5) を要求（欠けてても書くが、doublesは1に落とす）
    const k = String(body?.k ?? "");
    const v = String(body?.v ?? "");
    const rating = toNum(v);

    const blobs = toBlobs({ ...body, rid }, req);

    // doubles:
    // - rate: ★(1..5) を double1 に入れる
    // - それ以外: 1（カウント用）
    const doubles = (() => {
      if (type !== "rate") return [1];

      // ★は1..5のみ受ける（それ以外は集計崩れ防止で 1 に落とす）
      if (rating != null && rating >= 1 && rating <= 5) return [rating];

      return [1];
    })();

    // index1 は rid（追跡用）
    env.AE.writeDataPoint({
      indexes: [rid],
      blobs,
      doubles,
    });

    return jsonResponse({
      ok: true,
      wrote: true,
      rid,
      schema: SCHEMA,
      type: blobs[0],
      page: blobs[2],
      seriesKey: blobs[3],
      mood: blobs[4],      // vote: mood / rate: k
      genre: blobs[5],
      aud: blobs[6],
      mag: blobs[7],
      sid: blobs[13],
      kv: blobs[14],
      double1: doubles[0],
      // デバッグ用：rate の生値も返す（不要なら消してOK）
      k,
      v,
      ts: Date.now(),
    });
  },
};
