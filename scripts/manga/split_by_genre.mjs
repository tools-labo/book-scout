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

// ★デバッグ：解決済みジャンル階層名を5件だけ出す
console.log("[split_by_genre] sample genrePathNames:");
for (const x of reps.slice(0, 5)) {
  console.log(" -", (x.rakutenGenrePathNames || []).join(" / "));
}

// いまは全部otherにしておく（語彙確認後にbucket実装）
const buckets = new Map([["other", reps]]);

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

await fs.mkdir(outDir, { recursive: true });

let total = 0;
for (const [b, arr] of buckets) {
  const data = arr.map(pick);
  total += data.length;
  await fs.writeFile(`${outDir}/${b}.json`, JSON.stringify(data, null, 2));
}

console.log(`split_by_genre: works=${reps.length} files=${buckets.size} total_written=${total}`);
