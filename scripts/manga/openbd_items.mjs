import fs from "node:fs/promises";

const cand = JSON.parse(await fs.readFile("data/manga/candidates.json", "utf8"));
const src = (cand.items || []).slice(0, 30);

const j = (u) => fetch(u).then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)));
const pick = (r) => r?.items?.[0]?.volumeInfo || null;
const norm = (s) => (s || "").toLowerCase().replace(/[【】\[\]（）()]/g, " ").replace(/\s+/g, " ").trim();

function volumeHint(title) {
  const t = title || "";
  const m =
    t.match(/[（(]\s*(\d+)\s*[）)]/) ||
    t.match(/第?\s*(\d+)\s*巻/) ||
    t.match(/\b(\d{1,3})\b/);
  return m ? Number(m[1]) : null;
}

function baseTitle(title) {
  return norm(title)
    .replace(/[（(]\s*\d+\s*[）)]/g, "")
    .replace(/第?\s*\d+\s*巻/g, "")
    .replace(/\b\d{1,3}\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function byIsbn(isbn) {
  const u = `https://www.googleapis.com/books/v1/volumes?q=isbn:${encodeURIComponent(isbn)}&maxResults=1`;
  return pick(await j(u));
}

async function byTitle(title, author, max = 1) {
  const q = [title, author].filter(Boolean).join(" ");
  const u = `https://www.googleapis.com/books/v1/volumes?q=intitle:${encodeURIComponent(q)}&maxResults=${max}`;
  return await j(u);
}

// 続巻シリーズだけ：1巻を追加探索（maxResults=5の中から巻1っぽいのを拾う）
async function findVol1(base, author) {
  const bad = /(color\s*walk|画集|公式|ガイド|guide|ファンブック|キャラクター|データブック|magazine)/i;

  const r = await byTitle(`${base} 1`, author, 8);
  const arr = r?.items || [];

  // まず「巻1っぽい」候補を集める
  const cands = [];
  for (const it of arr) {
    const v = it?.volumeInfo;
    const t = v?.title || "";
    if (!t) continue;
    if (bad.test(t)) continue;
    if (!norm(t).includes(norm(base))) continue; // baseTitleを含まないものは除外
    if (volumeHint(t) !== 1) continue;
    cands.push(v);
  }

  return cands[0] || null;
}

const groups = new Map();
let descCount = 0;

for (const x of src) {
  const vHint = volumeHint(x.title);
  const sKey = baseTitle(x.title) + "::" + norm(x.author);

  let v = null;
  if (x.isbn) v = await byIsbn(x.isbn);
  if (!v?.description) v = pick(await byTitle(x.title, x.author, 1));

  const rec = {
    seriesKey: sKey,
    base: baseTitle(x.title),
    title: x.title,
    author: x.author || v?.authors?.[0] || null,
    publisher: x.publisher || v?.publisher || null,
    isbn13: x.isbn || null,
    asin: null,
    publishedAt: x.salesDate || v?.publishedDate || null,
    description: v?.description || null,
    image: x.image || v?.imageLinks?.thumbnail || null,
    volumeHint: vHint,
  };

  const g = groups.get(sKey) || { items: [], maxVol: 0, latest: null };
  g.items.push(rec);
  g.maxVol = Math.max(g.maxVol, vHint || 0);
  g.latest = [g.latest, rec.publishedAt].filter(Boolean).sort().slice(-1)[0] || g.latest;
  groups.set(sKey, g);

  if (rec.description) descCount++;
}

// 代表選定：巻1優先 → 最古発売日 → isbn最小
function pickRep(arr) {
  const v1 = arr.find(x => x.volumeHint === 1);
  if (v1) return v1;
  const dated = arr.filter(x => x.publishedAt).sort((a,b) => (a.publishedAt > b.publishedAt ? 1 : -1));
  if (dated[0]) return dated[0];
  return [...arr].sort((a,b) => String(a.isbn13||"").localeCompare(String(b.isbn13||"")))[0];
}

const out = [];
let addedVol1 = 0;

for (const [seriesKey, g] of groups) {
  let rep = pickRep(g.items);

  // ★ 続巻っぽい(複数件) かつ 1巻が無いときだけ追加探索
  if (g.items.length >= 2 && !g.items.some(x => x.volumeHint === 1)) {
    const v1 = await findVol1(g.items[0].base, g.items[0].author);
    if (v1?.title) {
      rep = {
        ...rep,
        title: v1.title,
        author: rep.author || v1.authors?.[0] || null,
        publisher: rep.publisher || v1.publisher || null,
        publishedAt: rep.publishedAt || v1.publishedDate || null,
        description: rep.description || v1.description || null,
        image: rep.image || v1.imageLinks?.thumbnail || null,
        volumeHint: 1,
        // isbn13 は見つからないこともあるので無理に埋めない（保持してOK）
      };
      addedVol1++;
    }
  }

  out.push({
    ...rep,
    latestVolumeHint: g.maxVol || null,
    latestPublishedAt: g.latest || null,
  });
}

await fs.writeFile("data/manga/items_master.json", JSON.stringify(out, null, 2));
console.log(`series=${out.length} (desc ${out.filter(x=>x.description).length}) (vol1_added ${addedVol1})`);
