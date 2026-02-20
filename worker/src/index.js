export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ===== CORS =====
    const origin = request.headers.get("Origin") || "";
    // 必要ならここを自分のドメインに絞る（今は広め）
    const allowOrigin = origin || "*";

    const corsHeaders = {
      "Access-Control-Allow-Origin": allowOrigin,
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // ===== 疎通確認 =====
    if (url.searchParams.get("ping") === "1" || url.pathname === "/ping") {
      return new Response("pong", { status: 200, headers: corsHeaders });
    }

    // ===== 収集エンドポイント =====
    if (url.pathname === "/collect") {
      // AE bindingチェック（無いときに原因がすぐ分かるように）
      if (!env.AE || typeof env.AE.writeDataPoint !== "function") {
        return new Response(
          JSON.stringify({ ok: false, error: "AE binding is missing (env.AE)" }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // ---- payloadを組み立て（POST推奨、GETは暫定サポート）----
      let payload = null;

      if (request.method === "POST") {
        const ct = request.headers.get("Content-Type") || "";
        if (ct.includes("application/json")) {
          try {
            payload = await request.json();
          } catch {
            return new Response(
              JSON.stringify({ ok: false, error: "Invalid JSON" }),
              { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
          }
        } else {
          // JSON以外は一旦エラー（必要なら form-data 等も対応可能）
          return new Response(
            JSON.stringify({ ok: false, error: "Content-Type must be application/json" }),
            { status: 415, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
      } else {
        // GET fallback
        payload = {
          type: url.searchParams.get("type") || "unknown",
          page: url.searchParams.get("page") || "",
          value: url.searchParams.get("value") || "",
        };
      }

      // ---- 必須項目 ----
      const type = (payload?.type || "unknown").toString().slice(0, 64);

      // よく使う情報（個人情報は入れない運用に）
      const page = (payload?.page || "").toString().slice(0, 64);
      const value = (payload?.value || "").toString().slice(0, 128);

      const country = request.headers.get("cf-ipcountry") || "";
      const ua = request.headers.get("user-agent") || "";
      const referer = request.headers.get("referer") || "";

      // ---- AE書き込み（await不要）----
      // blobs: 文字列（後で一覧参照やデバッグに便利）
      // doubles: 数値（カウント/スコア等）
      // indexes: 低カーディナリティ向け（集計キーにおすすめ）
      env.AE.writeDataPoint({
        blobs: [
          type,
          page,
          value,
          country,
          ua.slice(0, 200),
          referer.slice(0, 200),
        ],
        doubles: [1],
        indexes: [
          type,           // 集計しやすい
          page || "none", // /list /work など
        ],
      });

      return new Response(
        JSON.stringify({ ok: true, wrote: true, ts: Date.now() }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response("Not Found", { status: 404, headers: corsHeaders });
  },
};
