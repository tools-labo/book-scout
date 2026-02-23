// worker/src/index.js
// FULL REPLACE

export interface Env {
  AE: AnalyticsEngineDataset;
}

const SCHEMA = "v2";

// blobs の並びを“絶対固定”する（空でも必ず埋める）
function toBlobs(e: any, req: Request): string[] {
  const cf: any = (req as any).cf || {};
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

  // ✅追加：匿名セッションID（ログイン不要の鍵）
  const sid = String(e?.sid ?? "");

  // ✅追加：投票種別・値（vote以外は空でOK）
  const voteKind = String(e?.k ?? "");   // e.g. "rec" | "art"
  const voteValue = String(e?.v ?? "");  // e.g. "1".."5"

  const country = String(cf?.country ?? "");

  const path = url.pathname || "";
  const ref = req.headers.get("referer") || "";

  // blob1..blob15 を固定
  return [
    type,       // blob1
    SCHEMA,     // blob2
    page,       // blob3
    seriesKey,  // blob4
    mood,       // blob5
    genre,      // blob6
    aud,        // blob7
    mag,        // blob8
    sid,        // blob9  ✅
    voteKind,   // blob10 ✅
    voteValue,  // blob11 ✅
    country,    // blob12
    ua,         // blob13
    method,     // blob14
    path,       // blob15
    // ref は欲しければ blob16 に（今回は増やさないでおく）
  ];
}

function jsonResponse(obj: any, status = 200) {
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

async function readBody(req: Request) {
  if (req.method === "GET") {
    const u = new URL(req.url);
    const p = u.searchParams.get("payload");
    if (p) {
      try { return JSON.parse(p); } catch { return null; }
    }
    return null;
  }
  if (req.method === "POST") {
    const ct = req.headers.get("content-type") || "";
    if (ct.includes("application/json")) {
      try { return await req.json(); } catch { return null; }
    }
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
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === "OPTIONS") return jsonResponse({ ok: true });

    const url = new URL(req.url);

    if (url.pathname === "/" || url.pathname === "/health") {
      return jsonResponse({ ok: true, service: "book-scout-events", schema: SCHEMA });
    }

    if (url.pathname !== "/collect") {
      return jsonResponse({ ok: false, error: "not_found" }, 404);
    }

    const body = await readBody(req);
    if (!body || typeof body !== "object") {
      return jsonResponse({ ok: false, wrote: false, error: "invalid_json" }, 400);
    }

    const rid = String(body?.rid ?? crypto.randomUUID());

    const type = String(body?.type ?? "");
    if (!type) {
      return jsonResponse({ ok: false, wrote: false, rid, error: "missing_type" }, 400);
    }

    const blobs = toBlobs({ ...body, rid }, req);

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
      sid: blobs[8],
      k: blobs[9],
      v: blobs[10],
      ts: Date.now(),
    });
  },
};
