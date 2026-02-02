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
client.region = "us-west-2"; // JP locale  [oai_citation:1‡Amazon Web Services](https://webservices.amazon.com/paapi5/documentation/common-request-parameters.html)

const api = new ProductAdvertisingAPIv1.DefaultApi();

const items = JSON.parse(await fs.readFile("data/manga/items_master.json", "utf8"));
const targets = items.slice(0, 30);

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
    req.ItemCount = 3; // 複数返る可能性があるので少しだけ  [oai_citation:2‡Amazon Web Services](https://webservices.amazon.com/paapi5/documentation/use-cases/search-with-external-identifiers.html?utm_source=chatgpt.com)
    req.Resources = ["ItemInfo.ExternalIds", "ItemInfo.Title"];

    api.searchItems(req, (err, data) => {
      if (err) return resolve({ ok: false, err });
      const res = ProductAdvertisingAPIv1.SearchItemsResponse.constructFromObject(data);
      const list = res?.SearchResult?.Items || [];
      const hit = list.find((x) => pickIsbn(x) === String(isbn)) || list[0];
      if (!hit) return resolve({ ok: true, asin: null, url: null });
      resolve({ ok: true, asin: hit.ASIN || null, url: hit.DetailPageURL || null });
    });
  });
}

let ok = 0;
for (const x of targets) {
  if (!x.isbn13 || x.asin) continue;
  const r = await isbnToAsin(x.isbn13);
  if (r.ok && r.asin) {
    x.asin = r.asin;
    x.amazonUrl = r.url;
    ok++;
  }
}

await fs.writeFile("data/manga/items_master.json", JSON.stringify(items, null, 2));
console.log(`asin_added=${ok}`);
