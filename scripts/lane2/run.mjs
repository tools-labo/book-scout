// scripts/lane2/run.mjs
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function run() {
  // 逐次実行：build -> enrich
  await execFileAsync(process.execPath, ["scripts/lane2/build_lane2.mjs"], {
    stdio: "inherit",
  });

  await execFileAsync(process.execPath, ["scripts/lane2/enrich_lane2.mjs"], {
    stdio: "inherit",
  });
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
