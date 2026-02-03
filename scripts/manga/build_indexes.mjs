import fs from "node:fs/promises";

const SRC = "data/manga/items_master.json";
const OUT_WORKS = "data/manga/works.json";
const OUT_DIR = "data/manga/index";

const safeJson = async (p) => {
  try { return JSON.parse(await fs.readFile(p, "utf8")); } catch { return null; }
};

// 安定した短いID（出版社など日本語を安全なファイル名にする）
const fnv1a = (s) => {
  let h = 0x811c9dc5;
  for (const ch of String(s)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
};
const uniq = (arr) => [...new Set((arr || []).filter(Boolean))];

// workKey単位で代表を作る（_rep優先→volumeHint=1→先着）
function pickRep(prev, cur) {
  if (!prev) return cur;
  if (!prev._rep && cur._rep) return cur;
  if (prev.volumeHint !== 1 && cur.volumeHint === 1) return cur;
  return prev;
}

const items = await safeJson(SRC) || [];
const repMap = new Map();
for (const it of items) {
  const k = it.workKey || it.title;
  repMap.set(k, pickRep(repMap.get(k), it));
}
const reps = [...repMap.values()];

// AniListキャッシュ（すでに作ってる前提：data/manga/anilist_by_work.json）
const anilist = (await safeJson("data/manga/anilist_by_work.json")) || {};
const alGet = (wk) => anilist[wk] || null;

// 作品→大ジャンル（まずは取れる範囲で）
const GENRE_KEYS = {
  action_battle: ["Action"],
  adventure: ["Adventure", "Fantasy"],
  comedy_gag: ["Comedy"],
  drama: ["Drama", "Slice of Life"],
  mystery: ["Mystery", "Thriller", "Psychological"],
  romance_lovecom: ["Romance"],
  sports: ["Sports"],
};
function pickGenres(wk) {
  const a = alGet(wk);
  const genres = uniq(a?.genres);
  const out = [];
  for (const [k, keys] of Object.entries(GENRE_KEYS)) {
    if (keys.some((x) => genres.includes(x))) out.push(k);
  }
  return out.length ? out : ["other"];
}

// 楽天のジャンルパス（少年/少女/青年/女性など）
function pickDemo(rep) {
  const p = (rep.rakutenGenrePathNames || []).join(" / ");
  if (!p) return ["unknown"];
  if (p.includes("少年")) return ["shonen"];
  if (p.includes("少女")) return ["shojo"];
  if (p.includes("青年")) return ["seinen"];
  if (p.includes("レディース") || p.includes("女性")) return ["josei"];
  return ["other"];
}

// 出版社は日本語が多いのでID化して meta に表示名を持つ
function pickPublisher(rep) {
  const name = (rep.publisher || "").trim();
  if (!name) return { id: "unknown", label: "不明" };
  const id = `p_${fnv1a(name)}`;
  return { id, label: name };
}

// works.json（workKey→作品）
const works = {};
// index（facet/value→workKey配列）
const index = {
  genre: new Map(),
  demo: new Map(),
  publisher: new Map(),
};

const pushIndex = (facet, key, wk) => {
  const m = index[facet];
  const a = m.get(key) || [];
  a.push(wk);
  m.set(key, a);
};

const meta = {
  genre: {
    action_battle: "アクション",
    adventure: "冒険",
    comedy_gag: "ギャグ",
    drama: "ドラマ",
    mystery: "ミステリー",
    romance_lovecom: "恋愛/ラブコメ",
    sports: "スポーツ",
    other: "その他",
  },
  demo: {
    shonen: "少年",
    shojo: "少女",
    seinen: "青年",
    josei: "女性",
    other: "その他",
    unknown: "不明",
  },
  publisher: { unknown: "不明" },
};

for (const rep of reps) {
  const wk = rep.workKey || rep.title;
  const genres = pickGenres(wk);
  const demos = pickDemo(rep);
  const pub = pickPublisher(rep);

  // works 本体
  works[wk] = {
    workKey: wk,
    title: rep.title || "",
    author: rep.author || "",
    publisher: rep.publisher || "",
    publishedAt: rep.publishedAt || "",
    description: rep.description || "",
    image: rep.image || rep.largeImageUrl || rep.cover || "",
    asin: rep.asin || null,
    amazonUrl: rep.amazonUrl || null,
    tags: {
      genre: genres,
      demo: demos,
      publisher: [pub.id],
    },
  };

  // index へ（複数所属OK）
  for (const g of genres) pushIndex("genre", g, wk);
  for (const d of demos) pushIndex("demo", d, wk);
  pushIndex("publisher", pub.id, wk);

  meta.publisher[pub.id] = pub.label;
}

// 出力
await fs.mkdir(`${OUT_DIR}/genre`, { recursive: true });
await fs.mkdir(`${OUT_DIR}/demo`, { recursive: true });
await fs.mkdir(`${OUT_DIR}/publisher`, { recursive: true });

await fs.writeFile(OUT_WORKS, JSON.stringify(works, null, 2));

let files = 0;
for (const facet of ["genre", "demo", "publisher"]) {
  for (const [k, arr] of index[facet]) {
    const list = uniq(arr).sort();
    await fs.writeFile(`${OUT_DIR}/${facet}/${k}.json`, JSON.stringify(list, null, 2));
    files++;
  }
  // 「unknown を必ず出す」（0件でも）
  if (!index[facet].has("unknown")) {
    await fs.writeFile(`${OUT_DIR}/${facet}/unknown.json`, JSON.stringify([], null, 2));
    files++;
  }
}

await fs.writeFile(`${OUT_DIR}/_meta.json`, JSON.stringify(meta, null, 2));

console.log(`[build_indexes] works=${reps.length} files=${files}`);
console.log(`[build_indexes] facets: genre=${index.genre.size}, demo=${index.demo.size}, publisher=${index.publisher.size}`);
