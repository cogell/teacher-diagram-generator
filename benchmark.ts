/**
 * The benchmark harness — reads `dataset.jsonl`, runs the generator over every
 * case, measures latency, looks up real cost, and writes the whole run to a
 * timestamped directory under `runs/`:
 *
 *   runs/<timestamp>/
 *     <case>.png          the generated diagram (a raster)
 *     run.json            per-case request / latency / cost + run metadata
 *     ratings.json        the AI judge's verdict per case (pass/fail + score)
 *
 * As each case's PNG lands, the evaluator is fired in the background — cases
 * keep generating while earlier ones are being judged, so evaluation adds no
 * per-case latency. Browse runs with `bun run explore`.
 *
 *   bun run bench           # all cases
 *   LIMIT=3 bun run bench   # just the first few while iterating
 */
import { rename } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Clock, Config, Effect, Fiber, Redacted, Schedule, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import { createDiagram, GENERATOR_MODEL_ID, resolveRewriter } from "./generator";
import { evaluateDiagram, type Evaluation } from "./evaluator";

// The slice of OpenRouter's `/generation` response we care about.
const GenerationRecord = Schema.Struct({
  data: Schema.Struct({ total_cost: Schema.Number }),
});

// Real USD cost for a generation, from OpenRouter's `/generation` endpoint.
// The completion response doesn't carry cost, and the record is indexed a few
// seconds after the call — so we look it up (with backoff) after the run.
const generationCost = (id: string) =>
  Effect.gen(function*() {
    const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
    const key = yield* Config.redacted("OPENROUTER_API_KEY");
    const res = yield* client.get(
      `https://openrouter.ai/api/v1/generation?id=${id}`,
      { headers: { authorization: `Bearer ${Redacted.value(key)}` } },
    );
    const record = yield* Schema.decodeUnknownEffect(GenerationRecord)(yield* res.json);
    return record.data.total_cost;
  }).pipe(
    // A just-finished generation isn't indexed yet (404) — retry with backoff.
    Effect.retry({ times: 12, schedule: Schedule.spaced("2 seconds") }),
    Effect.orElseSucceed(() => 0),
    Effect.provide(FetchHttpClient.layer),
  );

interface Case {
  id: string;
  request: string;
  /** The drawing brief the generator actually drew from, when the run had a
   *  REWRITE pre-pass — persisted for diagnosis; the evaluator still judges
   *  against the original `request`. `rewriteModel` names the pre-pass model. */
  rewrittenRequest?: string;
  rewriteModel?: string;
  image: string | null;
  error: string | null;
  latencyMs: number;
  generationIds?: string[];
  /** Failure history, one entry per failed attempt: what went wrong, and the
   *  filename of the persisted raw model reply (null when the attempt died
   *  before a draft came back, e.g. a provider error). */
  attempts?: { error: string; draft: string | null }[];
  costUsd: number;
  /** Which generator path produced the image: a layer-4 template spec, or raw
   *  model-drawn SVG. Per-path pass rates fall out of run.json for free. */
  via?: "spec" | "svg";
}

// What lands in ratings.json — the same shape the explorer reads and writes
// (its manual "evaluate" button), so both paths stay interchangeable.
interface Rating {
  /** True while the judge is still working on this case — an in-flight
   *  placeholder the explorer renders as an "evaluating…" badge. */
  evaluating?: boolean;
  passes?: boolean;
  score?: number;
  note?: string;
  evaluation?: Evaluation;
  generationId?: string;
  updatedAt: string;
}

const main = Effect.gen(function*() {
  const clock = yield* Clock.Clock;
  const startedAt = new Date();
  const runId = startedAt.toISOString().replace(/[:.]/g, "-");
  const createdAt = startedAt.toISOString();
  const runDir = new URL(`./runs/${runId}/`, import.meta.url);
  // Atomic write: a unique temp file renamed over the target. The explorer
  // polls run.json every 2.5s while concurrent case fibers flush it — a plain
  // in-place write let readers catch a torn half-file (which once killed the
  // UI's poll loop). Unique temp names keep concurrent flushes from
  // interleaving too: each rename lands a complete manifest, last one wins.
  const write = (name: string, data: string | Uint8Array) =>
    Effect.promise(async () => {
      const tmp = new URL(`${name}.${Math.random().toString(36).slice(2)}.tmp`, runDir);
      await Bun.write(tmp, data);
      await rename(fileURLToPath(tmp), fileURLToPath(new URL(name, runDir)));
    });

  const cases: Case[] = [];
  // Rewrite the manifest after every case so the run fills in incrementally —
  // `bun run explore` can watch it (reload to refresh), and a Ctrl-C mid-run
  // still leaves a valid partial run instead of nothing.
  const writeManifest = () => {
    // Concurrent generation lands cases in completion order — sort by id
    // (d-01, d-02, … `numeric` keeps d-2 before d-10) before every write so the
    // manifest always reads top-to-bottom by case, including the incremental
    // flushes the explorer watches live.
    cases.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
    const lat = cases.map((c) => c.latencyMs).filter((n) => n > 0).sort((a, b) => a - b);
    const p50 = lat[Math.floor(lat.length / 2)] ?? 0;
    const totalCost = cases.reduce((s, c) => s + c.costUsd, 0);
    return write(
      "run.json",
      JSON.stringify(
        // `rewrite` records which drawing-brief pre-pass this run used
        // ("haiku" | "sonnet" | false), so A/B rows are tellable apart in the
        // history view.
        // `model` records which drawing model the sweep ran (GENERATOR_MODEL).
        { runId, createdAt, model: GENERATOR_MODEL_ID, rewrite: resolveRewriter()?.key ?? false, p50LatencyMs: p50, totalCostUsd: totalCost, cases },
        null,
        2,
      ),
    );
  };

  const text = yield* Effect.promise(() =>
    Bun.file(new URL("./dataset.jsonl", import.meta.url)).text(),
  );
  let dataset = text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { id: string; request: string });
  if (process.env.LIMIT) dataset = dataset.slice(0, Number(process.env.LIMIT));

  yield* writeManifest(); // register the (empty) run right away

  // The experiment journal: one hypothesis (set before the run, passed in via
  // the explorer's HYPOTHESIS env var) and a finding written afterward. Kept in
  // its own file so the per-case manifest rewrites above never clobber it. The
  // finding is filled in later from the explorer; here we just seed the entry.
  yield* write(
    "journal.json",
    JSON.stringify(
      {
        entries: [
          {
            id: "run",
            kind: "run",
            hypothesis: process.env.HYPOTHESIS ?? "",
            conclusion: null,
            at: createdAt,
          },
        ],
      },
      null,
      2,
    ),
  );

  // Auto-eval: as soon as a case has a PNG, fork the AI judge on it. The forks
  // run concurrently with the remaining cases (and each other) — evaluation
  // never blocks generation and adds nothing to per-case latency. Each verdict
  // is flushed into ratings.json as it lands so the explorer shows pass/fail
  // live; the fibers are joined at the end so the process doesn't exit early.
  const ratings: Record<string, Rating> = {};
  const writeRatings = () => write("ratings.json", JSON.stringify(ratings, null, 2));
  const evalFibers: Fiber.Fiber<void, never>[] = [];

  // forkDetach, not forkChild: with concurrent generation each case runs in
  // its own short-lived forEach fiber, and a child fork is interrupted the
  // moment that parent completes — which killed every eval. Detached fibers
  // outlive their parent; the explicit Fiber.joinAll below is what awaits them.
  const evalInBackground = (c: { id: string; request: string }, png: Uint8Array) =>
    Effect.forkDetach(
      Effect.gen(function*() {
        const res = yield* Effect.result(evaluateDiagram({ request: c.request, png }));
        if (res._tag === "Failure") {
          console.log(`${c.id}  eval error  ↳ ${String(res.failure)}`);
          delete ratings[c.id]; // clear the in-flight placeholder
          yield* writeRatings();
          return;
        }
        const { evaluation, generationId } = res.success;
        ratings[c.id] = {
          passes: evaluation.passes,
          score: evaluation.score,
          note: evaluation.critique,
          evaluation,
          generationId,
          updatedAt: new Date().toISOString(),
        };
        console.log(`${c.id}  eval  ${evaluation.passes ? "pass ✓" : "FAIL"} · score ${evaluation.score}`);
        yield* writeRatings();
      }),
    );

  // Generate every case concurrently — each diagram is an independent model
  // call, so they all fly at once instead of one-at-a-time. `CONCURRENCY` caps
  // the fan-out (default unbounded: build them all at once); set it if you hit
  // OpenRouter rate limits. Latency is measured inside each fiber, so parallel
  // execution doesn't inflate it. The manifest is flushed as each case lands.
  const concurrency: number | "unbounded" =
    process.env.CONCURRENCY ? Number(process.env.CONCURRENCY) : "unbounded";
  yield* Effect.forEach(
    dataset,
    (c) =>
      Effect.gen(function*() {
        const t0 = yield* clock.currentTimeMillis;
        const gen = yield* Effect.result(createDiagram(c.request));
        const latencyMs = (yield* clock.currentTimeMillis) - t0;
        if (gen._tag === "Failure") {
          // `DiagramFailed` carries the whole retry history: persist each
          // failed attempt's raw model reply next to the run artifacts (the
          // same diagnosability the .svg gives successes), and keep the
          // generation ids so the cost lookup below counts the paid calls.
          const f = gen.failure;
          const attempts: NonNullable<Case["attempts"]> = [];
          for (const [i, a] of f.attempts.entries()) {
            let draft: string | null = null;
            if (a.draft !== null) {
              draft = `${c.id}.attempt-${i + 1}.txt`;
              yield* write(draft, a.draft);
            }
            attempts.push({ error: a.error, draft });
          }
          cases.push({
            id: c.id,
            request: c.request,
            image: null,
            error: String(f.cause),
            latencyMs,
            generationIds: [...f.generationIds],
            attempts,
            costUsd: 0,
          });
          console.log(`${c.id}  error  ${c.request}`);
          console.log(`        ↳ ${String(f.cause)} after ${f.attempts.length} attempt(s)`);
        } else {
          const d = gen.success;
          yield* write(`${c.id}.png`, d.png);
          // The SVG that went into the renderer (pre-prepareSvg) — the model's
          // raw output on the svg path, the template render on the spec path —
          // so regressions are diagnosable from source instead of pixels. The
          // spec is the model's actual output on that path, so it lands too.
          yield* write(`${c.id}.svg`, d.svg);
          if (d.spec) yield* write(`${c.id}.spec.json`, JSON.stringify(d.spec, null, 2));
          cases.push({
            id: c.id,
            request: c.request,
            ...(d.rewrittenRequest
              ? { rewrittenRequest: d.rewrittenRequest, rewriteModel: d.rewriteModel ?? undefined }
              : {}),
            image: `${c.id}.png`,
            error: null,
            latencyMs,
            generationIds: d.generationIds,
            costUsd: 0,
            via: d.spec ? "spec" : "svg",
          });
          console.log(`${c.id}  ${(latencyMs / 1000).toFixed(1)}s  ${c.request}`);
          // Mark the eval as in-flight in ratings.json before forking, so any
          // explorer tab shows an "evaluating…" badge from data — no matter
          // whether the bench was launched from the UI or the terminal.
          ratings[c.id] = { evaluating: true, updatedAt: new Date().toISOString() };
          yield* writeRatings();
          evalFibers.push(yield* evalInBackground(c, d.png));
        }
        yield* writeManifest(); // flush as each case lands
      }),
    { concurrency, discard: true },
  );

  // Wait for the background evaluations before finishing up — their verdicts
  // land in ratings.json, not the manifest, so cost lookup below can overlap
  // nothing.
  if (evalFibers.length) {
    console.log("\nwaiting for evaluations…");
    yield* Fiber.joinAll(evalFibers);
  }

  // Post-factor cost: look up each generation's real spend, concurrently. A
  // case may span several generations — its cost is the sum. The most recent
  // ones may still be indexing, so `generationCost` retries.
  console.log("looking up costs…");
  yield* Effect.forEach(
    cases,
    (c) =>
      c.generationIds?.length
        ? Effect.forEach(c.generationIds, generationCost, { concurrency: 3 }).pipe(
            Effect.map((costs) => ((c.costUsd = costs.reduce((a, b) => a + b, 0)), undefined)),
          )
        : Effect.void,
    { concurrency: 8, discard: true },
  );
  yield* writeManifest(); // final flush, now with costs filled in

  const lat = cases.map((c) => c.latencyMs).filter((n) => n > 0).sort((a, b) => a - b);
  const p50 = lat[Math.floor(lat.length / 2)] ?? 0;
  const totalCost = cases.reduce((s, c) => s + c.costUsd, 0);
  const passed = Object.values(ratings).filter((r) => r.passes === true).length;
  console.log(
    `\nwrote runs/${runId} · ${cases.length} cases · ${passed}/${Object.keys(ratings).length} passed eval · p50 ${(p50 / 1000).toFixed(1)}s · $${totalCost.toFixed(4)} · browse with \`bun run explore\``,
  );
});

Effect.runPromise(main).catch((e) => {
  console.error(e);
  process.exit(1);
});
