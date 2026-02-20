// worker/src/index.js

function corsHeaders(origin) {
  // 必要ならここを自サイトに絞ってOK（まずは * で）
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

function json(data, { status = 200, origin = "*" } = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders(origin),
    },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "*";

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // 疎通確認
    if (url.searchParams.get("ping") === "1") {
      return new Response("pong", { status: 200, headers: corsHeaders(origin) });
    }

    // 収集（/collect と ?write=1 の両方対応）
    const wantsCollect =
      url.pathname === "/collect" || url.searchParams.get("write") === "1";

    if (!wantsCollect) {
      return new Response("Not Found", { status: 404, headers: corsHeaders(origin) });
    }

    const type = url.searchParams.get("type") || "unknown";

    // “中身”用
    const key = url.searchParams.get("key") || "";     // seriesKey など
    const mood = url.searchParams.get("mood") || "";   // 投票ID（泣ける等）
    const page = url.searchParams.get("page") || "";   // list/work など（任意）

    const country = request.headers.get("cf-ipcountry") || "";
    const ua = request.headers.get("user-agent") || "";

    // binding未設定だと1101になりがちなので先に返す
    if (!env || !env.AE || typeof env.AE.writeDataPoint !== "function") {
      return json(
        {
          ok: false,
          error: "AE binding is missing",
          hint: "wrangler.toml の analytics_engine_datasets binding=AE を確認",
        },
        { status: 500, origin }
      );
    }

    try {
      // blobs は “位置”で見るのが一番安定する
      // blob1=type / blob2=key / blob3=mood / blob4=page / blob5=country / blob6=ua
      env.AE.writeDataPoint({
        blobs: [type, key, mood, page, country, ua],
        doubles: [1],
      });

      return json(
        {
          ok: true,
          wrote: true,
          type,
          key,
          mood,
          page,
          ts: Date.now(),
        },
        { status: 200, origin }
      );
    } catch (e) {
      return json(
        {
          ok: false,
          error: String(e && (e.message || e)),
          stack: e && e.stack ? String(e.stack) : "",
        },
        { status: 500, origin }
      );
    }
  },
};
