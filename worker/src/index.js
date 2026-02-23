// worker/src/index.js
// FULL REPLACE
// - JSビルドなので TypeScript(interface / 型注釈) を完全撤去
// - GETは query params でも受ける（app.js がPOSTでもOK）
// - blobs の並びは固定（schema=v2）

const SCHEMA = "v2";

// blobs の並びを“絶対固定”する（空でも必ず埋める）
function toBlobs(e, req) {
  const cf = req.cf || {};
  const ua = req.headers.get("user-agent") || "";
  const method = req.method || "";
  const url = new URL(req.url);

  const type = String(e?.type ?? "");
  const page = String(e?.page ?? "");
  const seriesKey = String(e?.seriesKey ?? "");
  const mood = String(e?.mood ?? "");
  const genre = String(e?.genre ?? "");
  const aud = String(e?.aud ?? "");
  const mag = String(e?.mag ?? "");

  const country = String(cf?.country ?? "");

  const path = url.pathname || "";
  const ref = req.headers.get("referer") || "";

  const sid = String(e?.sid ?? "");
  const k = String(e?.k ?? "");
  const v = String(e?.v ?? "");

  // blob1..blob15 を固定
  return [
    type,      // blob1
    SCHEMA,    // blob2
    page,      // blob3
    seriesKey, // blob4
    mood,      // blob5
    genre,     // blob6
    aud,       // blob7
    mag,       // blob8
    country,   // blob9
    ua,        // blob10
    method,    // blob11
    path,      // blob12
    ref,       // blob13
    sid,       // blob14
    `${k}:${v}`// blob15（任意KV）
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

    const blobs = toBlobs({ ...body, rid }, req);

    // index1 は rid（追跡用）
    env.AE.writeDataPoint({
      indexes: [rid],
      blobs,
      doubles: [1],
    });

    return jsonResponse({
      ok: true,
      wrote: true,
      rid,
      schema: SCHEMA,
      type: blobs[0],
      page: blobs[2],
      seriesKey: blobs[3],
      mood: blobs[4],
      genre: blobs[5],
      aud: blobs[6],
      mag: blobs[7],
      sid: blobs[13],
      kv: blobs[14],
      ts: Date.now(),
    });
  },
};
