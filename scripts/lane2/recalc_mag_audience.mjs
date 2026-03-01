// scripts/lane2/recalc_mag_audience.mjs
// FULL REPLACE
// 目的：data/lane2/enriched/*（sharded）を読み、magazine_audience.json の辞書で vol1.audiences を再計算して上書きする
// - 入力：data/lane2/enriched/index.json + enriched_XXX.json
// - 入力：data/lane2/magazine_audience.json
// - 出力：変更があった enriched_XXX.json を上書き（差分のみ）
// - 出力：data/lane2/magazine_audience_todo.json（辞書に無い連載誌のメモ）
// - 出力：index.json の updatedAt / stats に反映（任意だが有用）
//
// 使い方（Actions/ローカル共通想定）:
//   node scripts/lane2/recalc_mag_audience.mjs
//
// NOTE:
// - 既存機能を壊さない：vol1 の他フィールドは触らない
// - vol1.magazines があればそれを優先して使う（あなたの意図どおり）
// - vol1.magazines が無い場合だけ vol1.magazine を軽く split して推定する（安全寄り）

import fs from "node:fs/promises";
import path from "node:path";

const IN_ENRICH_DIR = "data/lane2/enriched";
const IN_ENRICH_INDEX = `${IN_ENRICH_DIR}/index.json`;

const IN_MAG_AUDIENCE = "data/lane2/magazine_audience.json";
const OUT_MAG_AUDIENCE_TODO = "data/lane2/magazine_audience_todo.json";

function nowIso() {
  return new Date().toISOString();
}

function norm(s) {
  return String(s ?? "").trim();
}

/**
 * 雑誌名の辞書一致を安定化する正規化（enrich と同系統）
 */
function normMagazineKey(s) {
  return String(s ?? "")
    .replace(/\u00A0/g, " ")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/[　]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .normalize("NFKC");
}

function uniq(arr) {
  const out = [];
  const seen = new Set();
  for (const x of arr || []) {
    const s = norm(x);
    if (!s) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

async function loadJsonStrict(p) {
  const txt = await fs.readFile(p, "utf8");
  try {
    return JSON.parse(txt);
  } catch (e) {
    const msg = e?.message ? String(e.message) : String(e);
    throw new Error(`[lane2:recalc_mag_audience] JSON parse failed: ${p} (${msg})`);
  }
}

async function saveJson(p, obj) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(obj, null, 2));
}

/**
 * magazine_audience.json の items: { "少年":[...], "青年":[...], ... } を
 * Map<magazineKey, audience> にする
 */
function loadMagAudienceMap(json) {
  const items = json?.items && typeof json.items === "object" ? json.items : {};
  const out = new Map();
  for (const [aud, mags] of Object.entries(items)) {
    if (!Array.isArray(mags)) continue;
    for (const m of mags) {
      const k = normMagazineKey(m);
      if (!k) continue;
      // 先勝ちでOK（同一雑誌が複数audに入ってたら辞書側の問題なので触らない）
      if (!out.has(k)) out.set(k, String(aud));
    }
  }
  return out;
}

/**
 * vol1.magazine の軽い分割（安全寄り）
 * - enriched 側には既に vol1.magazines が入ってる想定なので、これはフォールバック用
 */
function splitMagazinesLoose(magazineStr) {
  const s = normMagazineKey(magazineStr);
  if (!s) return [];

  // まずは一般的な区切り
  const parts = s
    .split(/[\n\/／・,、]/g)
    .map((x) => normMagazineKey(x))
    .filter(Boolean);

  // 「→」は履歴系が混ざるが、既存仕様でも split していたので踏襲
  const mags = parts.flatMap((p) => p.split("→").map((x) => normMagazineKey(x)).filter(Boolean));

  return uniq(mags);
}

/**
 * audiences 再計算
 * - 辞書にあるものだけ拾う
 * - 何も拾えなければ "その他" にする（既存仕様踏襲）
 * - 辞書に無い雑誌は todo に積む
 */
function recalcAudiences({ magazines, magAudienceMap, todoSet }) {
  const auds = new Set();

  for (const m0 of magazines || []) {
    const m = normMagazineKey(m0);
    if (!m) continue;

    const a = magAudienceMap.get(m) || null;
    if (a) auds.add(a);
    else if (todoSet) todoSet.add(m);
  }

  if (auds.size === 0) auds.add("その他");
  return Array.from(auds);
}

function sameArray(a, b) {
  const aa = Array.isArray(a) ? a : [];
  const bb = Array.isArray(b) ? b : [];
  if (aa.length !== bb.length) return false;
  for (let i = 0; i < aa.length; i++) if (aa[i] !== bb[i]) return false;
  return true;
}

async function main() {
  const idx = await loadJsonStrict(IN_ENRICH_INDEX);
  const shards = Array.isArray(idx?.shards) ? idx.shards : [];
  if (!shards.length) throw new Error(`[lane2:recalc_mag_audience] no shards in ${IN_ENRICH_INDEX}`);

  const magAudienceJson = await loadJsonStrict(IN_MAG_AUDIENCE);
  const magAudienceMap = loadMagAudienceMap(magAudienceJson);

  let changedItems = 0;
  let changedShards = 0;
  const todoSet = new Set();

  for (const sh of shards) {
    const file = norm(sh?.file);
    if (!file) continue;

    const shardPath = path.join(IN_ENRICH_DIR, file);
    const shardJson = await loadJsonStrict(shardPath);
    const items = Array.isArray(shardJson?.items) ? shardJson.items : [];

    let shardChanged = 0;

    for (const it of items) {
      const v = it?.vol1;
      if (!v || typeof v !== "object") continue;

      // magazines 優先（あなたの希望どおり）
      const mags =
        Array.isArray(v.magazines) && v.magazines.length
          ? uniq(v.magazines.map(normMagazineKey).filter(Boolean))
          : splitMagazinesLoose(v.magazine);

      const nextAud = recalcAudiences({ magazines: mags, magAudienceMap, todoSet });
      // 見た目を安定させる：辞書順が変わらないようにソート（audiencesの並びブレ防止）
      nextAud.sort((a, b) => String(a).localeCompare(String(b), "ja"));

      const prevAud = Array.isArray(v.audiences) ? v.audiences.map(norm).filter(Boolean) : [];
      prevAud.sort((a, b) => String(a).localeCompare(String(b), "ja"));

      if (!sameArray(prevAud, nextAud)) {
        v.audiences = nextAud;
        shardChanged++;
        changedItems++;
      }
    }

    if (shardChanged > 0) {
      shardJson.items = items;
      await saveJson(shardPath, shardJson);
      changedShards++;
    }
  }

  // todo を保存
  const todoItems = Array.from(todoSet).map(normMagazineKey).filter(Boolean);
  todoItems.sort((a, b) => a.localeCompare(b, "ja"));

  await saveJson(OUT_MAG_AUDIENCE_TODO, {
    version: 1,
    updatedAt: nowIso(),
    total: todoItems.length,
    items: todoItems,
  });

  // index.json に軽く記録（邪魔なら消してOK）
  const nextIdx = { ...idx };
  nextIdx.updatedAt = nowIso();
  nextIdx.stats = {
    ...(idx?.stats && typeof idx.stats === "object" ? idx.stats : {}),
    magAudienceRecalc: {
      at: nextIdx.updatedAt,
      changedItems,
      changedShards,
      todoTotal: todoItems.length,
      note: "recalc_mag_audience.mjs により vol1.audiences を magazine_audience.json で再計算",
    },
  };

  await saveJson(IN_ENRICH_INDEX, nextIdx);

  console.log(
    `[lane2:recalc_mag_audience] shards=${shards.length} changedShards=${changedShards} changedItems=${changedItems} todo=${todoItems.length} -> updated ${IN_ENRICH_INDEX}`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
