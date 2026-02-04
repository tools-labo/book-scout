import fs from "node:fs/promises";

const items = JSON.parse(await fs.readFile("data/manga/items_master.json", "utf8"));

const vol1 = items.filter((x) => x.seriesType === "main" && x.volumeHint === 1);
const byWork = new Map();
for (const x of vol1) {
  if (!x.workKey) continue;
  if (!byWork.has(x.workKey)) byWork.set(x.workKey, []);
  byWork.get(x.workKey).push(x);
}

const missing = [];
for (const [wk, arr] of byWork.entries()) {
  const ok = arr.some((a) => a.asin && String(a.asin).trim());
  if (!ok) missing.push([wk, arr[0]?.title || "", arr[0]?.isbn13 || ""]);
}

console.log("vol1_total=", vol1.length);
console.log("works_with_vol1_entry=", byWork.size);
console.log("vol1_with_asin=", vol1.filter((x) => x.asin && String(x.asin).trim()).length);
console.log("vol1_missing_asin_count=", missing.length);
console.log("---- missing (workKey | title | isbn13) ----");
missing.slice(0, 80).forEach((x) => console.log(x.join(" | ")));
