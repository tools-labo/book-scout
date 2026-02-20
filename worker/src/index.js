// worker/src/index.js
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 疎通確認
    if (url.searchParams.get("ping") === "1") {
      return new Response("pong", { status: 200 });
    }

    // /collect のみ受ける
    if (url.pathname !== "/collect") {
      return new Response("Not Found", { status: 404 });
    }

    // AE binding チェック（ここが無いと 1101/1011 系になりがち）
    if (!env?.AE || typeof env.AE.writeDataPoint !== "function") {
      return Response.json(
        { ok: false, error: "AE binding is missing (binding name must be AE)" },
        { status: 500 }
      );
    }

    // ---- params 取得（GET優先、POSTも許可）----
    const p = new URLSearchParams(url.search);

    // POST(JSON or form) が来たらマージ（GETを上書きしない）
    if (request.method === "POST") {
      const ct = (request.headers.get("content-type") || "").toLowerCase();
      try {
        if (ct.includes("application/json")) {
          const body = await request.json();
          if (body && typeof body === "object") {
            for (const [k, v] of Object.entries(body)) {
              if (!p.has(k) && v != null) p.set(k, String(v));
            }
          }
        } else if (
          ct.includes("application/x-www-form-urlencoded") ||
          ct.includes("multipart/form-data")
        ) {
          const form = await request.formData();
          for (const [k, v] of form.entries()) {
            if (!p.has(k) && v != null) p.set(k, String(v));
          }
        }
      } catch {
        // body parse 失敗は無視（収集を止めない）
      }
    }

    // ---- 正規化（長すぎる値を切る。AEに巨大UAを入れて集計が壊れるのを防止）----
    const cut = (s, n) => {
      const x = String(s ?? "").trim();
      return x.length > n ? x.slice(0, n) : x;
    };

    const type = cut(p.get("type") || "unknown", 40);
    const page = cut(p.get("page") || "", 20); // "list" / "work" を想定
    const seriesKey = cut(p.get("seriesKey") || p.get("key") || "", 200);
    const mood = cut(p.get("mood") || "", 60);

    const country = cut(request.headers.get("cf-ipcountry") || "", 8);
    const ua = cut(request.headers.get("user-agent") || "", 180);

    // ---- AE write（スキーマ固定）----
    try {
      env.AE.writeDataPoint({
        blobs: [
          type,      // blob1
          page,      // blob2
          seriesKey, // blob3
          mood,      // blob4
          country,   // blob5
          ua,        // blob6
        ],
        doubles: [1],
      });

      return Response.json(
        {
          ok: true,
          wrote: true,
          type,
          page,
          seriesKey,
          mood,
          ts: Date.now(),
        },
        { status: 200 }
      );
    } catch (e) {
      return Response.json(
        {
          ok: false,
          error: String(e?.message || e),
        },
        { status: 500 }
      );
    }
  },
};
