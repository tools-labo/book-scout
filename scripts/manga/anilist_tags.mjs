import fs from "node:fs/promises";

const SRC = "data/manga/items_master.json";
const CACHE = "data/manga/anilist_by_work.json";

const API = "https://graphql.anilist.co";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const norm = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

function stripVolumeLike(title) {
  let s = String(title || "").trim();

  // 末尾の「（15）」「(15)」「 114」「≡ 2」「 7 -TWO BLUE VORTEX-」などを雑に剥がす
  s = s.replace(/[（(]\s*\d+\s*[）)]\s*$/u, "");
  s = s.replace(/\s*[≡=]\s*\d+\s*$/u, "");
  s = s.replace(/\s+\d+\s*$/u, "");

  // 「（16）」が中途半端に残るケース対策（末尾に括弧が残ったら剥ぐ）
  s = s.replace(/[（(]\s*$/u, "").trim();

  return s.trim();
}

async function gql(query, variables) {
  const r = await fetch(API, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return await r.json();
}

const QUERY = `
query ($search: String) {
  Page(page: 1, perPage: 10) {
    media(search: $search, type: MANGA) {
      id
      siteUrl
      isAdult
      title { romaji english native }
      genres
      tags { name rank isMediaSpoiler isGeneralSpoiler }
    }
  }
}
`;

function bestPick(list, wantTitle) {
  if (!list || list.length === 0) return null;
  const w = norm(wantTitle);

  // まずは title のいずれかが「ほぼ一致」する候補を優先
  const scored = list.map((m) => {
    const t = m?.title || {};
    const cand = [t.native, t.romaji, t.english].filter(Boolean).map(norm);

    let score = 0;
    for (const c of cand) {
      if (!c) continue;
      if (c === w) score = Math.max(score, 100);
      else if (c.includes(w) || w.includes(c)) score = Math.max(score, 60);
    }

    // 成人向けは後ろに回す（日本マンガ一般サイト想定）
    if (m?.isAdult) score -= 30;

    return { m, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored[0].score > 0 ? scored[0].m : scored[0].m; // 0でも一応先頭
}

function pickTags(m) {
  const genres = Array.isArray(m?.genres) ? m.genres.slice(0, 20) : [];

  // spoiler系は外す。rankが高い順に上位だけ。
  const tags = Array.isArray(m?.tags)
    ? m.tags
        .filter((t) => !t?.isMediaSpoiler && !t?.isGeneralSpoiler)
        .sort((a, b) => (b?.rank || 0) - (a?.rank || 0))
        .slice(0, 20)
        .map((t) => t.name)
    : [];

  return { genres, tags };
}

let items = JSON.parse(await fs.readFile(SRC, "utf8"));

let cache = {};
try {
  cache = JSON.parse(await fs.readFile(CACHE, "utf8"));
} catch {
  cache = {};
}

// workKey単位で代表を作る（_rep優先、次にvolumeHint=1、最後に先頭）
const repsByWork = new Map();
for (const it of items) {
  const k = it.workKey || it.title;
  if (!k) continue;
  const cur = repsByWork.get(k);
  if (!cur) {
    repsByWork.set(k, it);
    continue;
  }
  if (!cur._rep && it._rep) repsByWork.set(k, it);
  else if (cur.volumeHint !== 1 && it.volumeHint === 1) repsByWork.set(k, it);
}
const works = [...repsByWork.entries()].map(([workKey, rep]) => ({ workKey, rep }));

let tagged = 0;
let miss = 0;

for (let i = 0; i < works.length; i++) {
  const { workKey, rep } = works[i];

  if (cache[workKey]?.anilistId) {
    tagged++;
    continue;
  }

  // 検索語：workKey優先 → 巻数剥がし title
  const q1 = String(workKey || "").trim();
  const q2 = stripVolumeLike(rep?.title || "");
  const search = q1 || q2;

  if (!search) {
    miss++;
    cache[workKey] = { ok: true, anilistId: null, reason: "no_search" };
    continue;
  }

  try {
    // 軽いレート制御（連続で叩きすぎない）
    await sleep(250);

    const data = await gql(QUERY, { search });
    const list = data?.data?.Page?.media || [];
    const picked = bestPick(list, q2 || q1);

    if (!picked?.id) {
      miss++;
      cache[workKey] = { ok: true, anilistId: null, reason: "not_found", search };
      continue;
    }

    const { genres, tags } = pickTags(picked);

    cache[workKey] = {
      ok: true,
      search,
      anilistId: picked.id,
      anilistUrl: picked.siteUrl || null,
      anilistGenres: genres,
      anilistTags: tags,
      pickedTitle: picked?.title || null,
    };
    tagged++;
  } catch (e) {
    miss++;
    cache[workKey] = { ok: false, anilistId: null, reason: "api_err", search, err: String(e?.message || e) };
  }
}

// items_master に反映（workKey一致で全アイテムに付ける）
for (const it of items) {
  const k = it.workKey || it.title;
  const c = cache[k];
  if (!c || !c.ok || !c.anilistId) continue;

  it.anilistId = c.anilistId;
  it.anilistUrl = c.anilistUrl;
  it.anilistGenres = c.anilistGenres || [];
  it.anilistTags = c.anilistTags || [];
}

await fs.writeFile(CACHE, JSON.stringify(cache, null, 2));
await fs.writeFile(SRC, JSON.stringify(items, null, 2));

console.log(`anilist_tags: works=${works.length} tagged=${tagged} miss=${miss}`);
