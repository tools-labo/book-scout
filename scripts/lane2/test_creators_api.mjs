// scripts/lane2/test_creators_api.mjs
// 独立テスト用
// 目的:
// 1) GitHub Secrets / .env の読み込み確認
// 2) Creators API への疎通確認
// 3) ステータスコード / レスポンス本文の確認
//
// 実行例:
// node scripts/lane2/test_creators_api.mjs
//
// 必須 env:
// AMAZON_CREATORS_CLIENT_ID
// AMAZON_CREATORS_CLIENT_SECRET
// AMAZON_PARTNER_TAG
// AMAZON_MARKETPLACE
//
// 任意 env:
// AMAZON_CREATORS_BASE_URL
// AMAZON_CREATORS_TEST_PATH
// AMAZON_TEST_ASIN

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
  console.log(`- BASE_URL: ${env.baseUrl || "(empty)"}`);
  console.log(`- TEST_PATH: ${env.testPath || "(empty)"}`);
  console.log(`- TEST_ASIN: ${env.testAsin || "(empty)"}`);
}

async function main() {
  const env = {
    clientId: norm(process.env.AMAZON_CREATORS_CLIENT_ID),
    clientSecret: norm(process.env.AMAZON_CREATORS_CLIENT_SECRET),
    partnerTag: norm(process.env.AMAZON_PARTNER_TAG),
    marketplace: norm(process.env.AMAZON_MARKETPLACE) || "www.amazon.co.jp",

    // ここはあとで実際の Creators API 情報に合わせて変更
    baseUrl: norm(process.env.AMAZON_CREATORS_BASE_URL),
    testPath: norm(process.env.AMAZON_CREATORS_TEST_PATH),
    testAsin: norm(process.env.AMAZON_TEST_ASIN),
  };

  printEnvSummary(env);

  const missing = [];
  if (!env.clientId) missing.push("AMAZON_CREATORS_CLIENT_ID");
  if (!env.clientSecret) missing.push("AMAZON_CREATORS_CLIENT_SECRET");
  if (!env.partnerTag) missing.push("AMAZON_PARTNER_TAG");
  if (!env.marketplace) missing.push("AMAZON_MARKETPLACE");
  if (!env.baseUrl) missing.push("AMAZON_CREATORS_BASE_URL");
  if (!env.testPath) missing.push("AMAZON_CREATORS_TEST_PATH");

  if (missing.length) {
    console.error(`[creators:test] missing env: ${missing.join(", ")}`);
    process.exit(1);
  }

  // ここは “疎通確認” が目的なので、まずは最小限の body を送る
  // 実際の Creators API の仕様が確定したら、ここを正式 payload に差し替える
  const payload = {
    asin: env.testAsin || undefined,
    partnerTag: env.partnerTag,
    marketplace: env.marketplace,
  };

  const url = `${env.baseUrl.replace(/\/+$/, "")}/${env.testPath.replace(/^\/+/, "")}`;

  console.log(`[creators:test] POST ${url}`);
  console.log(`[creators:test] payload keys = ${Object.keys(payload).filter((k) => payload[k] !== undefined).join(", ")}`);

  const headers = {
    "content-type": "application/json",
    // 仮置き:
    // どの header 名を使うかは Creators API の正式仕様に合わせて後で差し替え
    "x-client-id": env.clientId,
    "x-client-secret": env.clientSecret,
  };

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
  } catch (e) {
    console.error(`[creators:test] fetch failed: ${String(e?.message || e)}`);
    process.exit(1);
  }

  const text = await safeReadText(res);

  console.log(`[creators:test] status=${res.status} ok=${res.ok}`);

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
