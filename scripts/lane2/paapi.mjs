// scripts/lane2/paapi.mjs
import crypto from "node:crypto";

function hmac(key, data, encoding = undefined) {
  return crypto.createHmac("sha256", key).update(data, "utf8").digest(encoding);
}
function sha256Hex(data) {
  return crypto.createHash("sha256").update(data, "utf8").digest("hex");
}
function toAmzDate(d = new Date()) {
  // YYYYMMDD'T'HHMMSS'Z'
  const pad = (n) => String(n).padStart(2, "0");
  const YYYY = d.getUTCFullYear();
  const MM = pad(d.getUTCMonth() + 1);
  const DD = pad(d.getUTCDate());
  const hh = pad(d.getUTCHours());
  const mm = pad(d.getUTCMinutes());
  const ss = pad(d.getUTCSeconds());
  return `${YYYY}${MM}${DD}T${hh}${mm}${ss}Z`;
}
function dateStamp(amzDate) {
  return amzDate.slice(0, 8); // YYYYMMDD
}
function getSignatureKey(secretKey, datestamp, region, service) {
  const kDate = hmac("AWS4" + secretKey, datestamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}

export async function paapiSearchItems({
  host,
  region,
  marketplace,
  accessKey,
  secretKey,
  partnerTag,
  keywords,
  resources,
  searchIndex = "Books",
  itemCount = 10,
}) {
  if (!accessKey || !secretKey || !partnerTag) {
    throw new Error("Missing AMZ credentials (access/secret/partnerTag)");
  }

  const service = "ProductAdvertisingAPI";
  const target = "com.amazon.paapi5.v1.ProductAdvertisingAPIv1.SearchItems";

  const amzDate = toAmzDate();
  const datestamp = dateStamp(amzDate);

  const bodyObj = {
    Keywords: keywords,
    SearchIndex: searchIndex,
    ItemCount: itemCount,
    PartnerTag: partnerTag,
    PartnerType: "Associates",
    Marketplace: marketplace,
    Resources: resources,
  };

  const body = JSON.stringify(bodyObj);

  const method = "POST";
  const canonicalUri = "/paapi5/searchitems";
  const canonicalQuery = "";
  const canonicalHeaders =
    `content-encoding:amz-1.0\n` +
    `content-type:application/json; charset=utf-8\n` +
    `host:${host}\n` +
    `x-amz-date:${amzDate}\n` +
    `x-amz-target:${target}\n`;
  const signedHeaders =
    "content-encoding;content-type;host;x-amz-date;x-amz-target";
  const payloadHash = sha256Hex(body);

  const canonicalRequest =
    `${method}\n` +
    `${canonicalUri}\n` +
    `${canonicalQuery}\n` +
    `${canonicalHeaders}\n` +
    `${signedHeaders}\n` +
    `${payloadHash}`;

  const algorithm = "AWS4-HMAC-SHA256";
  const credentialScope = `${datestamp}/${region}/${service}/aws4_request`;
  const stringToSign =
    `${algorithm}\n` +
    `${amzDate}\n` +
    `${credentialScope}\n` +
    `${sha256Hex(canonicalRequest)}`;

  const signingKey = getSignatureKey(secretKey, datestamp, region, service);
  const signature = hmac(signingKey, stringToSign, "hex");

  const authorization =
    `${algorithm} ` +
    `Credential=${accessKey}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, ` +
    `Signature=${signature}`;

  const url = `https://${host}${canonicalUri}`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-encoding": "amz-1.0",
      "content-type": "application/json; charset=utf-8",
      "x-amz-date": amzDate,
      "x-amz-target": target,
      Authorization: authorization,
      Host: host,
    },
    body,
  });

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`PAAPI non-JSON response: HTTP ${res.status}: ${text.slice(0, 300)}`);
  }

  if (!res.ok) {
    // PAAPIは Errors 配列が来る
    throw new Error(`PAAPI error HTTP ${res.status}: ${JSON.stringify(json).slice(0, 500)}`);
  }

  return json;
}
