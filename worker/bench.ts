/**
 * The Workers-side benchmark runner — benchmark.ts's main loop, ported to run
 * inside `ctx.waitUntil` and write through the R2-backed Store instead of the
 * filesystem. The UI contract is unchanged: run.json / ratings.json are
 * re-flushed as cases land, and /api/bench/status serves the same shape the
 * local explorer's process-based controller does.
 *
 * The honest limitation of waitUntil (chosen deliberately for now, over a
 * Durable Object): the runtime only keeps processing waitUntil promises for
 * ~30 seconds after the response is sent. Small runs (the UI's default limit
 * of 6, or single-case reruns) fit; a full 30-case run will likely be cut off
 * mid-way. Because every case flushes to R2 as it completes, a cut-off run is
 * preserved as a valid partial — the same thing Ctrl-C leaves locally — and
 * the status endpoint reports a stalled bench as failed once its heartbeat
 * goes stale.
 */
import { Effect } from "effect";
import process from "node:process";
import { createDiagram, resolveRewriter } from "../generator";
import { evaluateDiagram } from "../evaluator";
import {
  generationCost,
  parseDataset,
  rollups,
  type BenchController,
  type Rating,
  type Store,
} from "../core";

const STATUS_KEY = "bench-status.json";
/** No status write for this long while not done = the isolate was evicted. */
const STALE_MS = 3 * 60 * 1000;
/** Cost lookups get a short retry tail here — waitUntil seconds are precious. */
const COST_RETRIES = 5;

interface PersistedStatus {
  startedAt: string;
  limit: number | null;
  total: number;
  log: string[];
  done: boolean;
  error: boolean;
  updatedAt: string;
}

interface Case {
  id: string;
  request: string;
  rewrittenRequest?: string;
  rewriteModel?: string;
  image: string | null;
  error: string | null;
  latencyMs: number;
  generationIds?: string[];
  attempts?: { error: string; draft: string | null }[];
  costUsd: number;
  via?: "spec" | "svg";
}

export const makeWorkerBench = (
  bucket: R2Bucket,
  store: Store,
  datasetText: () => Promise<string>,
  getCtx: () => ExecutionContext,
): BenchController => {
  const readStatus = async (): Promise<PersistedStatus | null> => {
    const o = await bucket.get(STATUS_KEY);
    if (!o) return null;
    try {
      return JSON.parse(await o.text()) as PersistedStatus;
    } catch {
      return null;
    }
  };
  const isFresh = (s: PersistedStatus) => Date.now() - Date.parse(s.updatedAt) < STALE_MS;

  const run = async (
    dataset: { id: string; request: string }[],
    hypothesis: string,
    rewrite: "haiku" | "sonnet" | null,
    status: PersistedStatus,
  ) => {
    // REWRITE is set or REMOVED explicitly, mirroring the local explorer's
    // child-process env handling. (Isolate-wide, so a concurrent single-case
    // rerun would see this run's setting — acceptable for a one-user tool.)
    if (rewrite) process.env.REWRITE = rewrite;
    else delete process.env.REWRITE;

    const startedAt = new Date();
    const runId = startedAt.toISOString().replace(/[:.]/g, "-");
    const createdAt = startedAt.toISOString();
    const cases: Case[] = [];
    const ratings: Record<string, Rating> = {};

    // Serialize the shared-JSON flushes: concurrent cases each rewrite whole
    // snapshots, and two R2 puts racing could land an older snapshot last.
    let chain: Promise<void> = Promise.resolve();
    const enqueue = (fn: () => Promise<void>) => {
      chain = chain.then(fn, fn).catch(() => {});
      return chain;
    };
    const flushManifest = () =>
      enqueue(() => {
        cases.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
        return store.write(
          runId,
          "run.json",
          JSON.stringify(
            { runId, createdAt, rewrite: resolveRewriter()?.key ?? false, ...rollups(cases), cases },
            null,
            2,
          ),
        );
      });
    const flushRatings = () =>
      enqueue(() => store.write(runId, "ratings.json", JSON.stringify(ratings, null, 2)));
    const flushStatus = () =>
      enqueue(async () => {
        status.updatedAt = new Date().toISOString();
        await bucket.put(STATUS_KEY, JSON.stringify(status));
      });
    const log = (line: string) => {
      status.log.push(line);
      if (status.log.length > 200) status.log.shift();
      return flushStatus();
    };

    await flushManifest(); // register the (empty) run right away
    await store.write(
      runId,
      "journal.json",
      JSON.stringify(
        { entries: [{ id: "run", kind: "run", hypothesis, conclusion: null, at: createdAt }] },
        null,
        2,
      ),
    );
    await log(`run ${runId} — ${dataset.length} case(s), all concurrent`);

    const costOf = async (ids: string[] | undefined) => {
      const costs = await Promise.all(
        (ids ?? []).map((id) => Effect.runPromise(generationCost(id, COST_RETRIES))),
      );
      return costs.reduce((a, b) => a + b, 0);
    };

    await Promise.all(dataset.map(async (c) => {
      const t0 = Date.now();
      const gen = await Effect.runPromise(Effect.result(createDiagram(c.request)));
      const latencyMs = Date.now() - t0;

      if (gen._tag === "Failure") {
        const f = gen.failure;
        const attempts: NonNullable<Case["attempts"]> = [];
        for (const [i, a] of f.attempts.entries()) {
          let draft: string | null = null;
          if (a.draft !== null) {
            draft = `${c.id}.attempt-${i + 1}.txt`;
            await store.write(runId, draft, a.draft);
          }
          attempts.push({ error: a.error, draft });
        }
        const kase: Case = {
          id: c.id,
          request: c.request,
          image: null,
          error: String(f.cause),
          latencyMs,
          generationIds: [...f.generationIds],
          attempts,
          costUsd: 0,
        };
        cases.push(kase);
        await log(`${c.id}  error  ↳ ${String(f.cause)} after ${f.attempts.length} attempt(s)`);
        await flushManifest();
        kase.costUsd = await costOf(kase.generationIds);
        await flushManifest();
        return;
      }

      const d = gen.success;
      await store.write(runId, `${c.id}.png`, d.png);
      await store.write(runId, `${c.id}.svg`, d.svg);
      if (d.spec) await store.write(runId, `${c.id}.spec.json`, JSON.stringify(d.spec, null, 2));
      const kase: Case = {
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
      };
      cases.push(kase);
      // Mark the eval as in-flight in ratings.json before it starts, so the
      // explorer shows an "evaluating…" badge from data.
      ratings[c.id] = { evaluating: true, updatedAt: new Date().toISOString() };
      await log(`${c.id}  ${(latencyMs / 1000).toFixed(1)}s  ${c.request.slice(0, 80)}`);
      await Promise.all([flushRatings(), flushManifest()]);

      // Judge and cost lookup run concurrently — neither blocks the other.
      await Promise.all([
        (async () => {
          const res = await Effect.runPromise(
            Effect.result(evaluateDiagram({ request: c.request, png: d.png })),
          );
          if (res._tag === "Failure") {
            delete ratings[c.id]; // clear the in-flight placeholder
            await log(`${c.id}  eval error  ↳ ${String(res.failure)}`);
          } else {
            const { evaluation, generationId } = res.success;
            ratings[c.id] = {
              passes: evaluation.passes,
              score: evaluation.score,
              note: evaluation.critique,
              evaluation,
              generationId,
              updatedAt: new Date().toISOString(),
            };
            await log(`${c.id}  eval  ${evaluation.passes ? "pass ✓" : "FAIL"} · score ${evaluation.score}`);
          }
          await flushRatings();
        })(),
        (async () => {
          kase.costUsd = await costOf(kase.generationIds);
          await flushManifest();
        })(),
      ]);
    }));

    const passed = Object.values(ratings).filter((r) => r.passes === true).length;
    status.done = true;
    await log(`done — runs/${runId} · ${cases.length} cases · ${passed}/${Object.keys(ratings).length} passed eval`);
  };

  return {
    async status() {
      const s = await readStatus();
      const fresh = s !== null && isFresh(s);
      const total = s?.total ?? parseDataset(await datasetText()).length;
      const log = s?.log.slice(-15) ?? [];
      if (s && !s.done && !fresh) {
        log.push("(bench stalled — the Worker was likely evicted past its waitUntil window; the partial run is preserved)");
      }
      return {
        running: !!(s && !s.done && fresh),
        limit: s?.limit ?? null,
        total,
        startedAt: s?.startedAt ?? null,
        exitCode: s === null ? null : s.done ? (s.error ? 1 : 0) : fresh ? null : 1,
        log,
      };
    },
    async start(limit, hypothesis, rewrite) {
      const s = await readStatus();
      if (s && !s.done && isFresh(s)) {
        return Response.json({ error: "a benchmark is already running" }, { status: 409 });
      }
      const dataset = parseDataset(await datasetText()).slice(0, limit ?? undefined);
      const status: PersistedStatus = {
        startedAt: new Date().toISOString(),
        limit,
        total: dataset.length,
        log: [],
        done: false,
        error: false,
        updatedAt: new Date().toISOString(),
      };
      await bucket.put(STATUS_KEY, JSON.stringify(status));
      getCtx().waitUntil(
        run(dataset, hypothesis, rewrite, status).catch(async (e) => {
          status.done = true;
          status.error = true;
          status.log.push(`bench crashed: ${String(e)}`);
          status.updatedAt = new Date().toISOString();
          await bucket.put(STATUS_KEY, JSON.stringify(status)).catch(() => {});
        }),
      );
      return Response.json({ started: true, limit });
    },
  };
};
