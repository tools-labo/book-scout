// scripts/lane2/format_lane2.mjs
import fs from "node:fs/promises";
import path from "node:path";

const IN_ENRICHED = "data/lane2/enriched.json";
const OUT_WORKS = "data/lane2/works.json";

function nowIso() {
  return new Date().toISOString();
}
async function loadJson(p, fallback) {
  try {
    return JSON.parse(await fs.readFile(p, "utf8"));
  } catch {
    return fallback;
  }
}
async function saveJson(p, obj) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(obj, null, 2));
}

function norm(s) {
  return String(s ?? "").trim();
}

// "2018-11-16T00:00:01Z" -> "2018-11-16"
function toDateOnly(iso) {
  const s = norm(iso);
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

function clampArray(arr, max) {
  if (!Array.isArray(arr)) return [];
  return arr
    .map((x) => String(x ?? "").trim())
    .filter(Boolean)
    .slice(0, max);
}

function isJaLikeText(s) {
  const t = norm(s);
  if (!t) return false;
  // ひらがな/カタカナ/漢字が少しでも入ってたら “日本語っぽい” とみなす（安全側）
  return /[ぁ-ゖァ-ヺ一-龯]/.test(t);
}

/**
 * 説明文は「openBD / Wikipedia だけ」採用
 * - enrich 側が openbdSummary/wikiSummary を直接出している場合はそれを優先
 * - enrich 側が description + descriptionSource 形式の場合も考慮
 * - それ以外（anilist等）は必ず捨てる
 */
function pickJaDescription(v) {
  const openbdSummary = norm(v?.openbdSummary || v?.openbd?.summary || v?.openbd?.summaryText || "");
  if (openbdSummary && isJaLikeText(openbdSummary)) {
    return { text: openbdSummary, source: "openbd", openbdSummary, wikiSummary: null };
  }

  const wikiSummary = norm(v?.wikiSummary || v?.wikipediaSummary || "");
  if (wikiSummary && isJaLikeText(wikiSummary)) {
    return { text: wikiSummary, source: "wikipedia", openbdSummary: null, wikiSummary };
  }

  // 互換：descriptionSource が openbd / wikipedia のときだけ採用
  const ds = norm(v?.descriptionSource).toLowerCase();
  const desc = norm(v?.description || "");
  if ((ds === "openbd" || ds === "wikipedia") && desc && isJaLikeText(desc)) {
    return { text: desc, source: ds, openbdSummary: ds === "openbd" ? desc : null, wikiSummary: ds === "wikipedia" ? desc : null };
  }

  // anilist 等は表示しない（= null）
  return { text: null, source: null, openbdSummary: null, wikiSummary: null };
}

async function main() {
  const enriched = await loadJson(IN_ENRICHED, { items: [] });
  const items = Array.isArray(enriched?.items) ? enriched.items : [];

  const works = items.map((x) => {
    const seriesKey = norm(x?.seriesKey);
    const author = norm(x?.author);

    const v = x?.vol1 || {};
    const title = norm(v?.title) || seriesKey || null;

    const descPicked = pickJaDescription(v);

    return {
      seriesKey,
      author: author || null,

      // “表示の核”
      title,
      asin: v?.asin || null,
      isbn13: v?.isbn13 || null,

      // リンク＆画像
      amazonDp: v?.amazonDp || null,
      image: v?.image || null,

      // 出版情報
      publisher: v?.publisher || null,
      contributors: Array.isArray(v?.contributors) ? v.contributors : [],
      releaseDate: toDateOnly(v?.releaseDate),

      // ★説明文：openBD / Wikipedia のみ（英語は落とす）
      description: descPicked.text,
      descriptionSource: descPicked.source,

      // ★フロントが扱いやすいように分離して保持
      openbdSummary: descPicked.openbdSummary,
      wikiSummary: descPicked.wikiSummary,

      // ジャンル・タグ（翻訳はフロントの辞書で。辞書に無いものはフロントで非表示）
      genres: Array.isArray(v?.genres) ? v.genres : [],
      tags: clampArray(v?.tags, 12),

      // 参照元の監査用
      meta: {
        titleLane2: v?.titleLane2 || null,
        anilistId: v?.anilistId || null,
        source: v?.source || null,
        // 監査のため「元のdescriptionSource」を残す（あくまで監査用）
        rawDescriptionSource: v?.descriptionSource || null,
      },
    };
  });

  // 並びは seriesKey で安定化
  works.sort((a, b) => String(a.seriesKey).localeCompare(String(b.seriesKey), "ja"));

  await saveJson(OUT_WORKS, {
    updatedAt: nowIso(),
    total: works.length,
    items: works,
  });

  console.log(`[lane2:format] total=${works.length} -> ${OUT_WORKS}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
