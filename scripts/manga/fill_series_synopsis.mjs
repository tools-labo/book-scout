// scripts/manga/fill_series_synopsis.mjs
import fs from "node:fs/promises";

const SERIES_PATH = "data/manga/series_master.json";
const ITEMS_PATH = "data/manga/items_master.json";
const OVERRIDE_PATH = "data/manga/overrides_synopsis.json";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

function cleanText(s) {
  if (!s) return null;
  let t = String(s);

  // HTML除去（AniListはHTML混じり）
  t = t.replace(/<br\s*\/?>/gi, "\n");
  t = t.replace(/<\/p>/gi, "\n");
  t = t.replace(/<[^>]+>/g, "");

  // 余分な空白整理
  t = t.replace(/\r/g, "");
  t = t.replace(/\n{3,}/g, "\n\n");
  t = t.replace(/[ \t]{2,}/g, " ");
  t = t.trim();

  return t || null;
}

function shortenForList(s, maxChars = 320) {
  if (!s) return null;
  const t = String(s).trim();
  if (t.length <= maxChars) return t;
  return t.slice(0, maxChars).trim() + "…";
}

async function fetchJson(url, opts = {}, tries = 3) {
  for (let i = 0; i < tries; i++) {
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), 15000);
    try {
      const r = await fetch(url, { ...opts, cache: "no-store", signal: ac.signal });
      clearTimeout(to);
      if (r.ok) return await r.json();
      if ((r.status === 429 || r.status >= 500) && i < tries - 1) {
        await sleep(800 + i * 600);
        continue;
      }
      const t = await r.text().catch(() => "");
      throw new Error(`HTTP ${r.status} ${t.slice(0, 120)}`);
    } catch (e) {
      clearTimeout(to);
      if (i < tries - 1) {
        await sleep(800 + i * 600);
        continue;
      }
      throw e;
    }
  }
  return null;
}

// ---- sources ----
async function openbdDescription(isbn13) {
  if (!isbn13) return null;
  const url = `https://api.openbd.jp/v1/get?isbn=${encodeURIComponent(isbn13)}`;
  const arr = await fetchJson(url);
  const x = Array.isArray(arr) ? arr[0] : null;
  if (!x) return null;

  // openBDは形が揺れるので広めに拾う
  const onix = x?.onix;
  const cd = onix?.CollateralDetail;

  // 1) TextContent
  const tcs = cd?.TextContent;
  if (Array.isArray(tcs)) {
    for (const tc of tcs) {
      const t = tc?.Text;
      if (typeof t === "string" && t.trim()) return cleanText(t);
      if (Array.isArray(t) && typeof t[0] === "string" && t[0].trim()) return cleanText(t[0]);
      if (t && typeof t === "object") {
        const v = t?.[0] ?? t?.content ?? t?.text;
        if (typeof v === "string" && v.trim()) return cleanText(v);
      }
    }
  }

  // 2) OtherText（古いONIX）
  const other = cd?.OtherText;
  if (Array.isArray(other)) {
    for (const ot of other) {
      const t = ot?.Text;
      if (typeof t === "string" && t.trim()) return cleanText(t);
      if (Array.isArray(t) && typeof t[0] === "string" && t[0].trim()) return cleanText(t[0]);
    }
  }

  // 3) summary.description
  const s = x?.summary?.description;
  if (typeof s === "string" && s.trim()) return cleanText(s);

  return null;
}

async function rakutenCaption(isbn13, appId) {
  if (!isbn13 || !appId) return null;
  // 楽天 Books BookSearch: isbn で引けることが多い
  const url = `https://app.rakuten.co.jp/services/api/BooksBook/Search/20170404?format=json&applicationId=${encodeURIComponent(
    appId
  )}&isbn=${encodeURIComponent(isbn13)}`;
  const j = await fetchJson(url);
  const item = j?.Items?.[0]?.Item;
  const cap = item?.itemCaption;
  return cleanText(cap);
}

async function wikipediaExtractJa(queryTitle) {
  if (!queryTitle) return null;
  // まず summary で直に引く（タイトル一致する時が一番強い）
  const t = encodeURIComponent(queryTitle.replace(/ /g, "_"));
  const url = `https://ja.wikipedia.org/api/rest_v1/page/summary/${t}`;
  try {
    const j = await fetchJson(url, {}, 1);
    const ex = j?.extract;
    const cleaned = cleanText(ex);
    if (cleaned) return cleaned;
  } catch {
    // ignore
  }

  // 次に検索→最上位→summary
  const sUrl = `https://ja.wikipedia.org/w/api.php?action=query&list=search&format=json&origin=*&srsearch=${encodeURIComponent(
    queryTitle
  )}&srlimit=1`;
  const sj = await fetchJson(sUrl, {}, 1);
  const title = sj?.query?.search?.[0]?.title;
  if (!title) return null;

  const t2 = encodeURIComponent(String(title).replace(/ /g, "_"));
  const url2 = `https://ja.wikipedia.org/api/rest_v1/page/summary/${t2}`;
  const j2 = await fetchJson(url2, {}, 1);
  const ex2 = j2?.extract;
  return cleanText(ex2);
}

async function anilistDescription(anilistId) {
  if (!anilistId) return null;
  const query = `
    query ($id: Int) {
      Media(id: $id, type: MANGA) {
        description(asHtml: true)
      }
    }
  `;
  const body = JSON.stringify({ query, variables: { id: Number(anilistId) } });
  const j = await fetchJson("https://graphql.anilist.co", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body,
  });
  const d = j?.data?.Media?.description;
  return cleanText(d);
}

// ---- helpers ----
function pickVol1IsbnFromItems(items, seriesKey) {
  if (!Array.isArray(items) || !seriesKey) return null;
  const cand = items.find(
    (x) =>
      (x?.workKey || x?.seriesKey) === seriesKey &&
      x?.seriesType === "main" &&
      Number(x?.volumeHint) === 1 &&
      x?.isbn13
  );
  return cand?.isbn13 || null;
}

function normKey(s) {
  return String(s || "").trim();
}

// ---- main ----
const main = async () => {
  const seriesMaster = await loadJson(SERIES_PATH, {});
  const items = await loadJson(ITEMS_PATH, []);
  const overrides = await loadJson(OVERRIDE_PATH, {}); // { "<seriesKey or anilistId>": "text" }

  const rakutenAppId = process.env.RAKUTEN_APP_ID || "";

  let updated = 0;
  let filled = 0;
  let needsOverride = 0;

  for (const [id, s] of Object.entries(seriesMaster)) {
    const anilistId = s?.anilistId ?? Number(id) ?? null;
    const seriesKey = normKey(s?.seriesKey) || normKey(s?.titleRomaji) || normKey(s?.titleNative) || normKey(id);

    if (!s.vol1) s.vol1 = {};

    // vol1 isbn補完（あれば保存）
    if (!s.vol1.isbn13) {
      const v1 = pickVol1IsbnFromItems(items, seriesKey);
      if (v1) {
        s.vol1.isbn13 = v1;
        updated++;
      }
    }

    // すでにdescriptionが入ってるならOK（needsOverrideだけ残ってたら解除）
    if (s.vol1.description && String(s.vol1.description).trim() && s.vol1.description !== "（あらすじ準備中）") {
      if (s.vol1.needsOverride) {
        delete s.vol1.needsOverride;
        updated++;
      }
      continue;
    }

    // ---- 1) override（最優先）----
    const ov =
      overrides?.[seriesKey] ||
      overrides?.[String(anilistId || "")] ||
      overrides?.[id] ||
      null;

    if (ov && String(ov).trim()) {
      s.vol1.description = shortenForList(cleanText(ov));
      delete s.vol1.needsOverride;
      filled++;
      updated++;
      continue;
    }

    // ---- 2) openBD ----
    let desc = null;
    if (s.vol1.isbn13) {
      try {
        desc = await openbdDescription(s.vol1.isbn13);
      } catch {
        desc = null;
      }
      await sleep(120);
    }

    // ---- 3) Rakuten ----
    if (!desc && s.vol1.isbn13 && rakutenAppId) {
      try {
        desc = await rakutenCaption(s.vol1.isbn13, rakutenAppId);
      } catch {
        desc = null;
      }
      await sleep(150);
    }

    // ---- 4) Wikipedia(ja) ----
    if (!desc) {
      const titleJa = s?.titleNative && /[ぁ-んァ-ヶ一-龠]/.test(String(s.titleNative)) ? s.titleNative : null;
      const q = titleJa || s?.titleRomaji || s?.title || null;
      try {
        desc = await wikipediaExtractJa(q);
      } catch {
        desc = null;
      }
      await sleep(150);
    }

    // ---- 5) AniList ----
    if (!desc && anilistId) {
      try {
        desc = await anilistDescription(anilistId);
      } catch {
        desc = null;
      }
      await sleep(150);
    }

    if (desc) {
      s.vol1.description = shortenForList(desc);
      delete s.vol1.needsOverride;
      filled++;
      updated++;
    } else {
      // 最後の砦：必ず埋める
      s.vol1.description = "（あらすじ準備中）";
      s.vol1.needsOverride = true;
      needsOverride++;
      updated++;
    }
  }

  await saveJson(SERIES_PATH, seriesMaster);
  console.log(
    `[fill_series_synopsis] updated=${updated} filled=${filled} needsOverride=${needsOverride}`
  );
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
