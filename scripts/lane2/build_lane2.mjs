/**
 * -----------------------
 * NDL Search (open)
 * -----------------------
 * OpenSearch(Atom)を entry 単位でパースして、title と ISBN を同一 entry から取得する
 * （依存なし・クリーン）
 */
async function ndlSearchOpen({ seriesKey }) {
  const q = encodeURIComponent(`${seriesKey} 1`);
  const url = `https://ndlsearch.ndl.go.jp/api/opensearch?dpid=open&count=20&q=${q}`;

  const r = await fetch(url, { headers: { "user-agent": "tools-labo/book-scout lane2" } });
  if (!r.ok) throw new Error(`NDL HTTP ${r.status}`);
  const xml = await r.text();

  // entry単位で切る（Atom想定）
  const entries = [...xml.matchAll(/<entry\b[^>]*>[\s\S]*?<\/entry>/g)].map(m => m[0]);

  const cands = [];
  for (const e of entries) {
    // entry title
    const tm = e.match(/<title>([\s\S]*?)<\/title>/i);
    let title = tm ? tm[1] : "";
    title = title
      .replaceAll("&amp;", "&")
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">")
      .replaceAll("&quot;", '"')
      .replaceAll("&#39;", "'")
      .trim();

    // entry内の ISBN13（97[89]...）を抽出
    // ※ identifier に "ISBN:978..." の形が多いが、数字だけ拾う方が頑丈
    const im = e.match(/97[89]\d{10}/);
    const isbn13 = im ? im[0] : null;

    // entryのlink（あれば）
    const lm = e.match(/<link[^>]+href="([^"]+)"/i);
    const detailUrl = lm ? lm[1] : null;

    // titleが空ならスキップ
    if (!title) continue;

    const score = scoreCandidate({ title, isbn13 });
    cands.push({
      source: "ndl_open",
      title,
      isbn13,
      score,
      detailUrl,
      reason: isbn13 ? "isbn_from_entry" : "no_isbn_in_entry",
    });
  }

  // 「1巻っぽい」「単話っぽくない」を優先したいので、軽く整形（スコア順でOK）
  // ただし候補が0の場合はrawIsbnsだけ返す
  const rawIsbns = [...new Set([...xml.matchAll(/97[89]\d{10}/g)].map(m => m[0]))].slice(0, 10);

  return {
    query: `${seriesKey} 1`,
    url,
    candidates: cands,
    rawIsbns,
  };
}
