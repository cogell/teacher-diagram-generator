/**
 * The judge-calibration harness: re-judge an EXISTING run's stored PNGs — no
 * regeneration — K times with rubrics and K times without, and report verdict
 * stability. This isolates judge variance from generation variance: the same
 * pixels judged repeatedly should get the same verdict, and before rubrics
 * they measurably didn't (identical full runs differed by ±3 cases).
 *
 *   bun rejudge.ts                          # pinned reference run, K=3
 *   bun rejudge.ts runs/<id>                # another run
 *   K=2 bun rejudge.ts                      # fewer sweeps
 *
 * Results land in `<run>/rejudge-<timestamp>.json` (the run's real
 * ratings.json is never touched). The pinned reference run doubles as the
 * judge-drift calibration set: rerun this after any evaluator or model change
 * and compare flip counts.
 */
import { Effect } from "effect";
import { evaluateDiagram, type Evaluation } from "./evaluator";
import { loadRubrics } from "./rubrics";

const runDir = process.argv[2] ?? "runs/2026-07-03T16-59-20-891Z";
const K = Number(process.env.K ?? 3);

interface CaseRow {
  id: string;
  request: string;
  image: string | null;
}

const main = async () => {
  const manifest = JSON.parse(await Bun.file(`${runDir}/run.json`).text()) as { cases: CaseRow[] };
  const cases = manifest.cases.filter((c) => c.image !== null);
  const rubrics = await Effect.runPromise(loadRubrics());
  console.log(`${runDir} · ${cases.length} cases · K=${K} per condition · ${rubrics.size} rubrics on file`);

  // One judging job per case × condition × sweep, run with bounded concurrency.
  type Verdict = { passes: boolean; score: number; failed: string[] } | { error: string };
  const results: Record<string, { rubric: Verdict[]; holistic: Verdict[] }> = {};
  const jobs: (() => Promise<void>)[] = [];

  for (const c of cases) {
    results[c.id] = { rubric: [], holistic: [] };
    for (const condition of ["rubric", "holistic"] as const) {
      const rubric = condition === "rubric" ? rubrics.get(c.id) : undefined;
      if (condition === "rubric" && !rubric) continue; // no rubric: nothing to compare
      for (let k = 0; k < K; k++) {
        jobs.push(async () => {
          const png = new Uint8Array(await Bun.file(`${runDir}/${c.image}`).arrayBuffer());
          const res = await Effect.runPromise(
            Effect.result(evaluateDiagram({ request: c.request, png, rubric })),
          );
          const verdict: Verdict = res._tag === "Failure"
            ? { error: String(res.failure) }
            : {
              passes: res.success.evaluation.passes,
              score: res.success.evaluation.score,
              failed: (res.success.evaluation.checks ?? []).filter((ch) => !ch.ok).map((ch) => ch.item),
            };
          results[c.id]![condition].push(verdict);
          const tag = "error" in verdict ? "ERR" : verdict.passes ? "pass" : "FAIL";
          console.log(`${c.id}  ${condition.padEnd(8)} #${k + 1}  ${tag}`);
        });
      }
    }
  }

  // Bounded-concurrency runner (judge calls are the expensive part).
  const CONCURRENCY = 8;
  let next = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < jobs.length) await jobs[next++]!();
    }),
  );

  // Flip table: a case is stable when all K verdicts in a condition agree.
  const flips = { rubric: 0, holistic: 0 };
  console.log(`\ncase    rubric        holistic`);
  for (const c of cases) {
    const row = results[c.id]!;
    const fmt = (vs: Verdict[], condition: "rubric" | "holistic") => {
      if (vs.length === 0) return "—".padEnd(12);
      const tags = vs.map((v) => ("error" in v ? "E" : v.passes ? "P" : "F"));
      const stable = new Set(tags).size === 1;
      if (!stable) flips[condition]++;
      return `${tags.join("")}${stable ? "" : "  FLIP"}`.padEnd(12);
    };
    console.log(`${c.id}  ${fmt(row.rubric, "rubric")}  ${fmt(row.holistic, "holistic")}`);
    // Fact-level stability: any rubric item whose ok differs across sweeps is
    // a phrasing bug in rubrics.jsonl — the interpretable, fixable unit.
    const factRuns = row.rubric.filter((v): v is Exclude<Verdict, { error: string }> => !("error" in v));
    if (factRuns.length > 1) {
      const allFailed = new Set(factRuns.flatMap((v) => v.failed));
      for (const item of allFailed) {
        const times = factRuns.filter((v) => v.failed.includes(item)).length;
        if (times !== factRuns.length) {
          console.log(`        ↳ unstable fact (${times}/${factRuns.length} failed): ${item}`);
        }
      }
    }
  }
  console.log(`\nflipping cases — rubric: ${flips.rubric} · holistic: ${flips.holistic}`);

  const out = `${runDir}/rejudge-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  await Bun.write(out, JSON.stringify({ runDir, K, results }, null, 2));
  console.log(`wrote ${out}`);
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
