export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS（GitHub Pages から叩くので入れておく）
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

    // /collect か ?write=1 のどちらでも収集
    const wantsCollect =
      url.pathname === "/collect" || url.searchParams.get("write") === "1";

    if (!wantsCollect) {
      return new Response("Not Found", { status: 404, headers: cors });
    }

    // AE バインディング確認
    if (!env || !env.AE || typeof env.AE.writeDataPoint !== "function") {
      return new Response(
        JSON.stringify({
          ok: false,
          error: "AE binding is missing",
          hint: "wrangler.toml の analytics_engine_datasets の binding が AE になっているか確認",
        }),
        { status: 500, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // ---- 固定スキーマ（ここが最重要：列ズレ防止） ----
    // blobs は「固定長・固定順」で必ず埋める
    const schema = "v2";
    const type = url.searchParams.get("type") || "unknown";
    const page = url.searchParams.get("page") || "";
    const seriesKey = url.searchParams.get("seriesKey") || "";
    const mood = url.searchParams.get("mood") || "";
    const genre = url.searchParams.get("genre") || "";
    const aud = url.searchParams.get("aud") || "";
    const mag = url.searchParams.get("mag") || "";

    const country = request.headers.get("cf-ipcountry") || "";
    const ua = request.headers.get("user-agent") || "";
    const path = url.pathname || "";

    // rid は index1 に入って AE 側で見やすい（CSVの index1 列）
    const rid =
      (crypto && crypto.randomUUID && crypto.randomUUID()) ||
      `${Date.now()}-${Math.random().toString(16).slice(2)}`;

    // blobs: 12個固定（空は ""）
    const blobs = [
      type,      // blob1
      schema,    // blob2
      page,      // blob3
      seriesKey, // blob4
      mood,      // blob5
      genre,     // blob6
      aud,       // blob7
      mag,       // blob8
      country,   // blob9
      ua,        // blob10
      request.method || "", // blob11
      path,      // blob12
    ];

    try {
      env.AE.writeDataPoint({
        indexes: [rid],
        blobs,
        doubles: [1],
      });

      return new Response(
        JSON.stringify({
          ok: true,
          wrote: true,
          rid,
          schema,
          type,
          page,
          seriesKey,
          mood,
          genre,
          aud,
          mag,
          ts: Date.now(),
        }),
        { status: 200, headers: { ...cors, "Content-Type": "application/json" } }
      );
    } catch (e) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: String(e && (e.message || e)),
        }),
        { status: 500, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }
  },
};
