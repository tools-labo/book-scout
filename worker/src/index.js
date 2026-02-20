export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ---- CORS（GitHub Pages -> Workers の fetch 対応）
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // ---- 疎通確認
    if (url.searchParams.get("ping") === "1") {
      return new Response("pong", { status: 200, headers: corsHeaders });
    }

    // ---- 収集（/collect と ?write=1 の両方対応）
    const wantsCollect =
      url.pathname === "/collect" || url.searchParams.get("write") === "1";

    if (!wantsCollect) {
      return new Response("Not Found", { status: 404, headers: corsHeaders });
    }

    // ---- AE binding が無いときの明示エラー（1101対策）
    if (!env || !env.AE || typeof env.AE.writeDataPoint !== "function") {
      return Response.json(
        {
          ok: false,
          error: "AE binding is missing",
          hint: "wrangler.toml の analytics_engine_datasets binding=AE を確認",
        },
        { status: 500, headers: corsHeaders }
      );
    }

    // ---- 入力（GET or POST JSON）
    let payload = {};
    if (request.method === "POST") {
      const ct = request.headers.get("content-type") || "";
      if (ct.includes("application/json")) {
        try {
          payload = (await request.json()) || {};
        } catch {
          payload = {};
        }
      }
    }

    const qp = (k) => url.searchParams.get(k) || "";
    const p = (k) => (payload && payload[k] != null ? String(payload[k]) : "");

    const type = p("type") || qp("type") || "unknown"; // 例: list_filter / vote / work_view
    const page = p("page") || qp("page") || ""; // home/list/work 等
    const seriesKey = p("seriesKey") || qp("seriesKey") || ""; // 作品キー
    const mood = p("mood") || qp("mood") || ""; // mood ids を , で連結
    const genre = p("genre") || qp("genre") || ""; // genre を , で連結（任意）
    const aud = p("aud") || qp("aud") || ""; // 少年/青年/少女/女性/その他（任意）
    const mag = p("mag") || qp("mag") || ""; // 連載誌（任意）

    const country = request.headers.get("cf-ipcountry") || "";
    const ua = request.headers.get("user-agent") || "";
    const ref = request.headers.get("referer") || "";
    const path = url.pathname || "";

    // ---- blobs の “順番・意味・個数” を固定する（これが最重要）
    // blob1  : type
    // blob2  : schemaVersion
    // blob3  : page
    // blob4  : seriesKey
    // blob5  : mood
    // blob6  : genre
    // blob7  : aud
    // blob8  : mag
    // blob9  : country
    // blob10 : userAgent (短縮)
    // blob11 : referer (短縮)
    // blob12 : path
    const SCHEMA = "v2";
    const cut = (s, n) => {
      const x = String(s || "");
      return x.length > n ? x.slice(0, n) : x;
    };

    const rid = crypto.randomUUID();

    try {
      env.AE.writeDataPoint({
        blobs: [
          type,
          SCHEMA,
          page,
          seriesKey,
          mood,
          genre,
          aud,
          mag,
          country,
          cut(ua, 180),
          cut(ref, 180),
          path,
        ],
        doubles: [1],
        indexes: [rid], // index1 に必ず rid を入れる（確認が一発でできる）
      });

      return Response.json(
        {
          ok: true,
          wrote: true,
          rid,
          schema: SCHEMA,
          type,
          page,
          seriesKey,
          mood,
          genre,
          aud,
          mag,
          ts: Date.now(),
        },
        { status: 200, headers: corsHeaders }
      );
    } catch (e) {
      return Response.json(
        {
          ok: false,
          error: String(e && (e.message || e)),
          stack: e && e.stack ? String(e.stack) : "",
        },
        { status: 500, headers: corsHeaders }
      );
    }
  },
};
