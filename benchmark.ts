/**
 * The benchmark harness — reads `dataset.jsonl`, runs the generator over every
 * case, measures latency, looks up real cost, and writes the whole run to a
 * timestamped directory under `runs/`:
 *
 *   runs/<timestamp>/
 *     <case>.png          the generated diagram (a raster)
 *     run.json            per-case request / latency / cost + run metadata
 *
 * There are no pass/fail verdicts — deciding what's correct is for you. Browse
 * runs with `bun run explore`. You shouldn't need to edit this; the work lives
 * in `generator.ts`.
 *
 *   bun run bench           # all cases
 *   LIMIT=3 bun run bench   # just the first few while iterating
 */
import { Clock, Config, Effect, Redacted, Schedule, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import { createDiagram } from "./generator";

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
  image: string | null;
  error: string | null;
  latencyMs: number;
  generationId?: string;
  costUsd: number;
}

const main = Effect.gen(function*() {
  const clock = yield* Clock.Clock;
  const startedAt = new Date();
  const runId = startedAt.toISOString().replace(/[:.]/g, "-");
  const createdAt = startedAt.toISOString();
  const runDir = new URL(`./runs/${runId}/`, import.meta.url);
  const write = (name: string, data: string | Uint8Array) =>
    Effect.promise(() => Bun.write(new URL(name, runDir), data));

  const cases: Case[] = [];
  // Rewrite the manifest after every case so the run fills in incrementally —
  // `bun run explore` can watch it (reload to refresh), and a Ctrl-C mid-run
  // still leaves a valid partial run instead of nothing.
  const writeManifest = () => {
    const lat = cases.map((c) => c.latencyMs).filter((n) => n > 0).sort((a, b) => a - b);
    const p50 = lat[Math.floor(lat.length / 2)] ?? 0;
    const totalCost = cases.reduce((s, c) => s + c.costUsd, 0);
    return write(
      "run.json",
      JSON.stringify({ runId, createdAt, p50LatencyMs: p50, totalCostUsd: totalCost, cases }, null, 2),
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

  for (const c of dataset) {
    const t0 = yield* clock.currentTimeMillis;
    const gen = yield* Effect.result(createDiagram(c.request));
    const latencyMs = (yield* clock.currentTimeMillis) - t0;
    if (gen._tag === "Failure") {
      cases.push({ id: c.id, request: c.request, image: null, error: String(gen.failure), latencyMs, costUsd: 0 });
      console.log(`${c.id}  error  ${c.request}`);
      console.log(`        ↳ ${String(gen.failure)}`);
    } else {
      const d = gen.success;
      yield* write(`${c.id}.png`, d.png);
      cases.push({
        id: c.id,
        request: c.request,
        image: `${c.id}.png`,
        error: null,
        latencyMs,
        generationId: d.generationId,
        costUsd: 0,
      });
      console.log(`${c.id}  ${(latencyMs / 1000).toFixed(1)}s  ${c.request}`);
    }
    yield* writeManifest(); // flush after each case
  }

  // Post-factor cost: look up each generation's real spend, concurrently. The
  // most recent ones may still be indexing, so `generationCost` retries.
  console.log("\nlooking up costs…");
  yield* Effect.forEach(
    cases,
    (c) =>
      c.generationId
        ? generationCost(c.generationId).pipe(Effect.map((cost) => ((c.costUsd = cost), undefined)))
        : Effect.void,
    { concurrency: 8, discard: true },
  );
  yield* writeManifest(); // final flush, now with costs filled in

  const lat = cases.map((c) => c.latencyMs).filter((n) => n > 0).sort((a, b) => a - b);
  const p50 = lat[Math.floor(lat.length / 2)] ?? 0;
  const totalCost = cases.reduce((s, c) => s + c.costUsd, 0);
  console.log(
    `\nwrote runs/${runId} · ${cases.length} cases · p50 ${(p50 / 1000).toFixed(1)}s · $${totalCost.toFixed(4)} · browse with \`bun run explore\``,
  );
});

Effect.runPromise(main).catch((e) => {
  console.error(e);
  process.exit(1);
});
