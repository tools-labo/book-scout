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
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // 疎通確認
    if (url.searchParams.get("ping") === "1") {
      return new Response("pong", { status: 200, headers: corsHeaders });
    }

    // 収集エンドポイント
    // - /collect?type=vote&page=work&seriesKey=xxx&mood=hot
    // - /collect?type=list_filter&page=list&mood=satisfying,hot
    if (url.pathname === "/collect") {
      const type = url.searchParams.get("type") || "unknown";
      const page = url.searchParams.get("page") || "";
      const seriesKey = url.searchParams.get("seriesKey") || "";
      const mood = url.searchParams.get("mood") || "";

      const country = request.headers.get("cf-ipcountry") || "";

      if (!env?.AE?.writeDataPoint) {
        return Response.json(
          { ok: false, error: "AE binding is missing (binding name must be AE)" },
          { status: 500, headers: corsHeaders }
        );
      }

      // blobs の並びを固定（重要）
      // blob1: type
      // blob2: page
      // blob3: seriesKey
      // blob4: mood
      // blob5: country
      env.AE.writeDataPoint({
        blobs: [type, page, seriesKey, mood, country],
        doubles: [1],
      });

      return Response.json(
        { ok: true, wrote: true, type, page, seriesKey, mood, ts: Date.now() },
        { status: 200, headers: corsHeaders }
      );
    }

    return new Response("Not Found", { status: 404, headers: corsHeaders });
  },
};
