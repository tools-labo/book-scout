export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS（GitHub Pages から叩けるように）
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };
    if (request.method === "OPTIONS") {
      return new Response("", { status: 204, headers: corsHeaders });
    }

    // 疎通確認
    if (url.searchParams.get("ping") === "1") {
      return new Response("pong", { status: 200, headers: corsHeaders });
    }

    // /collect or ?write=1 で受ける（GETでもPOSTでもOK）
    const wantsCollect =
      url.pathname === "/collect" || url.searchParams.get("write") === "1";
    if (!wantsCollect) {
      return new Response("Not Found", { status: 404, headers: corsHeaders });
    }

    // パラメータ取得（POST JSON も対応）
    let payload = {};
    if (request.method === "POST") {
      const ct = request.headers.get("content-type") || "";
      if (ct.includes("application/json")) {
        try {
          payload = await request.json();
        } catch {
          payload = {};
        }
      }
    }

    const type = String(url.searchParams.get("type") ?? payload.type ?? "unknown");
    const page = String(url.searchParams.get("page") ?? payload.page ?? "");
    const seriesKey = String(
      url.searchParams.get("seriesKey") ?? payload.seriesKey ?? ""
    );
    const mood = String(url.searchParams.get("mood") ?? payload.mood ?? "");

    const country = request.headers.get("cf-ipcountry") || "";
    const ua = request.headers.get("user-agent") || "";

    // AE binding チェック
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

    try {
      // ★ スキーマ固定：blobs の並びを絶対に変えない
      // blob1=type, blob2=page, blob3=seriesKey, blob4=mood, blob5=country, blob6=ua
      env.AE.writeDataPoint({
        blobs: [type, page, seriesKey, mood, country, ua],
        doubles: [1],
      });

      return Response.json(
        {
          ok: true,
          wrote: true,
          type,
          page,
          seriesKey,
          mood,
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
