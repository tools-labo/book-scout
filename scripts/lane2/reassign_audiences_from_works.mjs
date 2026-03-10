// scripts/lane2/reassign_audiences_from_works.mjs
// NEW FILE
//
// 目的:
// - works を正本として audiences だけを再判定する
// - 反映先は works + enriched の両方
// - perfect skip/enrich 本体には一切触らない
// - 手動実行専用
//
// 使い方:
//   dry-run: node scripts/lane2/reassign_audiences_from_works.mjs
//   write  : node scripts/lane2/reassign_audiences_from_works.mjs --write
//
// 更新対象:
// - data/lane2/works/index.json                      : listItems[].audiences
// - data/lane2/works/works_*.json                    : items[].audiences / items[].vol1.audiences(あれば)
// - data/lane2/enriched/enriched_*.json              : items[].vol1.audiences
//
// 更新しない条件:
// - magazine / magazines が空
// - 正規化後の連載誌が空
// - 1件も辞書にマッチしない
// → この場合は既存 audiences を維持
//
// レポート:
// - data/lane2/magazine_audience_reassign_report.json

import fs from "node:fs/promises";
import path from "node:path";

const WORKS_DIR = "data/lane2/works";
const WORKS_INDEX = `${WORKS_DIR}/index.json`;

const ENRICH_DIR = "data/lane2/enriched";
const ENRICH_INDEX = `${ENRICH_DIR}/index.json`;

const IN_MAG_AUDIENCE = "data/lane2/magazine_audience.json";
const IN_MAG_NORMALIZE = "data/lane2/magazine_normalize.json";

const OUT_REPORT = "data/lane2/magazine_audience_reassign_report.json";

const AUD_ORDER = ["少年", "青年", "少女", "女性", "Web/アプリ", "その他"];

function nowIso() {
  return new Date().toISOString();
}

async function loadJsonStrict(p) {
  const txt = await fs.readFile(p, "utf8");
  return JSON.parse(txt);
}

async function saveJson(p, obj) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(obj, null, 2));
}

function norm(s) {
  return String(s ?? "").trim();
}

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

function sortAudiences(arr) {
  const xs = uniq(arr).filter(Boolean);
  return xs.sort((a, b) => {
    const ia = AUD_ORDER.indexOf(a);
    const ib = AUD_ORDER.indexOf(b);
    const va = ia >= 0 ? ia : 999;
    const vb = ib >= 0 ? ib : 999;
    return va - vb || a.localeCompare(b, "ja");
  });
}

function sameArray(a, b) {
  const aa = Array.isArray(a) ? a : [];
  const bb = Array.isArray(b) ? b : [];
  if (aa.length !== bb.length) return false;
  for (let i = 0; i < aa.length; i++) {
    if (aa[i] !== bb[i]) return false;
  }
  return true;
}

function splitMagazines(raw) {
  const s = norm(raw);
  if (!s) return [];

  const parts = s
    .split(/[\n\/／・,、]/g)
    .map((x) => norm(x))
    .filter(Boolean);

  const mags = parts.flatMap((p) =>
    p.split("→").map((x) => norm(x)).filter(Boolean)
  );

  return uniq(mags.map(normMagazineKey)).filter(Boolean);
}

function buildNormalizer(magNormalizeJson) {
  const aliasRaw = magNormalizeJson?.normalize?.canonicalByAlias || {};
  const dropRaw = Array.isArray(magNormalizeJson?.normalize?.dropIfMatched)
    ? magNormalizeJson.normalize.dropIfMatched
    : [];

  const alias = new Map();
  for (const [k, v] of Object.entries(aliasRaw)) {
    const kk = normMagazineKey(k);
    const vv = normMagazineKey(v);
    if (!kk || !vv) continue;
    alias.set(kk, vv);
  }

  const drop = new Set(dropRaw.map(normMagazineKey).filter(Boolean));

  return function normalizeMagazineName(raw) {
    let s = normMagazineKey(raw);
    if (!s) return "";

    if (alias.has(s)) s = alias.get(s) || s;
    s = normMagazineKey(s);

    if (drop.has(s)) return "";
    return s;
  };
}

function buildAudienceMap(magAudienceJson, magNormalizeJson) {
  const normalizeMagazineName = buildNormalizer(magNormalizeJson);
  const map = new Map();

  const items = magAudienceJson?.items && typeof magAudienceJson.items === "object"
    ? magAudienceJson.items
    : {};

  for (const [aud, mags] of Object.entries(items)) {
    if (!Array.isArray(mags)) continue;
    for (const raw of mags) {
      const m = normalizeMagazineName(raw);
      if (!m) continue;
      map.set(m, aud);
    }
  }

  // 保険: webGroup も Web/アプリ に寄せる
  const webItems = Array.isArray(magNormalizeJson?.webGroup?.items)
    ? magNormalizeJson.webGroup.items
    : [];

  for (const raw of webItems) {
    const m = normalizeMagazineName(raw);
    if (!m) continue;
    map.set(m, "Web/アプリ");
  }

  return { magAudienceMap: map, normalizeMagazineName };
}

function extractCanonicalMagazines(item, normalizeMagazineName) {
  const out = [];

  const mags = Array.isArray(item?.magazines) ? item.magazines : [];
  if (mags.length) {
    for (const raw of mags) {
      for (const s of splitMagazines(raw)) {
        const m = normalizeMagazineName(s);
        if (m) out.push(m);
      }
    }
  } else {
    const one = norm(item?.magazine);
    if (one) {
      for (const s of splitMagazines(one)) {
        const m = normalizeMagazineName(s);
        if (m) out.push(m);
      }
    }
  }

  return uniq(out);
}

function decideAudiencesFromWorksItem(item, { magAudienceMap, normalizeMagazineName }) {
  const existing = sortAudiences(Array.isArray(item?.audiences) ? item.audiences : []);
  const magazinesCanonical = extractCanonicalMagazines(item, normalizeMagazineName);

  if (!magazinesCanonical.length) {
    return {
      mode: "keep_no_magazine",
      existingAudiences: existing,
      nextAudiences: existing,
      magazinesCanonical,
      unknownMagazines: [],
      matchedAudiences: [],
      changed: false,
    };
  }

  const matchedAudiences = [];
  const unknownMagazines = [];

  for (const mag of magazinesCanonical) {
    const aud = magAudienceMap.get(mag);
    if (aud) matchedAudiences.push(aud);
    else unknownMagazines.push(mag);
  }

  if (!matchedAudiences.length) {
    return {
      mode: "keep_no_match",
      existingAudiences: existing,
      nextAudiences: existing,
      magazinesCanonical,
      unknownMagazines: uniq(unknownMagazines),
      matchedAudiences: [],
      changed: false,
    };
  }

  const next = sortAudiences(matchedAudiences);

  return {
    mode: "reassigned",
    existingAudiences: existing,
    nextAudiences: next,
    magazinesCanonical,
    unknownMagazines: uniq(unknownMagazines),
    matchedAudiences: sortAudiences(matchedAudiences),
    changed: !sameArray(existing, next),
  };
}

async function loadShardFilesFromIndex(indexPath, dirPath) {
  const idx = await loadJsonStrict(indexPath);
  const shards = Array.isArray(idx?.shards) ? idx.shards : [];

  const files = shards
    .map((s) => norm(s?.file))
    .filter(Boolean)
    .map((file) => ({
      file,
      path: path.join(dirPath, file),
    }));

  return { idx, files };
}

function setItemAudiences(target, nextAudiences) {
  if (!target || typeof target !== "object") return;
  target.audiences = nextAudiences;
  if (target.vol1 && typeof target.vol1 === "object") {
    target.vol1.audiences = nextAudiences;
  }
}

async function main() {
  const write = process.argv.includes("--write");

  const magAudienceJson = await loadJsonStrict(IN_MAG_AUDIENCE);
  const magNormalizeJson = await loadJsonStrict(IN_MAG_NORMALIZE);

  const { magAudienceMap, normalizeMagazineName } =
    buildAudienceMap(magAudienceJson, magNormalizeJson);

  // works index
  const worksIndex = await loadJsonStrict(WORKS_INDEX);
  const worksListItems = Array.isArray(worksIndex?.listItems) ? worksIndex.listItems : [];

  // works shards
  const worksLoaded = await loadShardFilesFromIndex(WORKS_INDEX, WORKS_DIR);
  const worksShardJsons = [];
  for (const f of worksLoaded.files) {
    const json = await loadJsonStrict(f.path);
    worksShardJsons.push({ ...f, json });
  }

  // enriched shards
  const enrichLoaded = await loadShardFilesFromIndex(ENRICH_INDEX, ENRICH_DIR);
  const enrichShardJsons = [];
  for (const f of enrichLoaded.files) {
    const json = await loadJsonStrict(f.path);
    enrichShardJsons.push({ ...f, json });
  }

  const report = {
    version: 1,
    updatedAt: nowIso(),
    mode: write ? "write" : "dry-run",
    totalWorksItems: 0,
    changedSeries: 0,
    unchangedSeries: 0,
    keptNoMagazine: 0,
    keptNoMatch: 0,
    unknownMagazines: [],
    samplesChanged: [],
    samplesKeptNoMatch: [],
  };

  const unknownSet = new Set();
  const decisionMap = new Map(); // seriesKey -> decision

  // 正本: works shard items
  for (const shard of worksShardJsons) {
    const items = Array.isArray(shard?.json?.items) ? shard.json.items : [];
    for (const item of items) {
      const seriesKey = norm(item?.seriesKey);
      if (!seriesKey) continue;

      const decision = decideAudiencesFromWorksItem(item, {
        magAudienceMap,
        normalizeMagazineName,
      });

      decisionMap.set(seriesKey, decision);
      report.totalWorksItems++;

      for (const m of decision.unknownMagazines || []) unknownSet.add(m);

      if (decision.mode === "keep_no_magazine") report.keptNoMagazine++;
      if (decision.mode === "keep_no_match") report.keptNoMatch++;

      if (decision.changed) {
        report.changedSeries++;
        if (report.samplesChanged.length < 30) {
          report.samplesChanged.push({
            seriesKey,
            magazine: norm(item?.magazine),
            magazines: Array.isArray(item?.magazines) ? item.magazines : [],
            existingAudiences: decision.existingAudiences,
            nextAudiences: decision.nextAudiences,
            magazinesCanonical: decision.magazinesCanonical,
          });
        }
      } else {
        report.unchangedSeries++;
      }

      if (decision.mode === "keep_no_match" && report.samplesKeptNoMatch.length < 30) {
        report.samplesKeptNoMatch.push({
          seriesKey,
          magazine: norm(item?.magazine),
          magazines: Array.isArray(item?.magazines) ? item.magazines : [],
          existingAudiences: decision.existingAudiences,
          unknownMagazines: decision.unknownMagazines,
        });
      }
    }
  }

  report.unknownMagazines = Array.from(unknownSet).sort((a, b) => a.localeCompare(b, "ja"));

  // works/index.json 更新
  if (Array.isArray(worksIndex?.listItems)) {
    for (const item of worksIndex.listItems) {
      const sk = norm(item?.seriesKey);
      if (!sk) continue;
      const d = decisionMap.get(sk);
      if (!d) continue;
      setItemAudiences(item, d.nextAudiences);
    }
  }

  // works shards 更新
  for (const shard of worksShardJsons) {
    const items = Array.isArray(shard?.json?.items) ? shard.json.items : [];
    for (const item of items) {
      const sk = norm(item?.seriesKey);
      if (!sk) continue;
      const d = decisionMap.get(sk);
      if (!d) continue;
      setItemAudiences(item, d.nextAudiences);
    }
  }

  // enriched shards 更新
  for (const shard of enrichShardJsons) {
    const items = Array.isArray(shard?.json?.items) ? shard.json.items : [];
    for (const item of items) {
      const sk = norm(item?.seriesKey);
      if (!sk) continue;
      const d = decisionMap.get(sk);
      if (!d) continue;

      if (!item.vol1 || typeof item.vol1 !== "object") continue;
      item.vol1.audiences = d.nextAudiences;
    }
  }

  // index stats に軽く記録
  const stamp = {
    updatedAt: nowIso(),
    mode: write ? "write" : "dry-run",
    totalWorksItems: report.totalWorksItems,
    changedSeries: report.changedSeries,
    unchangedSeries: report.unchangedSeries,
    keptNoMagazine: report.keptNoMagazine,
    keptNoMatch: report.keptNoMatch,
    unknownMagazines: report.unknownMagazines.length,
  };

  worksIndex.stats = {
    ...(worksIndex.stats || {}),
    audienceReassign: stamp,
  };

  enrichLoaded.idx.stats = {
    ...(enrichLoaded.idx.stats || {}),
    audienceReassign: stamp,
  };

  if (write) {
    await saveJson(WORKS_INDEX, worksIndex);

    for (const shard of worksShardJsons) {
      await saveJson(shard.path, shard.json);
    }

    await saveJson(ENRICH_INDEX, enrichLoaded.idx);
    for (const shard of enrichShardJsons) {
      await saveJson(shard.path, shard.json);
    }
  }

  await saveJson(OUT_REPORT, report);

  console.log(
    `[lane2:reassign_audiences_from_works] mode=${report.mode} total=${report.totalWorksItems} changed=${report.changedSeries} unchanged=${report.unchangedSeries} keep_no_magazine=${report.keptNoMagazine} keep_no_match=${report.keptNoMatch} unknownMagazines=${report.unknownMagazines.length}`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
