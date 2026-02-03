import fs from "node:fs/promises";
import ProductAdvertisingAPIv1 from "paapi5-nodejs-sdk";

const accessKey = process.env.AMZ_ACCESS_KEY;
const secretKey = process.env.AMZ_SECRET_KEY;
const partnerTag = process.env.AMZ_PARTNER_TAG;
if (!accessKey || !secretKey || !partnerTag) throw new Error("missing AMZ_* secrets");

const client = ProductAdvertisingAPIv1.ApiClient.instance;
client.accessKey = accessKey;
client.secretKey = secretKey;
client.host = "webservices.amazon.co.jp";
client.region = "us-west-2";
const api = new ProductAdvertisingAPIv1.DefaultApi();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const digits = (s) => String(s || "").replace(/\D/g, "");

function isbn13to10(isbn13) {
  const s = digits(isbn13);
  if (s.length !== 13 || !s.startsWith("978")) return null;
  const core = s.slice(3, 12); // 9 digits
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += (10 - i) * Number(core[i]);
  const r = 11 - (sum % 11);
  const cd = r === 10 ? "X" : r === 11 ? "0" : String(r);
  return core + cd;
}

const pickIsbns = (it) => {
  const a = it?.ItemInfo?.ExternalIds?.ISBNs?.DisplayValues || [];
  const b = it?.ItemInfo?.ExternalIds?.EANs?.DisplayValues || [];
  // 10桁/13桁/混在があるので全部digits化して持つ
  return [...a, ...b].map(digits).filter(Boolean);
};

const isSetTitle = (t) => {
  const s = String(t || "");
  return (
    s.includes("セット") ||
    s.includes("全巻") ||
    s.includes("BOX") ||
    s.includes("ボックス") ||
    s.includes("まとめ") ||
    s.includes("コミックセット") ||
    /\b\d+\s*-\s*\d+\b/.test(s) ||
    /1\s*〜\s*\d+/.test(s)
  );
};

async function searchByKeyword(keyword) {
  const req = new ProductAdvertisingAPIv1.SearchItemsRequest();
  req.PartnerTag = partnerTag;
  req.PartnerType = "Associates";
  req.SearchIndex = "Books";
  req.Keywords = String(keyword);
  req.ItemCount = 10;
  req.Resources = ["ItemInfo.ExternalIds", "ItemInfo.Title"];

  return await new Promise((resolve) => {
    api.searchItems(req, (err, data) => {
      if (err) return resolve({ ok: false, err });
      const res = ProductAdvertisingAPIv1.SearchItemsResponse.constructFromObject(data);
      resolve({ ok: true, list: res?.SearchResult?.Items || [] });
    });
  });
}

const items = JSON.parse(await fs.readFile("data/manga/items_master.json", "utf8"));

const targets = items.filter(
  (x) => x.seriesType === "main" && x.volumeHint === 1 && x.isbn13 && !x.asin && !x.amazonUrl
);

let added = 0,
  apiErr = 0,
  empty = 0,
  notFound = 0,
  setBlocked = 0,
  dbgErr = false;

for (const x of targets) {
  const want13 = digits(x.isbn13);
  const want10 = isbn13to10(want13); // 978のみ10桁へ
  const r = await searchByKeyword(want13);

  if (!r.ok) {
    apiErr++;
    if (!dbgErr) {
      console.log(`[amazon_asin] API_ERR example: ${String(r.err?.message || r.err).slice(0, 220)}`);
      dbgErr = true;
    }
    await sleep(120);
    continue;
  }

  if (!r.list.length) {
    empty++;
    await sleep(120);
    continue;
  }

  // ISBN-13一致 or ISBN-10一致（Xはdigitsで落ちるので10桁側は大文字Xを考慮）
  let hit = null;
  for (const it of r.list) {
    const isbns = pickIsbns(it);
    if (isbns.includes(want13)) { hit = it; break; }
    if (want10) {
      const raw = (it?.ItemInfo?.ExternalIds?.ISBNs?.DisplayValues || [])[0] || "";
      const raw10 = raw.toUpperCase().replace(/[^0-9X]/g, "");
      if (raw10 && raw10 === want10) { hit = it; break; }
    }
  }

  if (!hit) {
    notFound++;
    await sleep(120);
    continue;
  }

  const title = hit?.ItemInfo?.Title?.DisplayValue || "";
  if (isSetTitle(title)) {
    setBlocked++;
    await sleep(120);
    continue;
  }

  x.asin = hit.ASIN || null;
  x.amazonUrl = hit.DetailPageURL || null;
  if (x.asin || x.amazonUrl) added++;

  await sleep(120);
}

await fs.writeFile("data/manga/items_master.json", JSON.stringify(items, null, 2));
console.log(`asin_added=${added} targets=${targets.length} api_err=${apiErr} empty=${empty} not_found=${notFound} set_blocked=${setBlocked}`);
