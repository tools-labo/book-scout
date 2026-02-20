export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 疎通確認
    if (url.searchParams.get("ping") === "1") {
      return new Response("pong", { status: 200 });
    }

    // /collect or ?write=1
    const wantsCollect =
      url.pathname === "/collect" || url.searchParams.get("write") === "1";

    if (!wantsCollect) {
      return new Response("Not Found", { status: 404 });
    }

    const type = url.searchParams.get("type") || "unknown";

    // クライアントが送る想定:
    //   page=list|work
    //   seriesKey=作品キー
    //   mood=読み味ID
    //
    // 既に運用中のズレも吸収するために、代替名も拾う
    const page =
      url.searchParams.get("page") ||
      url.searchParams.get("p") ||
      "";

    const seriesKey =
      url.searchParams.get("seriesKey") ||
      url.searchParams.get("key") ||
      url.searchParams.get("title") ||
      "";

    const mood =
      url.searchParams.get("mood") ||
      url.searchParams.get("m") ||
      "";

    const country = request.headers.get("cf-ipcountry") || "";
    const ua = request.headers.get("user-agent") || "";

    // AE binding チェック（ここが欠けると 1101 になりがち）
    if (!env || !env.AE || typeof env.AE.writeDataPoint !== "function") {
      return Response.json(
        {
          ok: false,
          error: "AE binding is missing",
          hint: "wrangler.toml の analytics_engine_datasets binding=AE を確認",
        },
        { status: 500 }
      );
    }

    try {
      // blobs の順番を固定（迷いをなくす）
      // blob1=type, blob2=page, blob3=seriesKey, blob4=mood, blob5=country, blob6=ua
      env.AE.writeDataPoint({
        blobs: [type, page, seriesKey, mood, country, ua],
        doubles: [1],
      });

      return Response.json(
        { ok: true, wrote: true, type, page, seriesKey, mood, ts: Date.now() },
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
  },
};
