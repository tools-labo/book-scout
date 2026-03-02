// scripts/build_sitemap.mjs
import fs from "node:fs";
import path from "node:path";

const ROOT_PUBLIC = "public";
const OUT_PATH = path.join(ROOT_PUBLIC, "sitemap.xml");

// ✅ 新ドメインに固定
const SITE_ORIGIN = "https://book-scout.tools-labo.com";

// 作品一覧のソース（split index）
const WORKS_INDEX = "data/lane2/works/index.json";

// base64url (no /, +, =)
// ※ build_work_pages.mjs と揃える
function b64urlFromUtf8(s) {
  const b64 = Buffer.from(String(s), "utf8").toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function safeReadJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function escXml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function isoDateOnly(iso) {
  // sitemap lastmod は YYYY-MM-DD が無難
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

function url(loc, lastmod) {
  const lm = lastmod ? `<lastmod>${escXml(lastmod)}</lastmod>` : "";
  return `  <url><loc>${escXml(loc)}</loc>${lm}</url>`;
}

function main() {
  const lastmod = isoDateOnly(process.env.SITEMAP_LASTMOD_ISO || new Date().toISOString());

  const idx = safeReadJson(WORKS_INDEX);
  const items = Array.isArray(idx?.listItems) ? idx.listItems : [];
  if (!items.length) {
    console.error("works index.json の listItems が読めません");
    process.exit(1);
  }

  const fixed = [
    `${SITE_ORIGIN}/`,
    `${SITE_ORIGIN}/list.html`,
    `${SITE_ORIGIN}/stats.html`,
    `${SITE_ORIGIN}/privacy/`,
  ];

  const workUrls = [];
  for (const it of items) {
    const seriesKey = String(it?.seriesKey || "").trim();
    if (!seriesKey) continue;
    const id = b64urlFromUtf8(seriesKey);
    workUrls.push(`${SITE_ORIGIN}/work/${id}/`);
  }

  // 重複排除（念のため）
  const uniq = Array.from(new Set([...fixed, ...workUrls]));

  const body = uniq.map((u) => url(u, lastmod)).join("\n");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    `${body}\n` +
    `</urlset>\n`;

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, xml, "utf8");

  console.log(`[build_sitemap] wrote ${OUT_PATH} urls=${uniq.length} lastmod=${lastmod}`);
}

main();
