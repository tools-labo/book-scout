// worker/src/index.js
// FULL REPLACE
// - JSビルドなので TypeScript を完全撤去
// - GETは query params でも受ける（保険）
// - blobs の並びは固定（schema=v2）
// - ✅ rate は doubles[0] に 1..5 を保存（recent_200 の rating が効く）
// - ✅ rate のとき blob5 は mood ではなく k("rec"/"art") を入れる（export 側仕様に合わせる）

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

  const sid = String(e?.sid ?? "");
  const k = String(e?.k ?? "");
  const v = String(e?.v ?? "");

  const country = String(cf?.country ?? "");
  const path = url.pathname || "";
  const ref = req.headers.get("referer") || "";

    // ✅ export_wae_metrics.mjs の仕様に合わせる
  // - vote:    blob5 = moodId
  // - rate:    blob5 = k ('rec' | 'art')
  // - mood_fb: blob5 = moodId, blob6 = fb ('yes' | 'no')
  const blob5 = (type === "rate") ? k : mood;

  // ✅ mood_fb の fb 値は v 優先（無ければ k）。日本語も許容して正規化。
  const fbRaw = String((v || k || "")).trim().toLowerCase();
  const fbNorm =
    (fbRaw === "yes" || fbRaw === "y" || fbRaw === "1" || fbRaw === "true" || fbRaw === "そう思う") ? "yes"
    : (fbRaw === "no"  || fbRaw === "n" || fbRaw === "0" || fbRaw === "false" || fbRaw === "違う")     ? "no"
    : fbRaw; // 想定外はそのまま（後でexport側で除外/監視できる）

  const blob6 = (type === "mood_fb") ? fbNorm : genre;

  // blob1..blob15 を固定
  return [
    type,       // blob1
    SCHEMA,     // blob2
    page,       // blob3
    seriesKey,  // blob4
    blob5,      // blob5  (vote=moodId / rate=k / mood_fb=moodId)
    blob6,      // blob6  (genre / mood_fb=fb yes|no)
    aud,        // blob7
    mag,        // blob8
    country,    // blob9
    ua,         // blob10
    method,     // blob11
    path,       // blob12
    ref,        // blob13
    sid,        // blob14
    `${k}:${v}` // blob15  (保険のKV)
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

function pickRatingDoubles(body) {
  const type = String(body?.type ?? "");
  if (type !== "rate") return []; // ✅ 非rateはdoubles無し（ノイズ削減）

  const n = Number(body?.v ?? 0);
  if (Number.isFinite(n) && n >= 1 && n <= 5) return [n];

  return []; // ✅ 変な値なら書かない
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
    if (!type) {
      return jsonResponse({ ok: false, wrote: false, rid, error: "missing_type" }, 400);
    }

    const blobs = toBlobs({ ...body, rid }, req);
    const doubles = pickRatingDoubles(body);

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
      mood: blobs[4],      // voteならmoodId / rateならk("rec"/"art")
      genre: blobs[5],
      aud: blobs[6],
      mag: blobs[7],
      sid: blobs[13],
      kv: blobs[14],
      rating: doubles[0],
      ts: Date.now(),
    });
  },
};
