export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS（GitHub Pages から叩けるように）
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    // 疎通確認
    if (url.searchParams.get("ping") === "1") {
      return new Response("pong", { status: 200, headers: cors });
    }

    // 収集（/collect か ?write=1）
    const wantsCollect =
      url.pathname === "/collect" || url.searchParams.get("write") === "1";

    if (!wantsCollect) {
      return new Response("Not Found", { status: 404, headers: cors });
    }

    // AE バインディング確認（ここが無いと 1101/1011 になりがち）
    if (!env || !env.AE || typeof env.AE.writeDataPoint !== "function") {
      return Response.json(
        {
          ok: false,
          error: "AE binding is missing",
          hint: "wrangler.toml の analytics_engine_datasets binding=AE を確認",
        },
        { status: 500, headers: cors }
      );
    }

    // GET クエリ or POST JSON どっちでも受ける
    let payload = {};
    if (request.method === "POST") {
      try {
        payload = await request.json();
      } catch {
        payload = {};
      }
    }

    const type = String(payload.type ?? url.searchParams.get("type") ?? "unknown");
    const page = String(payload.page ?? url.searchParams.get("page") ?? "");
    const seriesKey = String(payload.seriesKey ?? url.searchParams.get("seriesKey") ?? "");
    const mood = String(payload.mood ?? url.searchParams.get("mood") ?? "");

    const country = request.headers.get("cf-ipcountry") || "";
    const ua = request.headers.get("user-agent") || "";

    try {
      // blobs の順番を固定する
      env.AE.writeDataPoint({
        blobs: [type, page, seriesKey, mood, country, ua],
        doubles: [1],
      });

      return Response.json(
        { ok: true, wrote: true, type, page, seriesKey, mood, ts: Date.now() },
        { status: 200, headers: cors }
      );
    } catch (e) {
      return Response.json(
        {
          ok: false,
          error: String(e && (e.message || e)),
          stack: e && e.stack ? String(e.stack) : "",
        },
        { status: 500, headers: cors }
      );
    }
  },
};
