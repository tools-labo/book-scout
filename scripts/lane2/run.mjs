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

async function main() {
  // 何件 seeds を作るか（デフォ 100）
  const limit = String(process.env.LANE2_SEED_LIMIT || "100");

  // 0) AniList → seeds.json を生成（100件）
  // ※ gen_seeds_from_anilist.mjs 側が LANE2_SEED_LIMIT を見てる前提
  await run("node", ["scripts/lane2/gen_seeds_from_anilist.mjs"], { LANE2_SEED_LIMIT: limit });

  // 1) seeds → series（1巻確定）
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
