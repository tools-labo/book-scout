import fs from "node:fs/promises";
import path from "node:path";

export async function loadJson(p, fallback) {
  try {
    return JSON.parse(await fs.readFile(p, "utf8"));
  } catch {
    return fallback;
  }
}
export async function saveJson(p, obj) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(obj, null, 2));
}
export function nowIso() {
  return new Date().toISOString();
}
export function norm(s) {
  return String(s ?? "").trim();
}
