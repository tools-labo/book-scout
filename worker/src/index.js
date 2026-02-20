export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 疎通確認
    if (url.searchParams.get("ping") === "1") {
      return new Response("pong", { status: 200 });
    }

    // 収集（/collect と ?write=1 の両方対応）
    const wantsCollect =
      url.pathname === "/collect" || url.searchParams.get("write") === "1";

    if (wantsCollect) {
      const type = url.searchParams.get("type") || "unknown";

      // ここが undefined だと 1101 になるので先に返す
      if (!env || !env.AE || typeof env.AE.writeDataPoint !== "function") {
        return Response.json(
          {
            ok: false,
            error: "AE binding is missing",
            hint:
              "Cloudflare Worker bindings must include Analytics Engine binding named AE",
          },
          { status: 500 }
        );
      }

      try {
        // まずは最小構成で書く（indexes無しでOK）
        env.AE.writeDataPoint({
          blobs: [
            type,
            request.headers.get("cf-ipcountry") || "",
            request.headers.get("user-agent") || "",
          ],
          doubles: [1],
        });

        return Response.json(
          { ok: true, wrote: true, type, ts: Date.now() },
          { status: 200 }
        );
      } catch (e) {
        return Response.json(
          {
            ok: false,
            error: String(e && (e.message || e)),
            stack: e && e.stack ? String(e.stack) : "",
          },
          { status: 500 }
        );
      }
    }

    return new Response("Not Found", { status: 404 });
  },
};
