// scripts/lane2/run.mjs
import { spawn } from "node:child_process";

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: "inherit" });
    p.on("error", reject);
    p.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(" ")} exited with code ${code}`));
    });
  });
}

async function main() {
  await run("node", ["scripts/lane2/build_lane2.mjs"]);
  await run("node", ["scripts/lane2/enrich_lane2.mjs"]);
  await run("node", ["scripts/lane2/format_lane2.mjs"]);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
