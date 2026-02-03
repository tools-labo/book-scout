// scripts/manga/wikidata_ids.mjs
import fs from "node:fs/promises";

const SRC = "data/manga/items_master.json";
const OUT = "data/manga/wikidata_by_isbn.json";
const ENDPOINT = "https://query.wikidata.org/sparql";

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function fetchJson(url, opt, tries = 5) {
  for (let i = 0; i < tries; i++) {
    const r = await fetch(url, opt);
    if (r.ok) return r.json();
    const t = await r.text();
    // 429/5xxは待ってリトライ
    if (r.status === 429 || (r.status >= 500 && r.status <= 599)) {
      await sleep(500 * (i + 1));
      continue;
    }
    throw new Error(`HTTP ${r.status}\n${t.slice(0, 200)}`);
  }
  throw new Error("retry_exceeded");
}

const items = JSON.parse(await fs.readFile(SRC, "utf8"));

// workKeyごとに「巻1優先」で代表を1つ
const m = new Map();
for (const it of items) {
  const k = it.workKey || it.title;
  const cur = m.get(k);
  if (!cur) { m.set(k, it); continue; }
  if (cur.volumeHint !== 1 && it.volumeHint === 1) m.set(k, it);
  else if (!cur._rep && it._rep) m.set(k, it);
}
const reps = [...m.values()].filter(x => x.isbn13);

let cache = {};
try { cache = JSON.parse(await fs.readFile(OUT, "utf8")); } catch {}

let fetched = 0, hit = 0, miss = 0;
for (const x of reps) {
  const isbn = String(x.isbn13);
  if (cache[isbn]) { hit++; continue; }

  const q = `
SELECT ?item ?anilist ?mal ?kitsu WHERE {
  { ?item wdt:P212 "${isbn}" } UNION { ?item wdt:P957 "${isbn.slice(-10)}" } .
  OPTIONAL { ?item wdt:P8731 ?anilist . }
  OPTIONAL { ?item wdt:P4087 ?mal . }
  OPTIONAL { ?item wdt:P11494 ?kitsu . }
} LIMIT 1
`.trim();

  const url = `${ENDPOINT}?format=json&query=${encodeURIComponent(q)}`;
  const data = await fetchJson(url, { headers: { "User-Agent": "tools-labo/book-scout (contact: github)" } });
  const b = data?.results?.bindings?.[0];
  const qid = b?.item?.value?.split("/").pop() || null;

  cache[isbn] = {
    qid,
    anilist: b?.anilist?.value ? Number(b.anilist.value) : null,
    mal: b?.mal?.value ? Number(b.mal.value) : null,
    kitsu: b?.kitsu?.value ? Number(b.kitsu.value) : null
  };
  fetched++; qid ? fetched : miss++;

  if (fetched % 10 === 0) await sleep(300); // 軽く間引き
}

await fs.writeFile(OUT, JSON.stringify(cache, null, 2));
console.log(`wikidata_ids: reps=${reps.length} cache_hit=${hit} fetched=${fetched}`);
