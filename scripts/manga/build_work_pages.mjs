// scripts/manga/build_work_pages.mjs（全差し替え）
// 目的:
// - works.json(作品ページ用データ) を work/*.json に分割出力する
// - series_master の vol1.description（= synopsis）を works に反映する
// - ただし「日本語っぽくない」（英語など）description は表示したくないので null に落とす
//
// 参照:
// - data/manga/works.json（workKey -> workObj）
// - data/manga/anilist_by_work.json（workKey -> anilistId）
// - data/manga/series_master.json（items[anilistId].vol1.description）

import fs from "node:fs/promises";
import path from "node:path";

const cat = process.env.CAT || "manga";
const base = `data/${cat}`;

const WORKS_PATH = `${base}/works.json`;
const SERIES_MASTER_PATH = `${base}/series_master.json`;
const ANILIST_BY_WORK_PATH = `${base}/anilist_by_work.json`;
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

function pickAnilistIdFromByWork(byWork, workKey) {
  const v = byWork?.[workKey];
  if (!v) return null;
  const id = String(v?.anilistId ?? v?.anilist?.id ?? v?.id ?? "").trim();
  return /^\d+$/.test(id) ? id : null;
}

function ensureVol1(obj) {
  if (!obj.vol1 || typeof obj.vol1 !== "object") obj.vol1 = {};
  return obj.vol1;
}

const works = await readJson(WORKS_PATH, {});
const seriesMaster = await readJson(SERIES_MASTER_PATH, { items: {} });
const anilistByWork = await readJson(ANILIST_BY_WORK_PATH, {});
const seriesItems =
  seriesMaster?.items && typeof seriesMaster.items === "object" ? seriesMaster.items : {};

await fs.mkdir(outDir, { recursive: true });

let n = 0;
let applied = 0;
let missingId = 0;
let missingMaster = 0;

for (const [workKey, w0] of Object.entries(works)) {
  // shallow clone（structuredCloneでも良いが、差分増えるの嫌なら浅くで十分）
  const w = w0 && typeof w0 === "object" ? { ...w0 } : {};

  // workKey -> anilistId を必ず anilist_by_work から解決
  const anilistId = pickAnilistIdFromByWork(anilistByWork, workKey);

  if (!anilistId) {
    missingId++;
    ensureVol1(w);
  } else {
    const s = seriesItems[anilistId] || null;
    if (!s) {
      missingMaster++;
      ensureVol1(w);
    } else {
      const masterDesc = s?.vol1?.description ?? null;
      const safeDesc = masterDesc && isProbablyJapanese(masterDesc) ? String(masterDesc) : null;

      const v1 = ensureVol1(w);

      if (safeDesc) {
        v1.description = safeDesc;
        applied++;
      } else {
        // 既存が英語っぽい場合も落とす（英語を出さない）
        v1.description = v1.description && isProbablyJapanese(v1.description) ? v1.description : null;
      }

      // （任意）vol1のisbn/image/amazonDpも master に寄せたいならここでやる
      // ただし今回は「英語を出さない」が主目的なので触らない
    }
  }

  const file = path.join(outDir, `${encodeURIComponent(workKey)}.json`);
  await fs.writeFile(file, JSON.stringify(w, null, 2));
  n++;
}

console.log(
  `[build_work_pages] cat=${cat} works=${n} out=${outDir} synopsisApplied=${applied} missingAnilistId=${missingId} missingInMaster=${missingMaster}`
);
