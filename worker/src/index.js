export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 疎通確認
    if (url.searchParams.get("ping") === "1") {
      return new Response("pong", { status: 200 });
    }

    // /collect または ?write=1 を「収集」として扱う
    const wantsCollect =
      url.pathname === "/collect" || url.searchParams.get("write") === "1";

    if (!wantsCollect) {
      return new Response("Not Found", { status: 404 });
    }

    // AE バインディング確認（ここが無いと 1101 になりやすい）
    if (!env || !env.AE || typeof env.AE.writeDataPoint !== "function") {
      return Response.json(
        {
          ok: false,
          error: "AE binding is missing",
          hint:
            "wrangler.toml の [[analytics_engine_datasets]] binding が AE になっているか確認",
        },
        { status: 500 }
      );
    }

    // 受け取るパラメータ（全部GETでOK）
    // /collect?type=vote&page=work&key=xxx&mood=yyy
    const type = url.searchParams.get("type") || "unknown";
    const page = url.searchParams.get("page") || "";
    const seriesKey = url.searchParams.get("key") || "";
    const mood = url.searchParams.get("mood") || "";

    // 付帯情報（任意）
    const country = request.headers.get("cf-ipcountry") || "";
    const uaRaw = request.headers.get("user-agent") || "";
    const ua = uaRaw.length > 180 ? uaRaw.slice(0, 180) : uaRaw;

    try {
      // ★ blobs の「順番」を固定する（これが超重要）
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
          key: seriesKey,
          mood,
          ts: Date.now(),
        },
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
