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

const items = JSON.parse(await fs.readFile("data/manga/items_master.json", "utf8"));

const digits = (s) => String(s || "").replace(/\D/g, "");
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

const pickIsbn13 = (item) => {
  const a = item?.ItemInfo?.ExternalIds?.ISBNs?.DisplayValues || [];
  const b = item?.ItemInfo?.ExternalIds?.EANs?.DisplayValues || [];
  return digits(a[0] || b[0] || "");
};

async function searchByIsbn(isbn13) {
  const req = new ProductAdvertisingAPIv1.SearchItemsRequest();
  req.PartnerTag = partnerTag;
  req.PartnerType = "Associates";
  req.SearchIndex = "Books";
  req.Keywords = String(isbn13);
  req.ItemCount = 10;
  req.Resources = ["ItemInfo.ExternalIds", "ItemInfo.Title"];

  return await new Promise((resolve) => {
    api.searchItems(req, (err, data) => {
      if (err) return resolve({ ok: false, err });
      const res = ProductAdvertisingAPIv1.SearchItemsResponse.constructFromObject(data);
      const list = res?.SearchResult?.Items || [];
      resolve({ ok: true, list });
    });
  });
}

// ★対象は「①巻(main&vol1)で asin/amazonUrl が空」のものだけ
const targets = items.filter(
  (x) => x.seriesType === "main" && x.volumeHint === 1 && x.isbn13 && !x.asin && !x.amazonUrl
);

let added = 0, setBlocked = 0, notFound = 0;

for (const x of targets) {
  const want = digits(x.isbn13);
  const r = await searchByIsbn(want);
  if (!r.ok) continue;

  const hit = (r.list || []).find((it) => pickIsbn13(it) === want) || null;
  if (!hit) { notFound++; continue; }

  const title = hit?.ItemInfo?.Title?.DisplayValue || "";
  if (isSetTitle(title)) { setBlocked++; continue; }

  x.asin = hit.ASIN || null;
  x.amazonUrl = hit.DetailPageURL || null;
  if (x.asin || x.amazonUrl) added++;
}

await fs.writeFile("data/manga/items_master.json", JSON.stringify(items, null, 2));
console.log(`asin_added=${added} targets=${targets.length} set_blocked=${setBlocked} not_found=${notFound}`);
