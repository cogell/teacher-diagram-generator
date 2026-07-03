/**
 * The explorer's storage-agnostic core: every route and every piece of
 * run/notes/ratings/journal logic, written against a tiny `Store` interface
 * instead of the filesystem. Two deployments share it:
 *
 *   explore.ts       Bun server, Store = files under runs/ (local dev)
 *   worker/index.ts  Cloudflare Worker, Store = an R2 bucket (deployed)
 *
 * Benchmark execution is the one thing that genuinely differs per platform
 * (a spawned child process locally, a waitUntil task on Workers), so it comes
 * in as the `BenchController` dependency rather than living here.
 */
import { Config, Effect, Redacted, Schedule, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import { evaluateDiagram, type Evaluation } from "./evaluator";
import { createDiagram } from "./generator";
import { HISTORY_HTML, HTML } from "./ui";

// ---- storage ----------------------------------------------------------------
// One run = one directory (locally) or one key prefix (R2). Files within a run
// are flat — the explorer never nests. All runId/file validation happens here
// in core, so Store implementations can trust their inputs.
export interface Store {
  /** Every run id present in storage, unfiltered and in no particular order. */
  listRunIds(): Promise<string[]>;
  readText(runId: string, file: string): Promise<string | null>;
  readBytes(runId: string, file: string): Promise<Uint8Array | null>;
  write(runId: string, file: string, data: string | Uint8Array): Promise<void>;
  remove(runId: string, file: string): Promise<void>;
  exists(runId: string, file: string): Promise<boolean>;
  /** Raw file response for GET /runs/<runId>/<file> (images, manifests). */
  serve(runId: string, file: string): Promise<Response>;
}

export interface BenchController {
  /** Shape the UI polls: { running, limit, total, startedAt, exitCode, log }. */
  status(): Promise<unknown>;
  /** Kick off a run (or refuse with a 409 if one is already going). */
  start(
    limit: number | null,
    hypothesis: string,
    rewrite: "haiku" | "sonnet" | null,
  ): Promise<Response>;
}

// Run ids are timestamps (2026-07-03T14-16-58-561Z) and files are flat names
// (d-01.png, run.json, .archived) — one conservative pattern covers both and
// shuts the door on traversal regardless of what a Store does with the string.
const SAFE_SEGMENT = /^\.?[A-Za-z0-9][A-Za-z0-9_.-]*$/;
export const safeSegment = (s: string) => SAFE_SEGMENT.test(s) && !s.includes("..");

export const parseDataset = (text: string) =>
  text.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { id: string; request: string });

// ---- ratings / notes / journal shapes ----------------------------------------
export interface Rating {
  /** True while the benchmark's judge is still working on this case — an
   *  in-flight placeholder written by the bench, replaced by the verdict. */
  evaluating?: boolean;
  passes?: boolean;
  /** True when a human set/flipped `passes` by hand, rather than the AI judge. */
  human?: boolean;
  score?: number;
  /** True when a human set `score` by hand — the judge's original number stays
   *  available in `evaluation.score`. */
  scoreHuman?: boolean;
  note?: string;
  evaluation?: Evaluation;
  generationId?: string;
  updatedAt: string;
}

export interface JournalEntry {
  id: string;
  kind: "run" | "rerun";
  caseId?: string;
  hypothesis: string;
  conclusion: string | null;
  at: string;
}

// ---- cost lookup --------------------------------------------------------------
// The slice of OpenRouter's `/generation` response we care about.
const GenerationRecord = Schema.Struct({
  data: Schema.Struct({ total_cost: Schema.Number }),
});

// Real USD cost for a generation, looked up (with backoff, since a just-finished
// generation isn't indexed for a few seconds) from OpenRouter. `retries` is
// tunable because the Worker bench runs inside a waitUntil window where a long
// retry tail can cost the run its remaining lifetime.
export const generationCost = (id: string, retries = 12) =>
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
    Effect.retry({ times: retries, schedule: Schedule.spaced("2 seconds") }),
    Effect.orElseSucceed(() => 0),
    Effect.provide(FetchHttpClient.layer),
  );

// Recompute the run-level rollups (p50 latency, total cost) from its cases,
// matching the benchmark's writeManifest so a rerun keeps the manifest honest.
export const rollups = (cases: { latencyMs: number; costUsd: number }[]) => {
  const lat = cases.map((c) => c.latencyMs).filter((n) => n > 0).sort((a, b) => a - b);
  return {
    p50LatencyMs: lat[Math.floor(lat.length / 2)] ?? 0,
    totalCostUsd: cases.reduce((s, c) => s + c.costUsd, 0),
  };
};

// Mean of the numeric scores in a run's ratings, or null if nothing is rated.
const qualityOf = (ratings: Record<string, { score?: number }>) => {
  const scores = Object.values(ratings)
    .map((r) => r.score)
    .filter((s): s is number => typeof s === "number" && Number.isFinite(s));
  if (!scores.length) return { avg: null as number | null, rated: 0 };
  return { avg: scores.reduce((a, b) => a + b, 0) / scores.length, rated: scores.length };
};

// Tally how the critique→revise round landed across a run's cases. Cases from
// before the refinement loop existed have no `refinement` and don't count.
const refineTally = (cases: { refinement?: { outcome?: string } }[]) => {
  const t = { passed: 0, revised: 0, failed: 0 };
  for (const c of cases) {
    const o = c.refinement?.outcome;
    if (o === "passed" || o === "revised" || o === "failed") t[o]++;
  }
  return t;
};

// ---- the explorer -------------------------------------------------------------
export const makeExplorer = (
  store: Store,
  opts: { datasetText: () => Promise<string>; bench: BenchController },
) => {
  const readJson = async <T>(runId: string, file: string, fallback: T): Promise<T> => {
    const text = await store.readText(runId, file);
    if (text === null) return fallback;
    try {
      return JSON.parse(text) as T;
    } catch {
      return fallback;
    }
  };

  const runIds = async () =>
    (await store.listRunIds()).filter((d) => /^\d{4}/.test(d) && safeSegment(d)).sort();

  // ---- archiving: a `.archived` marker file is the whole state ----------------
  const isArchived = (runId: string) => store.exists(runId, ".archived");
  const setArchived = async (runId: string, archived: boolean) => {
    if (!safeSegment(runId)) return false;
    if (archived) await store.write(runId, ".archived", new Date().toISOString());
    else await store.remove(runId, ".archived");
    return true;
  };

  // ---- human eval notes: notes.json per run, case id → { text, updatedAt } ----
  const readNotes = (runId: string) =>
    readJson<Record<string, { text: string; updatedAt: string }>>(runId, "notes.json", {});
  const saveNote = async (runId: string, caseId: string, text: string) => {
    if (!safeSegment(runId)) return false;
    const notes = await readNotes(runId);
    if (text.trim()) notes[caseId] = { text, updatedAt: new Date().toISOString() };
    else delete notes[caseId];
    await store.write(runId, "notes.json", JSON.stringify(notes, null, 2));
    return true;
  };

  // ---- image ratings: ratings.json per run, case id → Rating -------------------
  const readRatings = (runId: string) => readJson<Record<string, Rating>>(runId, "ratings.json", {});
  const writeRatings = (runId: string, ratings: Record<string, Rating>) =>
    store.write(runId, "ratings.json", JSON.stringify(ratings, null, 2));
  const saveRating = async (runId: string, caseId: string, rating: Rating) => {
    if (!safeSegment(runId)) return false;
    const ratings = await readRatings(runId);
    ratings[caseId] = rating;
    await writeRatings(runId, ratings);
    return true;
  };

  // Human override of a case's pass/fail — works even when no eval ever ran.
  const saveVerdict = async (runId: string, caseId: string, passes: boolean) => {
    if (!safeSegment(runId)) return false;
    const ratings = await readRatings(runId);
    ratings[caseId] = {
      ...(ratings[caseId] ?? {}),
      passes,
      human: true,
      evaluating: false,
      updatedAt: new Date().toISOString(),
    };
    await writeRatings(runId, ratings);
    return true;
  };

  // Human override of the 0–5 quality score, the twin of saveVerdict. The
  // judge's original number survives untouched in `evaluation.score`.
  const saveScore = async (runId: string, caseId: string, score: number) => {
    if (!safeSegment(runId)) return false;
    const ratings = await readRatings(runId);
    ratings[caseId] = {
      ...(ratings[caseId] ?? {}),
      score,
      scoreHuman: true,
      evaluating: false,
      updatedAt: new Date().toISOString(),
    };
    await writeRatings(runId, ratings);
    return true;
  };

  // ---- experiment journal: journal.json per run, append-only entries ----------
  const readJournal = async (runId: string): Promise<{ entries: JournalEntry[] }> => {
    const j = await readJson<{ entries?: unknown }>(runId, "journal.json", {});
    return { entries: Array.isArray(j.entries) ? (j.entries as JournalEntry[]) : [] };
  };
  const writeJournal = (runId: string, journal: { entries: JournalEntry[] }) =>
    store.write(runId, "journal.json", JSON.stringify(journal, null, 2));
  const saveConclusion = async (runId: string, entryId: string, text: string) => {
    if (!safeSegment(runId)) return false;
    const journal = await readJournal(runId);
    const entry = journal.entries.find((e) => e.id === entryId);
    if (!entry) return false;
    entry.conclusion = text.trim() ? text : null;
    await writeJournal(runId, journal);
    return true;
  };

  // Run the AI judge over one case's rendered PNG and persist the verdict.
  const evalCase = async (runId: string, caseId: string): Promise<Rating> => {
    if (!safeSegment(runId)) throw new Error("bad runId");
    const manifest = await readJson<{ cases?: { id: string; request: string; image: string | null }[] }>(
      runId,
      "run.json",
      {},
    );
    const c = (manifest.cases ?? []).find((x) => x.id === caseId);
    if (!c) throw new Error("case not found");
    if (!c.image) throw new Error("case has no rendered image to evaluate");

    const png = await store.readBytes(runId, c.image);
    if (!png) throw new Error("image file missing");
    const { evaluation, generationId } = await Effect.runPromise(
      evaluateDiagram({ request: c.request, png }),
    );

    const rating: Rating = {
      passes: evaluation.passes,
      score: evaluation.score,
      note: evaluation.critique,
      evaluation,
      generationId,
      updatedAt: new Date().toISOString(),
    };
    await saveRating(runId, caseId, rating);
    return rating;
  };

  // ---- single-case rerun: regenerate one case in place -------------------------
  const rerunCase = async (runId: string, caseId: string, hypothesis: string) => {
    if (!safeSegment(runId)) throw new Error("bad runId");
    const manifestText = await store.readText(runId, "run.json");
    if (manifestText === null) throw new Error("run not found");
    const manifest = JSON.parse(manifestText) as Record<string, unknown>;
    const cases = manifest.cases as Record<string, unknown>[];
    const c = cases.find((x) => x.id === caseId);
    if (!c) throw new Error("case not found");

    const t0 = Date.now();
    const gen = await Effect.runPromise(Effect.result(createDiagram(c.request as string)));
    c.latencyMs = Date.now() - t0;
    // `renderedAt` bumps every rerun so the UI can cache-bust the (same-named) PNG.
    c.renderedAt = new Date().toISOString();

    if (gen._tag === "Failure") {
      // Same failure history the benchmark persists: raw drafts kept, ids
      // kept so the paid calls still get costed.
      const f = gen.failure;
      const attempts: { error: string; draft: string | null }[] = [];
      for (const [i, a] of f.attempts.entries()) {
        let draft: string | null = null;
        if (a.draft !== null) {
          draft = `${caseId}.attempt-${i + 1}.txt`;
          await store.write(runId, draft, a.draft);
        }
        attempts.push({ error: a.error, draft });
      }
      c.image = null;
      c.error = String(f.cause);
      c.generationIds = [...f.generationIds];
      c.attempts = attempts;
      const costs = await Promise.all(f.generationIds.map((id) => Effect.runPromise(generationCost(id))));
      c.costUsd = costs.reduce((a, b) => a + b, 0);
    } else {
      const d = gen.success;
      await store.write(runId, `${caseId}.png`, d.png);
      // The renderer's input SVG (pre-prepareSvg) — raw model output or template
      // render — plus the model's spec when the layer-4 path was taken.
      await store.write(runId, `${caseId}.svg`, d.svg);
      if (d.spec) await store.write(runId, `${caseId}.spec.json`, JSON.stringify(d.spec, null, 2));
      c.via = d.spec ? "spec" : "svg";
      c.image = `${caseId}.png`;
      c.error = null;
      delete c.attempts; // a stale failure history mustn't outlive a successful rerun
      // Record what the generator actually drew from — the drawing brief (and
      // which model wrote it) when running with a REWRITE pre-pass, otherwise
      // clear any stale brief so the manifest never claims a rewrite that
      // didn't happen this time.
      if (d.rewrittenRequest) {
        c.rewrittenRequest = d.rewrittenRequest;
        if (d.rewriteModel) c.rewriteModel = d.rewriteModel;
        else delete c.rewriteModel;
      } else {
        delete c.rewrittenRequest;
        delete c.rewriteModel;
      }
      c.generationIds = d.generationIds;
      const costs = await Promise.all(
        ((d.generationIds ?? []) as string[]).map((id) => Effect.runPromise(generationCost(id))),
      );
      c.costUsd = costs.reduce((a, b) => a + b, 0);
    }

    Object.assign(manifest, rollups(cases as { latencyMs: number; costUsd: number }[]));
    await store.write(runId, "run.json", JSON.stringify(manifest, null, 2));

    // Re-judge the fresh image so the card's pass/fail badge and rating don't
    // describe the old render. Best-effort — a failed eval shouldn't fail the rerun.
    if (c.image) await evalCase(runId, caseId).catch(() => {});

    // Record the rerun as its own journal entry; the conclusion is filled in by a
    // follow-up /api/conclusion call once the user has seen the result.
    const journal = await readJournal(runId);
    const entryId = `rerun-${Date.now()}`;
    journal.entries.push({
      id: entryId,
      kind: "rerun",
      caseId,
      hypothesis,
      conclusion: null,
      at: new Date().toISOString(),
    });
    await writeJournal(runId, journal);

    return { entryId, case: c };
  };

  // ---- run lists ---------------------------------------------------------------
  const listRuns = async () => {
    const ids = (await runIds()).reverse();
    const rows = await Promise.all(ids.map(async (id) => {
      try {
        if (await isArchived(id)) return null; // archived runs stay put but drop out of the list
        const text = await store.readText(id, "run.json");
        if (text === null) return null;
        const m = JSON.parse(text);
        return { id, model: m.model, cases: m.cases.length };
      } catch {
        return null; // skip incomplete runs
      }
    }));
    return rows.filter((r) => r !== null);
  };

  // One row per run: cost, time, and quality, newest first. Powers the history
  // view. Quality stays null until ratings.json files start appearing.
  const runStats = async () => {
    const ids = (await runIds()).reverse();
    const rows = await Promise.all(ids.map(async (id) => {
      try {
        const text = await store.readText(id, "run.json");
        if (text === null) return null;
        const m = JSON.parse(text);
        const ratings = await readRatings(id);
        const { avg, rated } = qualityOf(ratings);
        return {
          id,
          model: m.model ?? null,
          createdAt: m.createdAt ?? null,
          // Which rewrite pre-pass the run used ("haiku" | "sonnet" | null).
          // Run-level value when the benchmark wrote one (legacy `true` was
          // always sonnet); otherwise inferred from per-case briefs (covers
          // reruns done with a REWRITE pre-pass on older runs).
          rewrite: typeof m.rewrite === "string" && m.rewrite
            ? m.rewrite
            : m.rewrite === true
              ? "sonnet"
              : (m.cases as { rewrittenRequest?: string; rewriteModel?: string }[])
                  .find((c) => c.rewrittenRequest != null)
                  ?.rewriteModel ??
                ((m.cases as { rewrittenRequest?: string }[]).some((c) => c.rewrittenRequest != null)
                  ? "sonnet"
                  : null),
          cases: m.cases.length,
          p50LatencyMs: m.p50LatencyMs ?? null,
          totalCostUsd: m.totalCostUsd ?? null,
          quality: avg,
          rated,
          verdicts: {
            passed: Object.values(ratings).filter((r) => r.passes === true).length,
            failed: Object.values(ratings).filter((r) => r.passes === false).length,
          },
          refine: refineTally(m.cases),
          journal: (await readJournal(id)).entries,
          archived: await isArchived(id),
        };
      } catch {
        return null; // skip incomplete runs
      }
    }));
    return rows.filter((r) => r !== null);
  };

  // Every note across every run, joined with its case's request — one fetch to
  // feed accumulated human evals into a future improvement loop.
  const allNotes = async () => {
    const ids = await runIds();
    const out: unknown[] = [];
    for (const runId of ids) {
      const notes = await readNotes(runId);
      if (!Object.keys(notes).length) continue;
      const m = await readJson<{ cases?: { id: string; request: string }[] }>(runId, "run.json", {});
      const cases = new Map((m.cases ?? []).map((c) => [c.id, c.request]));
      for (const [caseId, note] of Object.entries(notes)) {
        out.push({ runId, caseId, request: cases.get(caseId) ?? null, ...note });
      }
    }
    return out;
  };

  // ---- the router ----------------------------------------------------------------
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (url.pathname === "/") {
      return new Response(HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (url.pathname === "/history") {
      return new Response(HISTORY_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (url.pathname === "/api/runs") {
      return Response.json(await listRuns());
    }
    if (url.pathname === "/api/history") {
      return Response.json(await runStats());
    }
    if (url.pathname === "/api/archive" && req.method === "POST") {
      const body = (await req.json().catch(() => null)) as { runId?: string; archived?: boolean } | null;
      if (!body?.runId || typeof body.archived !== "boolean") {
        return Response.json({ error: "runId, archived (boolean) required" }, { status: 400 });
      }
      const ok = await setArchived(body.runId, body.archived);
      return ok ? Response.json({ ok: true }) : Response.json({ error: "bad runId" }, { status: 403 });
    }
    if (url.pathname === "/api/notes" && req.method === "POST") {
      const body = (await req.json().catch(() => null)) as { runId?: string; caseId?: string; text?: string } | null;
      if (!body?.runId || !body?.caseId || typeof body.text !== "string") {
        return Response.json({ error: "runId, caseId, text required" }, { status: 400 });
      }
      const ok = await saveNote(body.runId, body.caseId, body.text);
      return ok ? Response.json({ ok: true }) : Response.json({ error: "bad runId" }, { status: 403 });
    }
    if (url.pathname === "/api/notes") {
      return Response.json(await allNotes());
    }
    if (url.pathname === "/api/eval" && req.method === "POST") {
      const body = (await req.json().catch(() => null)) as { runId?: string; caseId?: string } | null;
      if (!body?.runId || !body?.caseId) {
        return Response.json({ error: "runId, caseId required" }, { status: 400 });
      }
      try {
        return Response.json(await evalCase(body.runId, body.caseId));
      } catch (err) {
        return Response.json({ error: String(err instanceof Error ? err.message : err) }, { status: 500 });
      }
    }
    if (url.pathname === "/api/verdict" && req.method === "POST") {
      const body = (await req.json().catch(() => null)) as
        | { runId?: string; caseId?: string; passes?: boolean }
        | null;
      if (!body?.runId || !body?.caseId || typeof body.passes !== "boolean") {
        return Response.json({ error: "runId, caseId, passes required" }, { status: 400 });
      }
      const ok = await saveVerdict(body.runId, body.caseId, body.passes);
      return ok ? Response.json({ ok: true }) : Response.json({ error: "bad runId" }, { status: 403 });
    }
    if (url.pathname === "/api/score" && req.method === "POST") {
      const body = (await req.json().catch(() => null)) as
        | { runId?: string; caseId?: string; score?: number }
        | null;
      if (!body?.runId || !body?.caseId || typeof body.score !== "number" || !Number.isFinite(body.score)) {
        return Response.json({ error: "runId, caseId, numeric score required" }, { status: 400 });
      }
      // Clamp to the judge's 0–5 scale so a stray keystroke can't skew the
      // history view's quality averages.
      const score = Math.max(0, Math.min(5, body.score));
      const ok = await saveScore(body.runId, body.caseId, score);
      return ok ? Response.json({ ok: true }) : Response.json({ error: "bad runId" }, { status: 403 });
    }
    if (url.pathname === "/api/rerun" && req.method === "POST") {
      const body = (await req.json().catch(() => null)) as
        | { runId?: string; caseId?: string; hypothesis?: string }
        | null;
      if (!body?.runId || !body?.caseId) {
        return Response.json({ error: "runId, caseId required" }, { status: 400 });
      }
      if (!body.hypothesis?.trim()) {
        return Response.json({ error: "a hypothesis is required to rerun" }, { status: 400 });
      }
      try {
        return Response.json(await rerunCase(body.runId, body.caseId, body.hypothesis));
      } catch (err) {
        return Response.json({ error: String(err instanceof Error ? err.message : err) }, { status: 500 });
      }
    }
    if (url.pathname === "/api/conclusion" && req.method === "POST") {
      const body = (await req.json().catch(() => null)) as
        | { runId?: string; entryId?: string; text?: string }
        | null;
      if (!body?.runId || !body?.entryId || typeof body.text !== "string") {
        return Response.json({ error: "runId, entryId, text required" }, { status: 400 });
      }
      const ok = await saveConclusion(body.runId, body.entryId, body.text);
      return ok ? Response.json({ ok: true }) : Response.json({ error: "entry not found" }, { status: 404 });
    }
    if (url.pathname === "/api/bench/status") {
      return Response.json(await opts.bench.status());
    }
    if (url.pathname === "/api/bench" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as {
        limit?: number | null;
        hypothesis?: string;
        rewrite?: string | boolean;
      };
      if (!body.hypothesis?.trim()) {
        return Response.json({ error: "a hypothesis is required to start a run" }, { status: 400 });
      }
      const limit = body.limit && Number.isFinite(body.limit) && body.limit > 0 ? Math.floor(body.limit) : null;
      // `true` accepted for compat with the old checkbox payload (= sonnet).
      const rewrite = body.rewrite === "haiku" || body.rewrite === "sonnet"
        ? body.rewrite
        : body.rewrite === true ? "sonnet" : null;
      return opts.bench.start(limit, body.hypothesis, rewrite);
    }
    if (url.pathname.startsWith("/runs/")) {
      const parts = url.pathname.slice("/runs/".length).split("/").map(decodeURIComponent);
      if (parts.length !== 2 || !safeSegment(parts[0]) || !safeSegment(parts[1])) {
        return new Response("forbidden", { status: 403 });
      }
      return store.serve(parts[0], parts[1]);
    }
    return new Response("not found", { status: 404 });
  };
};
