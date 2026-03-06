// scripts/lane2/test_creators_api.mjs
// FULL REPLACE
// Creators API 独立テスト
// - OAuth2 access token を取得
// - GetItems を1回叩く
// - status と response を確認する
//
// 必須 env:
// AMAZON_CREATORS_CLIENT_ID
// AMAZON_CREATORS_CLIENT_SECRET
// AMAZON_PARTNER_TAG
// AMAZON_MARKETPLACE
//
// 任意 env:
// AMAZON_TEST_ASIN
// AMAZON_CREATORS_TOKEN_URL
// AMAZON_CREATORS_BASE_URL

function norm(v) {
  return String(v ?? "").trim();
}

function mask(v, keepStart = 4, keepEnd = 3) {
  const s = norm(v);
  if (!s) return "(empty)";
  if (s.length <= keepStart + keepEnd) return "*".repeat(s.length);
  return `${s.slice(0, keepStart)}***${s.slice(-keepEnd)}`;
}

async function safeReadText(res) {
  try {
    return await res.text();
  } catch (e) {
    return `[read_text_failed] ${String(e?.message || e)}`;
  }
}

function printEnvSummary(env) {
  console.log("[creators:test] env");
  console.log(`- CLIENT_ID: ${mask(env.clientId)}`);
  console.log(`- CLIENT_SECRET: ${env.clientSecret ? "(set)" : "(empty)"}`);
  console.log(`- PARTNER_TAG: ${env.partnerTag || "(empty)"}`);
  console.log(`- MARKETPLACE: ${env.marketplace || "(empty)"}`);
  console.log(`- TOKEN_URL: ${env.tokenUrl || "(empty)"}`);
  console.log(`- BASE_URL: ${env.baseUrl || "(empty)"}`);
  console.log(`- TEST_ASIN: ${env.testAsin || "(empty)"}`);
}

async function fetchAccessTokenV2(env) {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: env.clientId,
    client_secret: env.clientSecret,
    scope: "creatorsapi/default",
  }).toString();

  const res = await fetch(env.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  const text = await safeReadText(res);

  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }

  if (!res.ok) {
    console.error(`[creators:test] token status=${res.status} ok=${res.ok}`);
    if (json) {
      console.error(JSON.stringify(json, null, 2));
    } else {
      console.error(text);
    }
    process.exit(2);
  }

  const accessToken = norm(json?.access_token);
  if (!accessToken) {
    console.error("[creators:test] token response has no access_token");
    console.error(json ? JSON.stringify(json, null, 2) : text);
    process.exit(2);
  }

  console.log("[creators:test] token acquired");
  return accessToken;
}

async function main() {
  const env = {
    clientId: norm(process.env.AMAZON_CREATORS_CLIENT_ID),
    clientSecret: norm(process.env.AMAZON_CREATORS_CLIENT_SECRET),
    partnerTag: norm(process.env.AMAZON_PARTNER_TAG),
    marketplace: norm(process.env.AMAZON_MARKETPLACE) || "www.amazon.co.jp",

    // FE / JP の v2.3 token endpoint
    tokenUrl:
      norm(process.env.AMAZON_CREATORS_TOKEN_URL) ||
      "https://creatorsapi.auth.us-west-2.amazoncognito.com/oauth2/token",

    // Docs の base URL
    baseUrl:
      norm(process.env.AMAZON_CREATORS_BASE_URL) ||
      "https://creatorsapi.amazon",

    testAsin: norm(process.env.AMAZON_TEST_ASIN) || "4088821297",
  };

  printEnvSummary(env);

  const missing = [];
  if (!env.clientId) missing.push("AMAZON_CREATORS_CLIENT_ID");
  if (!env.clientSecret) missing.push("AMAZON_CREATORS_CLIENT_SECRET");
  if (!env.partnerTag) missing.push("AMAZON_PARTNER_TAG");
  if (!env.marketplace) missing.push("AMAZON_MARKETPLACE");

  if (missing.length) {
    console.error(`[creators:test] missing env: ${missing.join(", ")}`);
    process.exit(1);
  }

  const accessToken = await fetchAccessTokenV2(env);

  const url = `${env.baseUrl}/catalog/v1/getItems`;
  const payload = {
    itemIds: [env.testAsin],
    itemIdType: "ASIN",
    marketplace: env.marketplace,
    partnerTag: env.partnerTag,
    resources: [
      "images.primary.small",
      "images.primary.medium",
      "images.primary.large",
      "itemInfo.title",
      "itemInfo.byLineInfo",
      "itemInfo.contentInfo",
    ],
  };

  console.log(`[creators:test] POST ${url}`);
  console.log(`[creators:test] asin=${env.testAsin}`);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}, Version 2.3`,
      "Content-Type": "application/json",
      "x-marketplace": env.marketplace,
    },
    body: JSON.stringify(payload),
  });

  const text = await safeReadText(res);

  console.log(`[creators:test] api status=${res.status} ok=${res.ok}`);

  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }

  if (json) {
    console.log("[creators:test] json response:");
    console.log(JSON.stringify(json, null, 2));
  } else {
    console.log("[creators:test] text response:");
    console.log(text);
  }

  if (!res.ok) {
    process.exit(2);
  }
}

main().catch((e) => {
  console.error(`[creators:test] fatal: ${String(e?.message || e)}`);
  process.exit(1);
});
