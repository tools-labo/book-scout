// scripts/lane2/run.mjs
import { spawn } from "node:child_process";

function run(cmd, args = [], env = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, {
      stdio: "inherit",
      shell: false,
      env: { ...process.env, ...env },
    });
    p.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(" ")} exited with ${code}`));
    });
  });
}

async function main() {
  const step = (process.argv[2] || "all").toLowerCase();

  if (step === "seed") {
    await run("node", ["scripts/lane2/gen_seeds_from_anilist.mjs"]);
    return;
  }

  if (step === "enrich") {
    await run("node", ["scripts/lane2/enrich_lane2.mjs"]);
    await run("node", ["scripts/lane2/format_lane2.mjs"]);
    return;
  }

  if (step === "format") {
    await run("node", ["scripts/lane2/format_lane2.mjs"]);
    return;
  }

  // all: seed→enrich→format
  if (step === "all") {
    await run("node", ["scripts/lane2/gen_seeds_from_anilist.mjs"]);
    await run("node", ["scripts/lane2/enrich_lane2.mjs"]);
    await run("node", ["scripts/lane2/format_lane2.mjs"]);
    return;
  }

  throw new Error(`Unknown step: ${step} (use: seed | enrich | format | all)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
