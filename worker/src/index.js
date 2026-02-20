function json(data, status = 200, extraHeaders = {}) {
  const body = JSON.stringify(data);
  return new Response(body, {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
  });
}

function corsHeaders(request) {
  const origin = request.headers.get("Origin") || "*";
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
    "vary": "Origin",
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    // 疎通確認
    if (url.searchParams.get("ping") === "1") {
      return new Response("pong", { status: 200 });
    }

    // 収集（/collect と ?write=1 の両方対応）
    const wantsCollect =
      url.pathname === "/collect" || url.searchParams.get("write") === "1";

    if (wantsCollect) {
      const type = url.searchParams.get("type") || "unknown";

      // AE バインディング確認
      if (!env || !env.AE || typeof env.AE.writeDataPoint !== "function") {
        return json(
          {
            ok: false,
            error: "AE binding is missing",
            hint:
              "wrangler.toml の [[analytics_engine_datasets]] binding が AE になっているか確認",
          },
          500,
          corsHeaders(request)
        );
      }

      try {
        env.AE.writeDataPoint({
          blobs: [
            type,
            request.headers.get("cf-ipcountry") || "",
            request.headers.get("user-agent") || "",
          ],
          doubles: [1],
        });

        return json(
          { ok: true, wrote: true, type, ts: Date.now() },
          200,
          corsHeaders(request)
        );
      } catch (e) {
        return json(
          {
            ok: false,
            error: String(e && (e.message || e)),
            stack: e && e.stack ? String(e.stack) : "",
          },
          500,
          corsHeaders(request)
        );
      }
    }

    return new Response("Not Found", { status: 404 });
  },
};
