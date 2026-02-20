export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 疎通確認
    if (url.searchParams.get("ping") === "1") {
      return new Response("pong", { status: 200 });
    }

    // 収集エンドポイント（まずは簡易にGETでもOKにする）
    if (url.pathname === "/collect") {
      // 例：?type=list_filter&k=v
      const type = url.searchParams.get("type") || "unknown";

      // AE write（await不要） 公式にそう書かれてる  [oai_citation:4‡Cloudflare Docs](https://developers.cloudflare.com/analytics/analytics-engine/get-started/)
      env.AE.writeDataPoint({
        blobs: [
          type,
          request.headers.get("cf-ipcountry") || "",
          request.headers.get("user-agent") || ""
        ],
        doubles: [1],
        indexes: [crypto.randomUUID()],
      });

      return new Response("ok", { status: 200 });
    }

    return new Response("Not Found", { status: 404 });
  },
};
