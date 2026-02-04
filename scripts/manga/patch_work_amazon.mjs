import fs from "node:fs/promises";

const cat = process.env.CAT || "manga";

const worksPath = `data/${cat}/works.json`;
const itemsPath = `data/${cat}/items_master.json`;

const works = JSON.parse(await fs.readFile(worksPath, "utf8"));
const items = JSON.parse(await fs.readFile(itemsPath, "utf8"));

function pickBestItem(cands) {
  if (!cands.length) return null;

  // 1巻優先
  const vol1 = cands.find((x) => x.volumeHint === 1);
  if (vol1) return vol1;

  // volumeHint があるなら小さい順
  const withVol = cands.filter((x) => Number.isFinite(x.volumeHint));
  if (withVol.length) {
    withVol.sort((a, b) => (a.volumeHint ?? 1e9) - (b.volumeHint ?? 1e9));
    return withVol[0];
  }

  // それ以外は先頭
  return cands[0];
}

let updated = 0;

for (const [workKey, w] of Object.entries(works)) {
  // 既に埋まってるなら触らない（事故防止）
  if (w?.asin || w?.amazonUrl) continue;

  const cands = items.filter(
    (it) =>
      it.workKey === workKey &&
      it.seriesType === "main" &&
      (it.asin || it.amazonUrl)
  );

  const best = pickBestItem(cands);
  if (!best) continue;

  w.asin = best.asin || null;
  w.amazonUrl = best.amazonUrl || null;
  updated++;
}

if (updated > 0) {
  await fs.writeFile(worksPath, JSON.stringify(works, null, 2));
}

console.log(`[patch_work_amazon] updated=${updated}`);
