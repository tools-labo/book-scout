import fs from "node:fs/promises";

const src = "data/manga/items_master.json";
const outDir = "data/manga/by_genre";

const items = JSON.parse(await fs.readFile(src, "utf8"));

// workKey単位で代表だけ作る（_rep優先、次にvolumeHint=1）
const m = new Map();
for (const it of items) {
  const k = it.workKey || it.title;
  const cur = m.get(k);
  if (!cur) { m.set(k, it); continue; }
  if (!cur._rep && it._rep) m.set(k, it);
  else if (cur.volumeHint !== 1 && it.volumeHint === 1) m.set(k, it);
}
const reps = [...m.values()];

const norm = (s) => String(s || "");

function bucket(x) {
  const p = x.rakutenGenrePathNames || [];
  if (!p.length) return "unknown";
  const s = norm(p.join(" / "));
  if (s.includes("少年")) return "shonen";
  if (s.includes("少女")) return "shojo";
  if (s.includes("青年")) return "seinen";
  if (s.includes("レディース") || s.includes("女性")) return "josei";
  return "other";
}

const pick = (x) => ({
  workKey: x.workKey || x.title,
  title: x.title || "",
  author: x.author || "",
  publisher: x.publisher || "",
  publishedAt: x.publishedAt || "",
  description: x.description || "",
  image: x.image || x.largeImageUrl || x.cover || "",
  asin: x.asin || null,
  amazonUrl: x.amazonUrl || null,
  rakutenGenreIds: x.rakutenGenreIds || [],
  rakutenGenrePathNames: x.rakutenGenrePathNames || []
});

const buckets = new Map();
for (const x of reps) {
  const b = bucket(x);
  const arr = buckets.get(b) || [];
  arr.push(pick(x));
  buckets.set(b, arr);
}

await fs.mkdir(outDir, { recursive: true });

let total = 0;
for (const [b, arr] of buckets) {
  total += arr.length;
  await fs.writeFile(`${outDir}/${b}.json`, JSON.stringify(arr, null, 2));
}

console.log(
  `split_by_genre: works=${reps.length} files=${buckets.size} total_written=${total}`
);
for (const [b, arr] of buckets) console.log(`  - ${b}: ${arr.length}`);
