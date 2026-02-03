import fs from "node:fs/promises";

const worksPath = "data/manga/works.json";
const anilistPath = "data/manga/anilist_by_work.json";

const works = JSON.parse(await fs.readFile(worksPath, "utf8"));
const anilist = JSON.parse(await fs.readFile(anilistPath, "utf8"));

const uniq = (arr) => [...new Set(arr.filter(Boolean))];

function mapGenreNamesToKeys(names = []) {
  // AniList genres -> あなたの大ジャンルkey（増やしたいならここに足す）
  const set = new Set();

  for (const g of names) {
    const s = String(g || "").toLowerCase();

    if (s === "action") set.add("action_battle");
    else if (s === "adventure") set.add("adventure");
    else if (s === "comedy") set.add("comedy_gag");
    else if (s === "mystery") set.add("mystery");
    else if (s === "sports") set.add("sports");
    else if (s === "romance") set.add("romance_lovecom");
    else if (s === "drama") set.add("drama");

    // 追加候補（必要なら有効化）
    else if (s === "fantasy") set.add("fantasy");
    else if (s === "sci-fi") set.add("sci_fi");
    else if (s === "thriller") set.add("thriller");
    else if (s === "horror") set.add("horror");
    else if (s === "slice of life") set.add("slice_of_life");
    else if (s === "supernatural") set.add("supernatural");
    else if (s === "psychological") set.add("psychological");
    else if (s === "ecchi") set.add("ecchi");
  }

  // 何も付かなかったら other に逃がす（unknownは「取得できない」用に残す想定）
  return set.size ? [...set] : ["other"];
}

let updated = 0;
let missing = 0;

for (const [workKey, w] of Object.entries(works)) {
  const a = anilist[workKey];
  if (!a?.ok) {
    missing++;
    continue;
  }

  const genreKeys = mapGenreNamesToKeys(a.anilistGenres || []);
  w.tags = w.tags || {};
  w.tags.genre = uniq(genreKeys);

  // 将来UIで表示したいならrawも持つ（不要なら消してOK）
  w.anilist = w.anilist || {};
  w.anilist.url = a.anilistUrl || null;
  w.anilist.genres = a.anilistGenres || [];
  w.anilist.tags = a.anilistTags || [];

  updated++;
}

await fs.writeFile(worksPath, JSON.stringify(works, null, 2));
console.log(`apply_anilist_genres: updated=${updated} missing=${missing}`);
