// worker/src/index.js
// FULL REPLACE
// - rate 対応：payload.rating(1..5) を doubles[0] に入れる（type=rate の時だけ）
// - それ以外は doubles[0]=1
// - blobs は現状維持（v2, blob15=kv）

const SCHEMA = "v2";

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

  return [
    type,       // blob1
    SCHEMA,     // blob2
    page,       // blob3
    seriesKey,  // blob4
    mood,       // blob5（vote: moodId / rate: k）
    genre,      // blob6
    aud,        // blob7
    mag,        // blob8
    country,    // blob9
    ua,         // blob10
    method,     // blob11
    path,       // blob12
    ref,        // blob13
    sid,        // blob14
    `${k}:${v}` // blob15
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

  if (req.method === "GET") {
    const obj = {};
    for (const [k, v] of url.searchParams.entries()) obj[k] = v;
    return Object.keys(obj).length ? obj : null;
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

function clampRating(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return null;
  if (n < 1 || n > 5) return null;
  return n;
}

export default {
  async fetch(req, env) {
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
      return jsonResponse({ ok: false, wrote: false, error: "invalid_payload" }, 400);
    }

    const rid = String(body?.rid ?? crypto.randomUUID());

    const type = String(body?.type ?? "");
    if (!type) return jsonResponse({ ok: false, wrote: false, rid, error: "missing_type" }, 400);

    const blobs = toBlobs({ ...body, rid }, req);

    // ★ rate の時だけ rating を doubles[0] に入れる
    let d0 = 1;
    if (type === "rate") {
      const r = clampRating(body?.rating);
      if (r == null) return jsonResponse({ ok: false, wrote: false, rid, error: "invalid_rating" }, 400);
      d0 = r;
    }

    env.AE.writeDataPoint({
      indexes: [rid],
      blobs,
      doubles: [d0],
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
      rating: type === "rate" ? d0 : null,
      ts: Date.now(),
    });
  },
};
