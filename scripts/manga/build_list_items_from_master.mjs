// scripts/manga/build_list_items_from_master.mjs
import fs from "node:fs/promises";

const ITEMS = "data/manga/items_master.json";
const SERIES = "data/manga/series_master.json";
const OUT = "data/manga/list_items.json";

async function loadJson(path, fallback) {
  try {
    return JSON.parse(await fs.readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

async function saveJson(path, obj) {
  await fs.mkdir(path.split("/").slice(0, -1).join("/"), { recursive: true });
  await fs.writeFile(path, JSON.stringify(obj, null, 2));
}

function dpFrom(asinOrUrl) {
  if (!asinOrUrl) return null;
  const s = String(asinOrUrl).trim();
  const m = s.match(/^https:\/\/www\.amazon\.co\.jp\/dp\/([A-Z0-9]{10}|[0-9]{9}X|[0-9]{10})(?:[/?].*)?$/i);
  if (m) return `https://www.amazon.co.jp/dp/${m[1]}`;
  const asin = s.toUpperCase().replace(/[^0-9A-Z]/g, "");
  if (/^[A-Z0-9]{10}$/.test(asin)) return `https://www.amazon.co.jp/dp/${asin}`;
  return null;
}

function toNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

// 最新刊判定：volumeHint があればそれ優先、なければ publishedAt 文字列で比較（簡易）
function pickLatest(prev, cur) {
  if (!prev) return cur;
  const pv = toNum(prev.volumeHint);
  const cv = toNum(cur.volumeHint);
  if (pv != null && cv != null) return cv > pv ? cur : prev;
  // fallback: publishedAt
  const pa = String(prev.publishedAt || "");
  const ca = String(cur.publishedAt || "");
  return ca > pa ?
