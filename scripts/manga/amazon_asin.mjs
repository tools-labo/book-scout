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

const path = "data/manga/items_master.json";
const items = JSON.parse(await fs.readFile(path, "utf8"));

const pickIsbn = (item) =>
  item?.ItemInfo?.ExternalIds?.ISBNs?.DisplayValues?.[0] ||
  item?.ItemInfo?.ExternalIds?.EANs?.DisplayValues?.[0] ||
  null;

async function isbnToAsin(isbn) {
  return await new Promise((resolve) => {
    const req = new ProductAdvertisingAPIv1.SearchItemsRequest();
    req.PartnerTag = partnerTag;
    req.PartnerType = "Associates";
    req.SearchIndex = "Books";
    req.Keywords = String(isbn);
    req.ItemCount = 3;
    req.Resources = ["ItemInfo.ExternalIds", "ItemInfo.Title"];

    api.searchItems(req, (err, data) => {
      if (err) return resolve({ ok: false, err });
      const res = ProductAdvertisingAPIv1.SearchItemsResponse.constructFromObject(data);
      const list = res?.SearchResult?.Items || [];
      const exact = list.find((x) => pickIsbn(x) === String(isbn)) || null;
if (!exact) return resolve({ ok: true, asin: null, url: null });

const title = exact?.ItemInfo?.Title?.DisplayValue || "";
if (isSetTitle(title)) return resolve({ ok: true, asin: null, url: null });

resolve({ ok: true, asin: exact.ASIN || null, url: exact.DetailPageURL || null });
    });
  });
}

// ①優先順：_rep → main&vol1 → main → その他（ASIN未付与のみ）
const need = items
  .filter((x) => x.isbn13 && !x.asin && !x.amazonUrl)
  .map((x) => {
    const p =
      (x._rep ? 0 : 10) +
      (x.seriesType === "main" && x.volumeHint === 1 ? 0 : 2) +
      (x.seriesType === "main" ? 0 : 4);
    return { x, p };
  })
  .sort((a, b) => a.p - b.p)
  .slice(0, 30)
  .map((o) => o.x);

let ok = 0;
for (const x of need) {
  const r = await isbnToAsin(x.isbn13);
  if (r.ok && r.asin) {
    x.asin = r.asin;
    x.amazonUrl = r.url;
    ok++;
  }
}

const isSetTitle = (t) => {
  const s = String(t || "").toLowerCase();
  return (
    s.includes("セット") ||
    s.includes("全巻") ||
    s.includes("box") ||
    s.includes("ボックス") ||
    s.includes("まとめ") ||
    s.includes("コミックセット") ||
    s.match(/\b\d+\s*-\s*\d+\b/) ||   // 1-11
    s.match(/1\s*〜\s*\d+/)           // 1〜11
  );
};
await fs.writeFile(path, JSON.stringify(items, null, 2));
console.log(`asin_added=${ok} targets=${need.length} items=${items.length}`);
