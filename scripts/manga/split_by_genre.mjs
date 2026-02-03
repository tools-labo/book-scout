// scripts/manga/split_by_genre.mjs
import fs from "node:fs/promises";

const src = "data/manga/items_master.json";
const outDir = "data/manga/by_genre";
const items = JSON.parse(await fs.readFile(src, "utf8"));

// workKey単位で代表だけ作る（巻1優先 → _rep）
const m = new Map();
for (const it of items) {
  const k = it.workKey || it.title;
  const cur = m.get(k);
  if (!cur) { m.set(k, it); continue; }
  if (cur.volumeHint !== 1 && it.volumeHint === 1) m.set(k, it);
  else if (!cur._rep && it._rep) m.set(k, it);
}
const reps = [...m.values()];

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
  rakutenGenrePathNames: x.rakutenGenrePathNames || [],
  anilistId: x.anilistId || null,
  anilistGenres: x.anilistGenres || [],
  anilistTags: x.anilistTags || []
});

const norm = (s) => String(s || "").toLowerCase();
const hasAny = (arr, words) => {
  const s = norm([...(arr||[])].join(" / "));
  return words.some(w => s.includes(norm(w)));
};

function bucket(x) {
  const g = x.anilistGenres || [];
  const t = x.anilistTags || [];
  // まずAniListジャンルで大分類（優先順＝1作品1カテゴリの“主表示”用）
  if (hasAny(g, ["Action"])) return "action_battle";
  if (hasAny(g, ["Adventure"])) return "adventure";
  if (hasAny(g, ["Comedy"])) return "comedy_gag";
  if (hasAny(g, ["Romance"])) return "romance_lovecom";
  if (hasAny(g, ["Mystery"])) return "mystery";
  if (hasAny(g, ["Horror"])) return "horror";
  if (hasAny(g, ["Sports"])) return "sports";
  if (hasAny(g, ["Fantasy"])) return "fantasy";
  if (hasAny(g, ["Sci-Fi"])) return "sci_fi";
  if (hasAny(g, ["Drama"])) return "drama";
  if (hasAny(g, ["Slice of Life"])) return "slice_of_life";
  if (hasAny(g, ["Supernatural"])) return "supernatural";
  if (hasAny(g, ["Psychological"])) return "psychological";
  if (hasAny(g, ["Thriller"])) return "thriller";
  if (hasAny(g, ["Ecchi"])) return "ecchi";
  // タグで補助（ジャンルが空でも拾える可能性）
  if (hasAny(t, ["Time Travel", "Historical"])) return "historical";
  if (hasAny(t, ["Detective"])) return "mystery";
  if (hasAny(t, ["Isekai"])) return "isekai";

  // AniListが無い/薄い時は楽天パスで最低限
  const p = x.rakutenGenrePathNames || [];
  if (!p.length) return "unknown";
  const s = p.join(" / ");
  if (s.includes("少年")) return "shonen";
  if (s.includes("少女")) return "shojo";
  if (s.includes("青年")) return "seinen";
  if (s.includes("レディース") || s.includes("女性")) return "josei";
  return "other";
}

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

console.log(`split_by_genre: works=${reps.length} files=${buckets.size} total_written=${total}`);
for (const [b, arr] of buckets) console.log(`  - ${b}: ${arr.length}`);
