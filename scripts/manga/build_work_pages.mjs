import fs from "node:fs/promises";
import path from "node:path";

const cat = process.env.CAT || "manga";
const base = `data/${cat}`;

const src = `${base}/works.json`;
const outDir = `${base}/work`;

const works = JSON.parse(await fs.readFile(src, "utf8"));

await fs.mkdir(outDir, { recursive: true });

let n = 0;
for (const [workKey, w] of Object.entries(works)) {
  const file = path.join(outDir, `${encodeURIComponent(workKey)}.json`);
  await fs.writeFile(file, JSON.stringify(w, null, 2));
  n++;
}

console.log(`[build_work_pages] cat=${cat} works=${n} out=${outDir}`);
