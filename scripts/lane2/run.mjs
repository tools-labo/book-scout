// scripts/lane2/run.mjs
import { spawn } from "node:child_process";

function run(cmd, args, env = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, {
      stdio: "inherit",
      env: { ...process.env, ...env },
    });
    p.on("error", reject);
    p.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(" ")} exited with code ${code}`));
    });
  });
}

function isTrue(v) {
  return /^(1|true|yes|on)$/i.test(String(v ?? "").trim());
}

async function main() {
  const fixMode = isTrue(process.env.LANE2_FIX_MODE);

  if (fixMode) {
    console.log("[lane2] FIX MODE: skip seedgen/build. run enrich+format only.");

    // FIXモードは「データ増やさない」が最優先
    // - seedgen しない（seeds.json を増やさない）
    // - build もしない（pending seed があると series/review/todo が増える可能性があるため）
    // 既存 series/enriched の修正をフロントに反映するだけ
    await run("node", ["scripts/lane2/enrich_lane2.mjs"]);
    await run("node", ["scripts/lane2/format_lane2.mjs"]);
    return;
  }

  // ---- Normal mode ----
  // 0) AniList → seeds.json を「追加で積み上げ」
  const seedAdd = String(process.env.LANE2_SEED_ADD || process.env.LANE2_SEED_LIMIT || "100");
  const seedMaxPages = String(process.env.LANE2_SEED_MAX_PAGES || "20");

  await run("node", ["scripts/lane2/gen_seeds_from_anilist.mjs"], {
    LANE2_SEED_ADD: seedAdd,
    LANE2_SEED_MAX_PAGES: seedMaxPages,
  });

  // 1) seeds → series（1巻確定・積み上げ）
  await run("node", ["scripts/lane2/build_lane2.mjs"]);

  // 2) series → enriched（override/todo含む）
  await run("node", ["scripts/lane2/enrich_lane2.mjs"]);

  // 3) enriched → works（フロント用）
  await run("node", ["scripts/lane2/format_lane2.mjs"]);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
