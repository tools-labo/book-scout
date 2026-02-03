import fs from "node:fs/promises";

const src = "data/manga/items_master.json";
const outDir = "data/manga/by_genre";

// 出力ファイルを固定（0件でも作る）
const GENRES = ["shonen", "shojo", "seinen", "josei", "other", "unknown"];

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

  // ここは「含まれてたら分類」なので、まず大枠を拾う
  if (s.includes("少年")) return "shonen";
  if (s.includes("少女")) return "shojo";
  if (s.includes("青年")) return "seinen";
  if (s.includes("レディース") || s.includes("女性")) return "josei";

  // ジャンル階層はあるが、上のどれにも入らない → other
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

// まず空の箱を用意（unknown を含め、必ずファイルが作られる）
const buckets = new Map(GENRES.map((g) => [g, []]));

for (const x of reps) {
  const b = bucket(x);
  buckets.get(b).push(pick(x));
}

await fs.mkdir(outDir, { recursive: true });

let total = 0;
for (const g of GENRES) {
  const arr = buckets.get(g) || [];
  total += arr.length;
  await fs.writeFile(`${outDir}/${g}.json`, JSON.stringify(arr, null, 2));
}

console.log(
  `split_by_genre: works=${reps.length} files=${GENRES.length} total_written=${total}`
);
for (const g of GENRES) {
  const arr = buckets.get(g) || [];
  console.log(`  - ${g}: ${arr.length}`);
}
