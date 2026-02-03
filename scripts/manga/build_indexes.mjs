import fs from "node:fs/promises";
import crypto from "node:crypto";

const worksPath = "data/manga/works.json";
const outDir = "data/manga/index";

const works = JSON.parse(await fs.readFile(worksPath, "utf8"));

const ensureArray = (v) => {
  if (!v) return [];
  if (Array.isArray(v)) return v.filter(Boolean).map(String);
  return [String(v)];
};

const uniq = (arr) => [...new Set(arr.filter(Boolean).map(String))];

const safeKey = (s) =>
  String(s || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]+/g, "")
    .slice(0, 64) || "unknown";

const hashId = (prefix, s) => {
  const h = crypto.createHash("sha1").update(String(s || "")).digest("hex").slice(0, 8);
  return `${prefix}_${h}`;
};

// facet -> valueKey -> [workKey...]
const facetMap = {
  genre: new Map(),
  demo: new Map(),
  publisher: new Map(),
};

function addFacet(facet, valueKey, workKey) {
  const m = facetMap[facet];
  const arr = m.get(valueKey) || [];
  arr.push(workKey);
  m.set(valueKey, arr);
}

let workCount = 0;

for (const [workKey, w] of Object.entries(works)) {
  workCount++;

  const tags = w.tags || {};

  // ---- genre（複数OK。空なら unknown。）
  const genres = uniq(ensureArray(tags.genre));
  if (genres.length === 0) addFacet("genre", "unknown", workKey);
  else for (const g of genres) addFacet("genre", safeKey(g), workKey);

  // ---- demo（複数OK。空なら unknown。）
  const demos = uniq(ensureArray(tags.demo));
  if (demos.length === 0) addFacet("demo", "unknown", workKey);
  else for (const d of demos) addFacet("demo", safeKey(d), workKey);

  // ---- publisher（あなたの現状：tags.publisher が p_xxxxxxxx なのでそのまま使う）
  // もし tags.publisher が無い作品が増えたら、publisher文字列から生成して入れる。
  const pubs = uniq(ensureArray(tags.publisher));
  if (pubs.length === 0) {
    if (w.publisher) addFacet("publisher", hashId("p", w.publisher), workKey);
    else addFacet("publisher", "unknown", workKey);
  } else {
    for (const p of pubs) addFacet("publisher", safeKey(p), workKey);
  }
}

// 出力
await fs.mkdir(outDir, { recursive: true });
for (const facet of Object.keys(facetMap)) {
  await fs.mkdir(`${outDir}/${facet}`, { recursive: true });
}

// facetファイルを書き出し（内容は workKey 配列）
let fileCount = 0;
const facetsSummary = {};

for (const [facet, m] of Object.entries(facetMap)) {
  const keys = [...m.keys()].sort();
  facetsSummary[facet] = keys.length;

  for (const k of keys) {
    const arr = uniq(m.get(k)).sort();
    await fs.writeFile(`${outDir}/${facet}/${k}.json`, JSON.stringify(arr, null, 2));
    fileCount++;
  }
}

// メタ
const meta = {
  generatedAt: new Date().toISOString(),
  works: workCount,
  facets: facetsSummary,
};

await fs.writeFile(`${outDir}/_meta.json`, JSON.stringify(meta, null, 2));

console.log(`[build_indexes] works=${workCount} files=${fileCount + 1}`); // +1 meta
console.log(
  `[build_indexes] facets: genre=${facetsSummary.genre}, demo=${facetsSummary.demo}, publisher=${facetsSummary.publisher}`
);
