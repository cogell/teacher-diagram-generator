/**
 * Copy the local runs/ directory into the deployed Worker's R2 bucket through
 * its Bearer-authenticated upload route:
 *
 *   bun scripts/seed-runs.ts https://<worker-host>            # password from .dev.vars
 *   SITE_PASSWORD=... bun scripts/seed-runs.ts http://localhost:8787
 *
 * Idempotent — re-running just overwrites the same keys.
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const origin = process.argv[2]?.replace(/\/$/, "");
if (!origin) {
  console.error("usage: bun scripts/seed-runs.ts <origin> (e.g. https://coteach-diagram-explorer.<acct>.workers.dev)");
  process.exit(1);
}

const rootDir = fileURLToPath(new URL("../", import.meta.url));

const password = process.env.SITE_PASSWORD ??
  (await Bun.file(join(rootDir, ".dev.vars")).text().catch(() => ""))
    .split("\n")
    .find((l) => l.startsWith("SITE_PASSWORD="))
    ?.slice("SITE_PASSWORD=".length)
    .trim();
if (!password) {
  console.error("no SITE_PASSWORD in env or .dev.vars");
  process.exit(1);
}

const runsDir = join(rootDir, "runs");
const runIds = (await readdir(runsDir)).filter((d) => /^\d{4}/.test(d)).sort();

const jobs: { runId: string; file: string }[] = [];
for (const runId of runIds) {
  for (const file of await readdir(join(runsDir, runId))) {
    if (file.endsWith(".tmp")) continue; // benchmark write-temp leftovers
    jobs.push({ runId, file });
  }
}
console.log(`${runIds.length} runs, ${jobs.length} files → ${origin}`);

let done = 0;
let failed = 0;
const CONCURRENCY = 12;
const queue = [...jobs];
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  for (let job = queue.shift(); job; job = queue.shift()) {
    const { runId, file } = job;
    const body = await Bun.file(join(runsDir, runId, file)).arrayBuffer();
    const res = await fetch(
      `${origin}/api/blob/runs/${encodeURIComponent(runId)}/${encodeURIComponent(file)}`,
      { method: "PUT", headers: { authorization: `Bearer ${password}` }, body },
    ).catch((e) => ({ ok: false, status: 0, statusText: String(e) } as const));
    if (!res.ok) {
      failed++;
      console.error(`FAIL ${runId}/${file} — ${res.status} ${"statusText" in res ? res.statusText : ""}`);
    }
    done++;
    if (done % 100 === 0) console.log(`  ${done}/${jobs.length}…`);
  }
}));
console.log(`uploaded ${done - failed}/${jobs.length}${failed ? ` (${failed} FAILED)` : ""}`);
process.exit(failed ? 1 : 0);
