import fs from "node:fs/promises";

const cand = JSON.parse(await fs.readFile("data/manga/candidates.json", "utf8"));
const src = (cand.items || []).slice(0, 30);

const j = (u) => fetch(u).then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)));
const pick = (r) => r?.items?.[0]?.volumeInfo || null;
const descOf = (v) => v?.description || "";

const norm = (s) => (s || "")
  .toLowerCase()
  .replace(/[【】\[\]（）()]/g, " ")
  .replace(/\s+/g, " ")
  .trim();

function volumeHint(title) {
  // 例: (14) / 14巻 / 第14巻 / １４巻 / 14
  const t = title || "";
  const m =
    t.match(/[（(]\s*(\d+)\s*[）)]/) ||
    t.match(/第?\s*(\d+)\s*巻/) ||
    t.match(/\b(\d{1,3})\b/);
  return m ? Number(m[1]) : null;
}

function baseTitle(title) {
  // 巻数っぽいものを雑に落とす（後で強化）
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
async function byTitle(title, author) {
  const q = [title, author].filter(Boolean).join(" ");
  const u = `https://www.googleapis.com/books/v1/volumes?q=intitle:${encodeURIComponent(q)}&maxResults=1`;
  return pick(await j(u));
}

const groups = new Map();

for (const x of src) {
  const vHint = volumeHint(x.title);
  const sKey = baseTitle(x.title) + "::" + norm(x.author);

  let v = null;
  if (x.isbn) v = await byIsbn(x.isbn);
  if (!descOf(v)) v = await byTitle(x.title, x.author);

  const rec = {
    seriesKey: sKey,
    title: x.title,
    author: x.author || v?.authors?.[0] || null,
    publisher: x.publisher || v?.publisher || null,
    isbn13: x.isbn || null,
    asin: null,
    publishedAt: x.salesDate || v?.publishedDate || null,
    description: descOf(v) || null,
    image: x.image || v?.imageLinks?.thumbnail || null,
    volumeHint: vHint,
  };

  const g = groups.get(sKey) || { items: [], maxVol: 0, latest: null };
  g.items.push(rec);
  g.maxVol = Math.max(g.maxVol, vHint || 0);
  g.latest = [g.latest, rec.publishedAt].filter(Boolean).sort().slice(-1)[0] || g.latest;
  groups.set(sKey, g);
}

// 代表選定：巻1優先 → publishedAt最古 → isbn13最小
function pickRep(arr) {
  const a = [...arr];
  const v1 = a.find(x => x.volumeHint === 1);
  if (v1) return v1;
  const dated = a.filter(x => x.publishedAt).sort((p,q) => (p.publishedAt > q.publishedAt ? 1 : -1));
  if (dated[0]) return dated[0];
  return a.sort((p,q) => String(p.isbn13 || "").localeCompare(String(q.isbn13 || "")))[0];
}

let descCount = 0;
const out = [];

for (const [seriesKey, g] of groups) {
  const rep = pickRep(g.items);
  if (rep.description) descCount++;
  out.push({
    ...rep,
    latestVolumeHint: g.maxVol || null,
    latestPublishedAt: g.latest || null,
  });
}

await fs.writeFile("data/manga/items_master.json", JSON.stringify(out, null, 2));
console.log(`series=${out.length} (desc ${descCount})`);
