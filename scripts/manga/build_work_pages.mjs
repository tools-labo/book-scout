// scripts/manga/build_work_pages.mjs（全差し替え）
// 目的: workページ用JSONを出力する際に、series_master の synopsis を反映する
// 方針: 表示は vol1.description を使う。ただし「日本語っぽくない」文は出さない（null化）

import fs from "node:fs/promises";
import path from "node:path";

const cat = process.env.CAT || "manga";
const base = `data/${cat}`;

const WORKS_PATH = `${base}/works.json`;
const SERIES_MASTER_PATH = `${base}/series_master.json`;
const outDir = `${base}/work`;

function isProbablyJapanese(text) {
  const s = String(text ?? "");
  // ひらがな/カタカナ/漢字 が1文字でも含まれれば「日本語」とみなす（安全側）
  return /[ぁ-んァ-ン一-龯]/.test(s);
}

async function readJson(p, fallback) {
  try {
    return JSON.parse(await fs.readFile(p, "utf8"));
  } catch {
    return fallback;
  }
}

const works = await readJson(WORKS_PATH, {});
const seriesMaster = await readJson(SERIES_MASTER_PATH, { items: {} });
const seriesItems = seriesMaster?.items && typeof seriesMaster.items === "object" ? seriesMaster.items : {};

await fs.mkdir(outDir, { recursive: true });

let n = 0;
let applied = 0;

for (const [workKey, w0] of Object.entries(works)) {
  const w = w0 && typeof w0 === "object" ? structuredClone(w0) : {};

  // works.json 側に anilistId がある想定（無ければ何もしない）
  const anilistId = String(w?.anilistId ?? "").trim();
  const s = anilistId && seriesItems[anilistId] ? seriesItems[anilistId] : null;

  // series_master の vol1.description を優先で反映（ただし日本語っぽくないなら捨てる）
  const masterDesc = s?.vol1?.description ?? null;
  const safeDesc = masterDesc && isProbablyJapanese(masterDesc) ? String(masterDesc) : null;

  if (!w.vol1 || typeof w.vol1 !== "object") w.vol1 = {};
  if (safeDesc) {
    w.vol1.description = safeDesc;
    applied++;
  } else {
    // 「英語/空/不明」は表示したくないので null に寄せる（既存があっても日本語判定に通らないなら落とす）
    w.vol1.description = w.vol1.description && isProbablyJapanese(w.vol1.description) ? w.vol1.description : null;
  }

  const file = path.join(outDir, `${encodeURIComponent(workKey)}.json`);
  await fs.writeFile(file, JSON.stringify(w, null, 2));
  n++;
}

console.log(`[build_work_pages] cat=${cat} works=${n} out=${outDir} synopsisApplied=${applied}`);
