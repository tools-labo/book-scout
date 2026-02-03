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

// ★デバッグ：楽天ジャンル名の実物を少しだけ出す（最初の5件）
console.log("[split_by_genre] sample genreNames:");
for (const x of reps.slice(0, 5)) {
  console.log(" -", (x.rakutenGenreNames || []).join(" / "));
}

const norm = (s) => String(s || "").toLowerCase();

// いったん雑に「内容っぽい語」が見えたら拾う（当たらなければotherへ）
function bucket(x) {
  const names = (x.rakutenGenreNames || []).join(" ");
  const s = norm(names);

  if (s.includes("恋愛") || s.includes("ラブ") || s.includes("ロマンス")) return "love";
  if (s.includes("ギャグ") || s.includes("コメディ")) return "gag";
  if (s.includes("ミステリー") || s.includes("サスペンス") || s.includes("ホラー") || s.includes("怪談")) return "mystery";
  if (s.includes("歴史") || s.includes("時代")) return "history";
  if (s.includes("アクション") || s.includes("バトル") || s.includes("格闘")) return "action";

  return "other";
}

const buckets = new Map();
for (const x of reps) {
  const b = bucket(x);
  const arr = buckets.get(b) || [];
  arr.push(x);
  buckets.set(b, arr);
}

// 一覧に必要な最小フィールドだけ出力（軽量）
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
  rakutenGenreNames: x.rakutenGenreNames || []
});

await fs.mkdir(outDir, { recursive: true });

let total = 0;
for (const [b, arr] of buckets) {
  const data = arr.map(pick);
  total += data.length;
  await fs.writeFile(`${outDir}/${b}.json`, JSON.stringify(data, null, 2));
}

console.log(`split_by_genre: works=${reps.length} files=${buckets.size} total_written=${total}`);
