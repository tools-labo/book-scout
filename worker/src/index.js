// worker/src/index.js

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS_HEADERS },
  });
}

function text(body, status = 200) {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", ...CORS_HEADERS },
  });
}

// 入力を短く安全に（AEのblobは文字列なので、変な巨大値を落とす）
function clean(s, max = 200) {
  const t = String(s ?? "").trim();
  if (!t) return "";
  return t.length > max ? t.slice(0, max) : t;
}

export default {
  async fetch(request, env) {
    // preflight
    if (request.method === "OPTIONS") {
      return new Response("", { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    // 疎通
    if (url.searchParams.get("ping") === "1") {
      return text("pong", 200);
    }

    // collect
    if (url.pathname === "/collect" || url.searchParams.get("write") === "1") {
      const type = clean(url.searchParams.get("type") || "unknown", 40);

      // vote用（空でも保存できるが、なるべく入れる）
      const page = clean(url.searchParams.get("page") || "", 20);       // "work" / "list"
      const seriesKey = clean(url.searchParams.get("seriesKey") || "", 120);
      const mood = clean(url.searchParams.get("mood") || "", 60);

      const country = clean(request.headers.get("cf-ipcountry") || "", 10);
      const ua = clean(request.headers.get("user-agent") || "", 180);

      if (!env || !env.AE || typeof env.AE.writeDataPoint !== "function") {
        return json(
          {
            ok: false,
            error: "AE binding is missing",
            hint: "wrangler.toml の analytics_engine_datasets binding が AE になってるか確認",
          },
          500
        );
      }

      try {
        // ★ blobs の並びを固定する（これが超重要）
        // blob1: type
        // blob2: page
        // blob3: seriesKey
        // blob4: mood
        // blob5: country
        // blob6: ua
        env.AE.writeDataPoint({
          blobs: [type, page, seriesKey, mood, country, ua],
          doubles: [1],
        });

        return json({ ok: true, wrote: true, type, page, seriesKey, mood, ts: Date.now() }, 200);
      } catch (e) {
        return json(
          {
            ok: false,
            error: String(e && (e.message || e)),
            stack: e && e.stack ? String(e.stack) : "",
          },
          500
        );
      }
    }

    // root
    if (url.pathname === "/") {
      return json(
        {
          ok: true,
          name: "book-scout-events",
          endpoints: {
            ping: "/?ping=1",
            collect: "/collect?type=vote&page=work&seriesKey=...&mood=...",
          },
        },
        200
      );
    }

    return text("Not Found", 404);
  },
};
