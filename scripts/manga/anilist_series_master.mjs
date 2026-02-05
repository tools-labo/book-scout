// scripts/manga/anilist_series_master.mjs
import fs from "node:fs/promises";

const OUT = "data/manga/series_master.json";

// 安全側（AniListは負荷制限ある）
const PER_PAGE = Number(process.env.ANILIST_PER_PAGE || 100);
const MAX_PAGES_PER_RUN = Number(process.env.ANILIST_PAGES || 1);

// AniList GraphQL
const ENDPOINT = "https://graphql.anilist.co";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function todayJst() {
  const d = new Date();
  // JST前提（ActionsはUTCだけど、日付だけ用途なのでOK）
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

function safeStr(x) {
  return (x == null) ? "" : String(x);
}

// seriesKey は「既存を優先」し、新規は romaji優先で雑にslug化
function slugify(s) {
  const t = safeStr(s).normalize("NFKC").toLowerCase().trim();
  if (!t) return null;
  return t
    .replace(/['"’”“]/g, "")
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9ぁ-んァ-ヶ一-龠ー\-]/g, "-")
    .replace(/\-+/g, "-")
    .replace(/^\-|\-$/g, "");
}

async function loadJson(path, fallback) {
  try {
    return JSON.parse(await fs.readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

async function saveJson(path, obj) {
  await fs.mkdir(path.split("/").slice(0, -1).join("/"), { recursive: true });
  await fs.writeFile(path, JSON.stringify(obj, null, 2));
}

async function gql(query, variables) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "accept": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });

  if (res.status === 429) {
    // rate limit
    return { ok: false, status: 429, data: null };
  }

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    return { ok: false, status: res.status, data };
  }
  return { ok: true, status: res.status, data };
}

const QUERY = `
query ($page:Int, $perPage:Int) {
  Page(page:$page, perPage:$perPage) {
    pageInfo { currentPage hasNextPage }
    media(
      type: MANGA,
      sort: ID_DESC,
      countryOfOrigin: JP
    ) {
      id
      title { native romaji english }
      format
      status
      startDate { year month day }
      genres
      tags { name rank isMediaSpoiler }
      isAdult
    }
  }
}
`;

function pickTags(media) {
  const tags = media?.tags || [];
  // rank>=70 だけを軽く採用（雑音抑制）。必要なら調整OK
  return tags
    .filter(t => !t?.isMediaSpoiler && Number(t?.rank || 0) >= 70)
    .map(t => safeStr(t?.name).trim())
    .filter(Boolean)
    .slice(0, 20);
}

function titlePack(m) {
  const t = m?.title || {};
  return {
    titleNative: safeStr(t.native).trim() || null,
    titleRomaji: safeStr(t.romaji).trim() || null,
    titleEnglish: safeStr(t.english).trim() || null,
  };
}

function defaultSeriesKey(m, existingKey) {
  if (existingKey) return existingKey;

  const t = titlePack(m);
  // romaji -> native の順
  const base = t.titleRomaji || t.titleNative || t.titleEnglish || String(m?.id || "");
  return slugify(base) || String(m?.id || "");
}

// main
const master = await loadJson(OUT, {
  meta: {
    cursor: { page: 1, perPage: PER_PAGE },
    updatedAt: todayJst(),
  },
  items: {},
});

master.meta ||= {};
master.meta.cursor ||= { page: 1, perPage: PER_PAGE };
master.meta.cursor.perPage = PER_PAGE;

let page = Number(master.meta.cursor.page || 1);
let added = 0;
let updated = 0;
let rateLimited = 0;

for (let i = 0; i < MAX_PAGES_PER_RUN; i++) {
  const vars = { page, perPage: PER_PAGE };
  const r = await gql(QUERY, vars);

  if (!r.ok) {
    if (r.status === 429) {
      rateLimited++;
      // 次回に回す（無理に進めない）
      break;
    }
    throw new Error(`AniList error status=${r.status} body=${JSON.stringify(r.data)?.slice(0, 500)}`);
  }

  const media = r.data?.data?.Page?.media || [];
  const hasNext = !!r.data?.data?.Page?.pageInfo?.hasNextPage;

  for (const m of media) {
    if (!m?.id) continue;
    if (m.isAdult) continue; // 念のため

    const id = String(m.id);
    const existed = master.items[id];

    const tp = titlePack(m);
    const seriesKey = defaultSeriesKey(m, existed?.seriesKey);

    const next = {
      anilistId: m.id,
      seriesKey,
      titleNative: tp.titleNative,
      titleRomaji: tp.titleRomaji,
      publisher: existed?.publisher ?? null, // ここは後で別ソースで埋めたいので温存
      demo: existed?.demo ?? [],
      genre: existed?.genre ?? [],
      // vol1は別工程で埋める（楽天/独自DB等）
      vol1: existed?.vol1 ?? {
        isbn13: null,
        description: null,
        image: null,
        amazonDp: null,
      },
      // 将来：wikidata->magazines
      wikidataId: existed?.wikidataId ?? null,
      magazines: existed?.magazines ?? [],
      anilist: {
        genres: Array.isArray(m.genres) ? m.genres : [],
        tags: pickTags(m),
        format: m.format ?? null,
        status: m.status ?? null,
        startDate: m.startDate ?? null,
      },
      updatedAt: todayJst(),
    };

    if (!existed) {
      master.items[id] = next;
      added++;
    } else {
      // 既にある場合は「空欄を埋める」寄りで更新（上書きしすぎない）
      master.items[id] = {
        ...existed,
        ...next,
        publisher: existed.publisher ?? next.publisher,
        demo: (existed.demo?.length ? existed.demo : next.demo),
        genre: (existed.genre?.length ? existed.genre : next.genre),
        vol1: {
          ...(next.vol1 || {}),
          ...(existed.vol1 || {}),
        },
        wikidataId: existed.wikidataId ?? next.wikidataId,
        magazines: (existed.magazines?.length ? existed.magazines : next.magazines),
        // anilistは更新してOK
        anilist: next.anilist,
        updatedAt: todayJst(),
      };
      updated++;
    }
  }

  // 次ページへ（次回の開始点）
  page++;
  master.meta.cursor.page = page;
  master.meta.updatedAt = todayJst();

  if (!hasNext) break;

  // ちょい待つ（安全）
  await sleep(400);
}

await saveJson(OUT, master);

console.log(
  `[anilist_series_master] perPage=${PER_PAGE} pages=${MAX_PAGES_PER_RUN} ` +
  `added=${added} updated=${updated} rateLimited=${rateLimited} nextPage=${master.meta.cursor.page}`
);
