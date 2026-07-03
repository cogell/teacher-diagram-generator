/**
 * The explorer — a tiny local viewer for browsing benchmark runs.
 *
 *   bun run explore        # then open http://localhost:8000
 *
 * Pick a run from the dropdown to see every diagram it produced, with its
 * latency and cost. You can also fire off new benchmark runs from the header:
 * state a hypothesis (required), optionally set a case limit, and hit “run
 * bench” — the grid fills in live as cases complete. Afterwards, record your
 * finding in the journal bar under the header. Clicking a card's title reruns
 * that one case, and likewise asks for a hypothesis up front and a finding
 * after. Every run's hypothesis/finding is surfaced in the history view. The
 * benchmark auto-fires the AI judge after each case — its pass/fail verdict
 * shows as a badge on the card — but the final say is still yours.
 */
import { readdir, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Config, Effect, Redacted, Schedule, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import { evaluateDiagram, type Evaluation } from "./evaluator";
import { createDiagram } from "./generator";

const PORT = Number(process.env.PORT ?? 8000);
const rootDir = fileURLToPath(new URL("./", import.meta.url));
const runsDir = join(rootDir, "runs");

const listRuns = async () => {
  const ids = (await readdir(runsDir).catch(() => [] as string[]))
    .filter((d) => /^\d{4}/.test(d))
    .sort()
    .reverse();
  const runs: unknown[] = [];
  for (const id of ids) {
    try {
      if (await isArchived(id)) continue; // archived runs stay on disk but drop out of the list
      const m = JSON.parse(await Bun.file(join(runsDir, id, "run.json")).text());
      runs.push({ id, model: m.model, cases: m.cases.length });
    } catch {
      // skip incomplete runs
    }
  }
  return runs;
};

// ---- archiving --------------------------------------------------------------
// Archiving hides a run from the lists without deleting anything: a `.archived`
// marker file is dropped in the run dir, and its presence is the whole state.
// Unarchiving removes the marker. Everything else (manifest, PNGs, notes,
// ratings, journal) stays on disk untouched.
const archiveMarker = (runId: string) => {
  const dir = resolve(runsDir, runId);
  if (!dir.startsWith(runsDir) || runId.includes("/") || runId.includes("..")) return null;
  return join(dir, ".archived");
};

const isArchived = async (runId: string) => {
  const file = archiveMarker(runId);
  return file ? Bun.file(file).exists() : false;
};

const setArchived = async (runId: string, archived: boolean) => {
  const file = archiveMarker(runId);
  if (!file) return false;
  if (archived) await Bun.write(file, new Date().toISOString());
  else await unlink(file).catch(() => {}); // already gone is fine
  return true;
};

// ---- human eval notes -------------------------------------------------------
// One notes.json per run dir, mapping case id → { text, updatedAt }. Kept
// separate from run.json so the benchmark (which rewrites its manifest after
// every case) never clobbers human annotations.
const notesFile = (runId: string) => {
  const dir = resolve(runsDir, runId);
  if (!dir.startsWith(runsDir) || runId.includes("/") || runId.includes("..")) return null;
  return join(dir, "notes.json");
};

const readNotes = async (runId: string): Promise<Record<string, { text: string; updatedAt: string }>> => {
  const file = notesFile(runId);
  if (!file) return {};
  try {
    return JSON.parse(await Bun.file(file).text());
  } catch {
    return {};
  }
};

const saveNote = async (runId: string, caseId: string, text: string) => {
  const file = notesFile(runId);
  if (!file) return false;
  const notes = await readNotes(runId);
  if (text.trim()) notes[caseId] = { text, updatedAt: new Date().toISOString() };
  else delete notes[caseId];
  await Bun.write(file, JSON.stringify(notes, null, 2));
  return true;
};

// ---- image ratings ----------------------------------------------------------
// One ratings.json per run dir, mapping case id → a Rating. `score` is the
// quantitative axis (0–5) and `note` the qualitative one — both mirrored out of
// the model's `evaluation` so the history view (which only reads `score`) and
// the notes-style rendering keep working. The full `evaluation` (passes, score,
// critique) rides along for the card to render.
interface Rating {
  /** True while the benchmark's judge is still working on this case — an
   *  in-flight placeholder written by benchmark.ts, replaced by the verdict. */
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

const ratingsFile = (runId: string) => {
  const dir = resolve(runsDir, runId);
  if (!dir.startsWith(runsDir) || runId.includes("/") || runId.includes("..")) return null;
  return join(dir, "ratings.json");
};

const readRatings = async (runId: string): Promise<Record<string, Rating>> => {
  const file = ratingsFile(runId);
  if (!file) return {};
  try {
    return JSON.parse(await Bun.file(file).text());
  } catch {
    return {};
  }
};

const saveRating = async (runId: string, caseId: string, rating: Rating) => {
  const file = ratingsFile(runId);
  if (!file) return false;
  const ratings = await readRatings(runId);
  ratings[caseId] = rating;
  await Bun.write(file, JSON.stringify(ratings, null, 2));
  return true;
};

// Human override of a case's pass/fail. Sets `passes` by hand on top of whatever
// the AI judge left (score/critique are preserved), and works even when no eval
// ever ran — a bare `{ passes, human }` rating is created from nothing. Flagged
// `human` so the UI can show it was set by a person, not the judge.
const saveVerdict = async (runId: string, caseId: string, passes: boolean) => {
  const file = ratingsFile(runId);
  if (!file) return false;
  const ratings = await readRatings(runId);
  const prev = ratings[caseId] ?? {};
  ratings[caseId] = {
    ...prev,
    passes,
    human: true,
    evaluating: false,
    updatedAt: new Date().toISOString(),
  };
  await Bun.write(file, JSON.stringify(ratings, null, 2));
  return true;
};

// Human override of a case's 0–5 quality score, the twin of `saveVerdict`.
// Writes `score` — the field qualityOf and the history view read — on top of
// whatever the AI judge left; the judge's original number survives untouched in
// `evaluation.score`. Works even when no eval ever ran. A later re-eval replaces
// the rating wholesale (see evalCase), which deliberately clears the tweak.
const saveScore = async (runId: string, caseId: string, score: number) => {
  const file = ratingsFile(runId);
  if (!file) return false;
  const ratings = await readRatings(runId);
  const prev = ratings[caseId] ?? {};
  ratings[caseId] = {
    ...prev,
    score,
    scoreHuman: true,
    evaluating: false,
    updatedAt: new Date().toISOString(),
  };
  await Bun.write(file, JSON.stringify(ratings, null, 2));
  return true;
};

// ---- experiment journal -----------------------------------------------------
// The discipline: every run (and every single-case rerun) starts with a written
// hypothesis and ends with a written finding. One journal.json per run dir holds
// an append-only list of entries. The full run's entry has the fixed id "run"
// and is written by benchmark.ts at startup (via the HYPOTHESIS env var); each
// rerun appends its own entry. Kept separate from run.json — like notes/ratings
// — so the benchmark's manifest rewrites never clobber it.
interface JournalEntry {
  id: string;
  kind: "run" | "rerun";
  caseId?: string;
  hypothesis: string;
  conclusion: string | null;
  at: string;
}

const journalFile = (runId: string) => {
  const dir = resolve(runsDir, runId);
  if (!dir.startsWith(runsDir) || runId.includes("/") || runId.includes("..")) return null;
  return join(dir, "journal.json");
};

const readJournal = async (runId: string): Promise<{ entries: JournalEntry[] }> => {
  const file = journalFile(runId);
  if (!file) return { entries: [] };
  try {
    const j = JSON.parse(await Bun.file(file).text());
    return { entries: Array.isArray(j.entries) ? j.entries : [] };
  } catch {
    return { entries: [] };
  }
};

const writeJournal = async (runId: string, journal: { entries: JournalEntry[] }) => {
  const file = journalFile(runId);
  if (!file) return false;
  await Bun.write(file, JSON.stringify(journal, null, 2));
  return true;
};

// Set the conclusion (finding) on one journal entry — the run-level "run" entry
// for a full run, or a specific rerun entry by its id.
const saveConclusion = async (runId: string, entryId: string, text: string) => {
  const journal = await readJournal(runId);
  const entry = journal.entries.find((e) => e.id === entryId);
  if (!entry) return false;
  entry.conclusion = text.trim() ? text : null;
  return writeJournal(runId, journal);
};

// Run the AI judge over one case's rendered PNG and persist the verdict. Reads
// the run manifest to recover the case's request + image, hands both to the
// evaluator, then flattens the result into a Rating and writes ratings.json.
const evalCase = async (runId: string, caseId: string): Promise<Rating> => {
  const dir = resolve(runsDir, runId);
  if (!dir.startsWith(runsDir) || runId.includes("/") || runId.includes("..")) {
    throw new Error("bad runId");
  }
  const manifest = JSON.parse(await Bun.file(join(dir, "run.json")).text());
  const c = (manifest.cases as { id: string; request: string; image: string | null }[])
    .find((x) => x.id === caseId);
  if (!c) throw new Error("case not found");
  if (!c.image) throw new Error("case has no rendered image to evaluate");

  const png = new Uint8Array(await Bun.file(join(dir, c.image)).arrayBuffer());
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

// ---- single-case rerun ------------------------------------------------------
// Regenerate one case in place: re-run the generator over its request, overwrite
// its PNG, and refresh its latency / cost / refinement in run.json. Kept here
// (rather than reusing benchmark.ts) because importing that module would kick
// off a whole benchmark run — so we replicate the tiny cost lookup it needs.

// The slice of OpenRouter's `/generation` response we care about — mirrors
// benchmark.ts.
const GenerationRecord = Schema.Struct({
  data: Schema.Struct({ total_cost: Schema.Number }),
});

// Real USD cost for a generation, looked up (with backoff, since a just-finished
// generation isn't indexed for a few seconds) from OpenRouter.
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
    Effect.retry({ times: 12, schedule: Schedule.spaced("2 seconds") }),
    Effect.orElseSucceed(() => 0),
    Effect.provide(FetchHttpClient.layer),
  );

// Recompute the run-level rollups (p50 latency, total cost) from its cases,
// matching benchmark.ts's writeManifest so a rerun keeps the manifest honest.
const rollups = (cases: { latencyMs: number; costUsd: number }[]) => {
  const lat = cases.map((c) => c.latencyMs).filter((n) => n > 0).sort((a, b) => a - b);
  return {
    p50LatencyMs: lat[Math.floor(lat.length / 2)] ?? 0,
    totalCostUsd: cases.reduce((s, c) => s + c.costUsd, 0),
  };
};

const rerunCase = async (runId: string, caseId: string, hypothesis: string) => {
  const dir = resolve(runsDir, runId);
  if (!dir.startsWith(runsDir) || runId.includes("/") || runId.includes("..")) {
    throw new Error("bad runId");
  }
  const runJson = join(dir, "run.json");
  const manifest = JSON.parse(await Bun.file(runJson).text());
  const cases = manifest.cases as Record<string, unknown>[];
  const c = cases.find((x) => x.id === caseId);
  if (!c) throw new Error("case not found");

  const t0 = Date.now();
  const gen = await Effect.runPromise(Effect.result(createDiagram(c.request as string)));
  c.latencyMs = Date.now() - t0;
  // `renderedAt` bumps every rerun so the UI can cache-bust the (same-named) PNG.
  c.renderedAt = new Date().toISOString();

  if (gen._tag === "Failure") {
    // Same failure history the benchmark persists: raw drafts on disk, ids
    // kept so the paid calls still get costed.
    const f = gen.failure;
    const attempts: { error: string; draft: string | null }[] = [];
    for (const [i, a] of f.attempts.entries()) {
      let draft: string | null = null;
      if (a.draft !== null) {
        draft = `${caseId}.attempt-${i + 1}.txt`;
        await Bun.write(join(dir, draft), a.draft);
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
    await Bun.write(join(dir, `${caseId}.png`), d.png);
    // Raw model SVG (pre-prepareSvg), for diagnosing regressions from source.
    await Bun.write(join(dir, `${caseId}.svg`), d.svg);
    c.image = `${caseId}.png`;
    c.error = null;
    delete c.attempts; // a stale failure history mustn't outlive a successful rerun
    c.generationIds = d.generationIds;
    const costs = await Promise.all((d.generationIds ?? []).map((id) => Effect.runPromise(generationCost(id))));
    c.costUsd = costs.reduce((a, b) => a + b, 0);
  }

  Object.assign(manifest, rollups(cases as { latencyMs: number; costUsd: number }[]));
  await Bun.write(runJson, JSON.stringify(manifest, null, 2));

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

// One row per run: cost, time, and quality, newest first. Powers the history
// view. Quality stays null until ratings.json files start appearing.
const runStats = async () => {
  const ids = (await readdir(runsDir).catch(() => [] as string[]))
    .filter((d) => /^\d{4}/.test(d))
    .sort()
    .reverse();
  const rows: unknown[] = [];
  for (const id of ids) {
    try {
      const m = JSON.parse(await Bun.file(join(runsDir, id, "run.json")).text());
      const ratings = await readRatings(id);
      const { avg, rated } = qualityOf(ratings);
      rows.push({
        id,
        model: m.model ?? null,
        createdAt: m.createdAt ?? null,
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
      });
    } catch {
      // skip incomplete runs
    }
  }
  return rows;
};

// Every note across every run, joined with its case's request — one fetch to
// feed accumulated human evals into a future improvement loop.
const allNotes = async () => {
  const ids = (await readdir(runsDir).catch(() => [] as string[])).filter((d) => /^\d{4}/.test(d)).sort();
  const out: unknown[] = [];
  for (const runId of ids) {
    const notes = await readNotes(runId);
    if (!Object.keys(notes).length) continue;
    const cases = await Bun.file(join(runsDir, runId, "run.json")).json()
      .then((m) => new Map((m.cases as { id: string; request: string }[]).map((c) => [c.id, c.request])))
      .catch(() => new Map<string, string>());
    for (const [caseId, note] of Object.entries(notes)) {
      out.push({ runId, caseId, request: cases.get(caseId) ?? null, ...note });
    }
  }
  return out;
};

const datasetCount = async () => {
  const text = await Bun.file(join(rootDir, "dataset.jsonl")).text().catch(() => "");
  return text.trim().split("\n").filter(Boolean).length;
};

// ---- benchmark process management ------------------------------------------
// One benchmark at a time, spawned as a child of the explorer. The harness
// rewrites run.json after every case, so the UI polls the newest run for
// live progress — the explorer only needs to track the process itself.
interface BenchState {
  proc: Bun.Subprocess;
  limit: number | null;
  startedAt: string;
  log: string[];
  exitCode: number | null;
}
// Backed by globalThis so a `bun --hot` reload mid-run keeps tracking the child
// benchmark instead of forgetting it. startBench is the only writer.
let bench: BenchState | null = (globalThis as any).__bench ?? null;

const pipeLines = async (stream: ReadableStream<Uint8Array>, sink: string[]) => {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of stream) {
    buf += decoder.decode(chunk, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      sink.push(line);
      if (sink.length > 200) sink.shift();
    }
  }
  if (buf) sink.push(buf);
};

const startBench = (limit: number | null, hypothesis: string) => {
  const proc = Bun.spawn(["bun", "benchmark.ts"], {
    cwd: rootDir,
    env: {
      ...process.env,
      ...(limit ? { LIMIT: String(limit) } : {}),
      HYPOTHESIS: hypothesis,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const state: BenchState = { proc, limit, startedAt: new Date().toISOString(), log: [], exitCode: null };
  pipeLines(proc.stdout as ReadableStream<Uint8Array>, state.log);
  pipeLines(proc.stderr as ReadableStream<Uint8Array>, state.log);
  proc.exited.then((code) => {
    state.exitCode = code;
  });
  bench = state;
  (globalThis as any).__bench = state;
};

const benchStatus = async () => {
  const total = bench?.limit ?? (await datasetCount());
  return {
    running: bench !== null && bench.exitCode === null,
    limit: bench?.limit ?? null,
    total,
    startedAt: bench?.startedAt ?? null,
    exitCode: bench?.exitCode ?? null,
    log: bench?.log.slice(-15) ?? [],
  };
};

const HTML = `<!doctype html><meta charset="utf-8"><title>Number-line explorer</title>
<style>
  body{font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;color:#0f172a;background:#f8fafc}
  header{position:sticky;top:0;background:#fff;border-bottom:1px solid #e2e8f0;padding:14px 24px;display:flex;align-items:center;gap:14px;flex-wrap:wrap;z-index:1}
  h1{font-size:18px;margin:0} select,input,button{font:inherit;padding:5px 8px;border:1px solid #cbd5e1;border-radius:6px}
  input#limit{width:70px}
  button{background:#0f172a;color:#fff;border-color:#0f172a;cursor:pointer} button:disabled{background:#94a3b8;border-color:#94a3b8;cursor:default}
  .summary{color:#64748b;font-size:13px}
  .status{font-size:13px;color:#334155} .status.running{color:#2563eb} .status.err{color:#dc2626}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:16px;padding:24px}
  .card{background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:12px}
  .hd{display:flex;align-items:center;gap:8px;margin-bottom:6px}
  .id{font-weight:700;font-size:12px;color:#475569;cursor:pointer;border-radius:4px;padding:1px 4px;margin:-1px -4px}
  .id:hover{background:#f1f5f9;color:#0f172a} .id.rerunning{color:#2563eb;cursor:default}
  .meta{margin-left:auto;color:#64748b;font-size:12px}
  .badge{font-size:11px;font-weight:600;padding:1px 7px;border-radius:999px;cursor:default;white-space:nowrap}
  .badge.passed{background:#dcfce7;color:#15803d}
  .badge.revised{background:#fef3c7;color:#b45309}
  .badge.failed{background:#fee2e2;color:#b91c1c}
  .badge.evaluating{background:#dbeafe;color:#1d4ed8;animation:evpulse 1.2s ease-in-out infinite}
  @keyframes evpulse{0%,100%{opacity:1}50%{opacity:.45}}
  /* Human-settable pass/fail: two chips, the active verdict lit. Dim until chosen. */
  .verdict{display:inline-flex;gap:3px}
  .vbtn{font-size:11px;font-weight:600;padding:1px 7px;border-radius:999px;border:1px solid #e2e8f0;background:#fff;color:#cbd5e1;cursor:pointer;white-space:nowrap;line-height:1.5}
  .vbtn:hover:not(:disabled){border-color:#cbd5e1;color:#64748b}
  .vbtn.vpass.on{background:#dcfce7;border-color:#86efac;color:#15803d}
  .vbtn.vfail.on{background:#fee2e2;border-color:#fca5a5;color:#b91c1c}
  .vbtn.human{box-shadow:0 0 0 1px #94a3b8 inset}
  .vbtn:disabled{cursor:default;opacity:.6}
  .req{font-size:13px;color:#334155;margin-bottom:8px}
  img,.noimg{width:100%;border:1px solid #f1f5f9;border-radius:6px;background:#fff}
  .noimg{display:flex;align-items:center;justify-content:center;min-height:120px;color:#94a3b8;font-size:12px;padding:8px;text-align:center}
  textarea.note{width:100%;box-sizing:border-box;margin-top:8px;padding:6px 8px;border:1px solid #e2e8f0;border-radius:6px;font:12px/1.4 inherit;color:#334155;resize:vertical;min-height:34px}
  textarea.note::placeholder{color:#cbd5e1}
  .notehd{display:flex;align-items:center;margin-top:2px;min-height:14px}
  .saved{margin-left:auto;font-size:11px;color:#16a34a;opacity:0;transition:opacity .3s} .saved.show{opacity:1}
  .empty{padding:48px;color:#64748b}
  button.evalbtn{background:#fff;color:#0f172a;border-color:#cbd5e1;padding:3px 8px;font-size:12px}
  button.evalbtn:hover:not(:disabled){background:#f1f5f9}
  button.evalbtn:disabled{background:#fff;border-color:#e2e8f0;color:#94a3b8}
  .eval:empty{display:none}
  .eval{margin-top:8px;font-size:12px}
  .rating{border:1px solid #e2e8f0;border-radius:8px;padding:8px 10px;background:#f8fafc}
  .scorerow{display:flex;align-items:flex-start;gap:8px}
  .score{flex:none;min-width:30px;text-align:center;padding:2px 6px;border-radius:999px;font-weight:700;font-variant-numeric:tabular-nums;cursor:pointer}
  .score:hover{box-shadow:0 0 0 1px #94a3b8 inset}
  /* Same ring the human-set verdict chips get: this number came from a person. */
  .score.human{box-shadow:0 0 0 1px #94a3b8 inset}
  input.scoreedit{flex:none;width:56px;box-sizing:border-box;padding:2px 6px;border:1px solid #cbd5e1;border-radius:8px;font:inherit;font-size:12px;font-weight:700;text-align:center}
  .crit{color:#334155;line-height:1.4}
  .evbusy{color:#2563eb} .everr{color:#dc2626}
  pre#log{margin:0 24px;padding:10px 12px;background:#0f172a;color:#cbd5e1;font-size:12px;border-radius:8px;max-height:180px;overflow:auto;display:none}
  input#hyp{width:230px}
  .journalbar{display:none;padding:10px 24px;background:#fff;border-bottom:1px solid #e2e8f0}
  .journalbar.show{display:block}
  .jrow{display:flex;gap:10px;align-items:flex-start;margin:3px 0}
  .jlabel{flex:none;width:82px;color:#64748b;font-weight:600;text-transform:uppercase;font-size:11px;letter-spacing:.03em;padding-top:6px}
  .jhyp{padding-top:5px;font-size:13px;color:#334155;white-space:pre-wrap}
  .jhyp.missing{color:#b45309;font-style:italic}
  textarea.concl{flex:1;box-sizing:border-box;padding:6px 8px;border:1px solid #e2e8f0;border-radius:6px;font:13px/1.4 inherit;color:#334155;resize:vertical;min-height:32px}
  textarea.concl.missing{border-color:#f59e0b;background:#fffbeb}
  .csaved{align-self:center;font-size:11px;color:#16a34a;opacity:0;transition:opacity .3s} .csaved.show{opacity:1}
  .jmiss{color:#b45309;font-style:italic}
</style>
<header>
  <h1>Number-line explorer</h1>
  <a href="/history" class="summary" style="text-decoration:none">history →</a>
  <select id="run"></select>
  <span id="summary" class="summary"></span>
  <span style="margin-left:auto;display:flex;align-items:center;gap:8px">
    <label for="hyp" class="summary">hypothesis</label>
    <input id="hyp" placeholder="what are you testing?" title="required — state your hypothesis before running">
    <label for="limit" class="summary">limit</label>
    <input id="limit" type="number" min="1" value="6" placeholder="all">
    <button id="go">run bench</button>
    <span id="status" class="status"></span>
  </span>
</header>
<div id="journalbar" class="journalbar"></div>
<pre id="log"></pre>
<div id="grid" class="grid"></div>
<script>
  const grid = document.getElementById("grid");
  const runSel = document.getElementById("run");
  const summary = document.getElementById("summary");
  const limitInput = document.getElementById("limit");
  const goBtn = document.getElementById("go");
  const statusEl = document.getElementById("status");
  const logEl = document.getElementById("log");
  const hypInput = document.getElementById("hyp");
  const journalbar = document.getElementById("journalbar");
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  let benchWasRunning = false;

  // The evaluator's verdict on a case, once its (auto-fired) rating lands.
  // Falls back to the legacy critique→revise outcome for runs made while the
  // refinement loop lived inside the generator; shows nothing when unrated.
  // The effective pass/fail for a case: a human override wins, else the AI
  // judge's verdict, else null (unrated). Same precedence the badge draws with.
  function effectivePasses(rating) {
    if (rating && typeof rating.passes === "boolean") return rating.passes;
    if (rating && rating.evaluation && typeof rating.evaluation.passes === "boolean") return rating.evaluation.passes;
    return null;
  }

  // The pass/fail control: two chips the human can click to set or flip the
  // verdict — even when no eval ran (or it errored), so a case is never stuck
  // unrated. The active verdict is lit; a human-set one gets a ring. legacyRef
  // (an old refinement outcome) only seeds the tooltip now.
  function verdictBadge(rating, legacyRef) {
    const passes = effectivePasses(rating);
    const human = !!(rating && rating.human);
    const crit = (rating && (rating.note || (rating.evaluation && rating.evaluation.critique))) || "";
    const legacy = legacyRef && legacyRef.outcome
      ? "prior refinement: " + legacyRef.outcome
      : "";
    const title = passes === null
      ? (legacy ? legacy + " — click to set a verdict" : "not evaluated — click to set a verdict")
      : human
        ? "set by you — click to change"
        : "evaluator verdict" + (crit ? ":\\n" + crit : "") + " — click to override";
    const chip = (v, label) => {
      const on = (v === "pass" && passes === true) || (v === "fail" && passes === false);
      return '<button class="vbtn v' + v + (on ? " on" : "") + (on && human ? " human" : "") +
        '" data-v="' + v + '">' + label + "</button>";
    };
    return '<span class="verdict" title="' + esc(title) + '">' +
      chip("pass", "pass ✓") + chip("fail", "fail ✗") + "</span>";
  }

  // The experiment journal for the selected run: its hypothesis (set before the
  // run) and a finding editor (filled in after). Any single-case reruns show
  // their own hypothesis/finding beneath.
  function renderJournalBar(journal) {
    const entries = (journal && journal.entries) || [];
    const run = entries.find((e) => e.id === "run");
    const reruns = entries.filter((e) => e.kind === "rerun");
    if (!run && !reruns.length) { journalbar.classList.remove("show"); journalbar.innerHTML = ""; return; }
    const hyp = run && run.hypothesis && run.hypothesis.trim();
    const hypRow = '<div class="jrow"><div class="jlabel">hypothesis</div>' +
      '<div class="jhyp' + (hyp ? "" : " missing") + '">' +
      (hyp ? esc(run.hypothesis) : "none recorded for this run") + "</div></div>";
    const conclVal = (run && run.conclusion) || "";
    const conclRow = '<div class="jrow"><div class="jlabel">finding</div>' +
      '<textarea class="concl' + (conclVal.trim() ? "" : " missing") + '" data-entry="run" ' +
      'placeholder="what did you find? record your conclusion for this run">' + esc(conclVal) + "</textarea>" +
      '<span class="csaved">saved ✓</span></div>';
    const rerunRows = reruns.map((e) =>
      '<div class="jrow"><div class="jlabel">rerun ' + esc(e.caseId || "") + '</div>' +
      '<div class="jhyp"><b>hypothesis:</b> ' + esc(e.hypothesis || "—") + "<br>" +
      "<b>finding:</b> " + (e.conclusion && e.conclusion.trim() ? esc(e.conclusion) : '<span class="jmiss">not recorded</span>') +
      "</div></div>").join("");
    journalbar.innerHTML = hypRow + conclRow + rerunRows;
    journalbar.classList.add("show");
  }

  // Autosave the finding: debounced while typing, immediate on blur.
  const conclTimers = new Map();
  async function pushConclusion(ta) {
    const res = await fetch("/api/conclusion", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: runSel.value, entryId: ta.dataset.entry, text: ta.value }),
    });
    if (res.ok) {
      ta.classList.toggle("missing", !ta.value.trim());
      const tick = ta.parentElement.querySelector(".csaved");
      if (tick) { tick.classList.add("show"); setTimeout(() => tick.classList.remove("show"), 1200); }
    }
  }
  journalbar.addEventListener("input", (e) => {
    if (!e.target.classList.contains("concl")) return;
    clearTimeout(conclTimers.get(e.target));
    conclTimers.set(e.target, setTimeout(() => pushConclusion(e.target), 700));
  });
  journalbar.addEventListener("focusout", (e) => {
    if (!e.target.classList.contains("concl")) return;
    clearTimeout(conclTimers.get(e.target));
    pushConclusion(e.target);
  });

  // evalsPending: true while a bench is running on this run — the benchmark
  // auto-fires the judge on every rendered case, so a card with an image but
  // no rating yet is known to have an evaluation in flight.
  async function loadRun(id, evalsPending) {
    if (!id) return;
    // Don't re-render (live polling) while a note, the finding, or a score is
    // being typed — it would destroy the input under the cursor. The next tick
    // catches up.
    const active = document.activeElement;
    if (
      active &&
      (active.classList.contains("note") || active.classList.contains("concl") ||
        active.classList.contains("scoreedit"))
    ) return;
    const [m, notes, ratings, journal] = await Promise.all([
      (await fetch("/runs/" + id + "/run.json")).json(),
      fetch("/runs/" + id + "/notes.json").then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
      fetch("/runs/" + id + "/ratings.json").then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
      fetch("/runs/" + id + "/journal.json").then((r) => (r.ok ? r.json() : { entries: [] })).catch(() => ({ entries: [] })),
    ]);
    renderJournalBar(journal);
    const perCase = m.cases.length ? m.totalCostUsd / m.cases.length : 0;
    summary.textContent = (m.model ? m.model + " · " : "") + m.cases.length + " cases · p50 " +
      (m.p50LatencyMs / 1000).toFixed(1) + "s · $" + perCase.toFixed(4) + "/case · $" +
      m.totalCostUsd.toFixed(4) + " total";
    grid.innerHTML = m.cases.map((c) => {
      // Cache-bust the (same-named) PNG so a rerun's fresh image actually shows.
      const bust = c.renderedAt ? "?v=" + encodeURIComponent(c.renderedAt) : "";
      const img = c.image
        ? '<img src="/runs/' + id + "/" + c.image + bust + '">'
        : '<div class="noimg">' + esc(c.error || "no render") + "</div>";
      const note = notes[c.id] ? notes[c.id].text : "";
      const r = ratings[c.id];
      // An eval is in flight when: a manual one is tracked in the 'evaluating'
      // set; the benchmark wrote an in-flight placeholder into ratings.json
      // (data-driven, so it works even for terminal-launched benches — but
      // ignore placeholders older than 10 min, e.g. left by a killed bench);
      // or a bench is running and this rendered case has no rating yet.
      const inFlight = r && r.evaluating &&
        Date.now() - Date.parse(r.updatedAt || 0) < 10 * 60 * 1000;
      const pending = evaluating.has(c.id) || !!inFlight || (evalsPending && c.image && !r);
      const rated = r && !r.evaluating;
      // Show whatever we know right now: an in-flight spinner survives live
      // re-renders, otherwise the saved rating.
      const evalInner = pending
        ? '<div class="evbusy">evaluating…</div>'
        : evalHtml(rated ? r : null);
      const evalBtn = '<button class="evalbtn" data-case="' + esc(c.id) + '"' +
        (c.image ? "" : " disabled title=\\"no image to evaluate\\"") +
        (pending ? " disabled" : "") + ">" +
        (pending ? "evaluating…" : rated ? "re-evaluate" : "evaluate") + "</button>";
      const rerun = rerunning.has(c.id);
      const idEl = '<span class="id' + (rerun ? " rerunning" : "") + '" data-case="' + esc(c.id) + '" title="click to rerun this case">' +
        esc(c.id) + (rerun ? " · rerunning…" : "") + "</span>";
      const badge = pending
        ? '<span class="badge evaluating">evaluating…</span>'
        : verdictBadge(rated ? r : null, c.refinement);
      return '<div class="card" data-case="' + esc(c.id) + '"><div class="hd">' + idEl +
        badge +
        '<span class="meta">' + (c.latencyMs / 1000).toFixed(1) + "s · $" + c.costUsd.toFixed(4) + "</span>" + evalBtn + "</div>" +
        '<div class="req">' + esc(c.request) + "</div>" + img +
        '<div class="eval">' + evalInner + "</div>" +
        '<textarea class="note" data-case="' + esc(c.id) + '" placeholder="notes — what\\u2019s wrong / right with this one?">' + esc(note) + "</textarea>" +
        '<div class="notehd"><span class="saved">saved ✓</span></div></div>';
    }).join("") || '<div class="empty">Run starting…</div>';
    // If any judge is still working, keep refreshing this run so badges and
    // verdicts land live even when the bench was launched from a terminal
    // (which the bench poller above knows nothing about).
    clearTimeout(evalPollTimer);
    if (Object.values(ratings).some((r) => r && r.evaluating &&
        Date.now() - Date.parse(r.updatedAt || 0) < 10 * 60 * 1000)) {
      evalPollTimer = setTimeout(() => loadRun(runSel.value), 2500);
    }
    return m;
  }
  let evalPollTimer = null;

  // Green→amber→red ramp for a 0–5 score, matching the history view.
  const qColor = (q) => { const t = Math.max(0, Math.min(1, q / 5)); return "hsl(" + Math.round(t * 130) + ",70%,42%)"; };
  // Render a rating into the card's eval panel. Always rendered — even with no
  // rating at all — because the score chip doubles as the human's control for
  // setting the quality number by hand (the twin of the pass/fail chips).
  function evalHtml(r) {
    const e = (r && r.evaluation) || {};
    const score = r && r.score != null ? r.score : (e.score != null ? e.score : null);
    const crit = (r && r.note) || e.critique || "";
    const human = !!(r && r.scoreHuman);
    const title = human
      ? "quality set by you — click to change"
      : score == null
        ? "no quality score yet — click to set one"
        : "judge score — click to override";
    const chip = score == null
      ? '<span class="score" data-score="" title="' + title + '" style="background:#f1f5f9;color:#94a3b8">—</span>'
      : '<span class="score' + (human ? " human" : "") + '" data-score="' + score + '" title="' + title +
        '" style="background:' + qColor(score) + '22;color:' + qColor(score) + '">' + score.toFixed(1) + "</span>";
    return '<div class="rating"><div class="scorerow">' + chip +
      '<span class="crit">' + esc(crit) + "</span></div></div>";
  }

  // Case ids with an eval request in flight — kept across live re-renders so the
  // spinner (and disabled button) survive a bench-driven grid rebuild.
  const evaluating = new Set();
  grid.addEventListener("click", async (e) => {
    const btn = e.target.closest(".evalbtn");
    if (!btn || btn.disabled) return;
    const runId = runSel.value;
    const caseId = btn.dataset.case;
    evaluating.add(caseId);
    btn.disabled = true;
    btn.textContent = "evaluating…";
    const card = btn.closest(".card");
    const panel = card.querySelector(".eval");
    if (panel) panel.innerHTML = '<div class="evbusy">evaluating… (vision model, ~10–20s)</div>';
    let data, ok = false;
    try {
      const res = await fetch("/api/eval", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId, caseId }),
      });
      data = await res.json();
      ok = res.ok;
    } catch (err) {
      data = { error: String((err && err.message) || err) };
    }
    evaluating.delete(caseId);
    // The grid may have been rebuilt mid-eval (bench polling) — re-find the live
    // card by id rather than touching the possibly-detached node we captured.
    const live = grid.querySelector('.card[data-case="' + (window.CSS ? CSS.escape(caseId) : caseId) + '"]');
    if (!live || runSel.value !== runId) return;
    const p = live.querySelector(".eval");
    if (p) p.innerHTML = ok ? evalHtml(data) : '<div class="everr">' + esc(data.error || "eval failed") + "</div>";
    const b = live.querySelector(".evalbtn");
    if (b) { b.disabled = false; b.textContent = ok ? "re-evaluate" : "evaluate"; }
  });

  // Click a pass/fail chip to set or flip a case's verdict by hand — including
  // when no eval ran (or it errored), so a case is never stuck unrated. We light
  // the chosen chip immediately (optimistic), persist via /api/verdict, and let
  // the next poll reconcile from disk; on failure we put the old chips back.
  grid.addEventListener("click", async (e) => {
    const btn = e.target.closest(".vbtn");
    if (!btn || btn.disabled) return;
    const span = btn.closest(".verdict");
    const card = btn.closest(".card");
    if (!span || !card) return;
    const caseId = card.dataset.case;
    const runId = runSel.value;
    const passes = btn.dataset.v === "pass";
    const prevHtml = span.innerHTML;
    span.querySelectorAll(".vbtn").forEach((x) => {
      const on = x.dataset.v === btn.dataset.v;
      x.classList.toggle("on", on);
      x.classList.toggle("human", on);
      x.disabled = true;
    });
    span.setAttribute("title", "set by you — click to change");
    try {
      const res = await fetch("/api/verdict", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId, caseId, passes }),
      });
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))).error) || "failed");
    } catch (err) {
      span.innerHTML = prevHtml; // revert the optimistic update
      alert("Couldn't save verdict: " + String((err && err.message) || err));
      return;
    }
    span.querySelectorAll(".vbtn").forEach((x) => { x.disabled = false; });
  });

  // Click the score chip to tweak a case's 0–5 quality number by hand — the
  // judge's original stays in evaluation.score. The chip swaps to a number
  // input; Enter or blur saves via /api/score, Escape cancels. The grid reloads
  // from disk afterward, so the chip re-renders with the human ring (and the
  // history view's quality column picks the tweak up on its next fetch).
  grid.addEventListener("click", (e) => {
    const chip = e.target.closest(".score");
    if (!chip) return;
    const card = chip.closest(".card");
    if (!card) return;
    const caseId = card.dataset.case;
    const runId = runSel.value;
    const input = document.createElement("input");
    input.type = "number";
    input.min = "0"; input.max = "5"; input.step = "0.1";
    input.className = "scoreedit";
    input.value = chip.dataset.score || "";
    chip.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = async (save) => {
      if (done) return;
      done = true;
      const score = Number(input.value);
      if (save && input.value !== "" && Number.isFinite(score)) {
        try {
          const res = await fetch("/api/score", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ runId, caseId, score: Math.max(0, Math.min(5, score)) }),
          });
          if (!res.ok) throw new Error(((await res.json().catch(() => ({}))).error) || "failed");
        } catch (err) {
          alert("Couldn't save score: " + String((err && err.message) || err));
        }
      }
      loadRun(runSel.value); // re-render from disk (also restores the chip on cancel)
    };
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") { ev.preventDefault(); finish(true); }
      else if (ev.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(true));
  });

  // Case ids currently being regenerated — kept across live re-renders (like
  // the evaluating set) so the "rerunning…" label survives a bench-driven rebuild.
  const rerunning = new Set();
  grid.addEventListener("click", async (e) => {
    const idEl = e.target.closest(".id");
    if (!idEl) return;
    const caseId = idEl.dataset.case;
    if (rerunning.has(caseId)) return;
    // Every rerun is its own little experiment: a hypothesis up front (required,
    // Enter in the prompt submits it), a finding after. Cancelling either prompt
    // aborts / leaves the finding blank respectively.
    const hypothesis = prompt("Hypothesis for rerunning " + caseId + "? (required)");
    if (hypothesis == null) return;              // cancelled
    if (!hypothesis.trim()) { alert("A hypothesis is required to rerun."); return; }
    const runId = runSel.value;
    rerunning.add(caseId);
    idEl.classList.add("rerunning");
    idEl.textContent = caseId + " · rerunning…";
    let ok = false, data;
    try {
      const res = await fetch("/api/rerun", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId, caseId, hypothesis }),
      });
      data = await res.json();
      ok = res.ok;
    } catch (err) {
      data = { error: String((err && err.message) || err) };
    }
    rerunning.delete(caseId);
    // The run may have changed under us; only refresh if we're still on it.
    if (runSel.value === runId) await loadRun(runId);
    if (!ok) { alert("Rerun failed: " + (data && data.error || "unknown error")); return; }
    // Now the finding. Re-prompt until they write something or explicitly cancel.
    let finding = prompt("Rerun of " + caseId + " done. What did you find? (required)");
    while (finding != null && !finding.trim()) {
      finding = prompt("A finding is required. What did you find for " + caseId + "?");
    }
    if (finding != null && data && data.entryId) {
      await fetch("/api/conclusion", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId, entryId: data.entryId, text: finding }),
      });
      if (runSel.value === runId) await loadRun(runId);
    }
  });

  // Autosave notes: debounced while typing, immediate on blur.
  const noteTimers = new Map();
  async function pushNote(ta) {
    const res = await fetch("/api/notes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: runSel.value, caseId: ta.dataset.case, text: ta.value }),
    });
    if (res.ok) {
      const tick = ta.parentElement.querySelector(".saved");
      tick.classList.add("show");
      setTimeout(() => tick.classList.remove("show"), 1200);
    }
  }
  grid.addEventListener("input", (e) => {
    if (!e.target.classList.contains("note")) return;
    clearTimeout(noteTimers.get(e.target));
    noteTimers.set(e.target, setTimeout(() => pushNote(e.target), 700));
  });
  grid.addEventListener("focusout", (e) => {
    if (!e.target.classList.contains("note")) return;
    clearTimeout(noteTimers.get(e.target));
    pushNote(e.target);
  });

  // Rebuild the dropdown; returns the newest run id. Keeps the current
  // selection unless followNewest is set (used while a bench is running).
  async function refreshRuns(followNewest) {
    const runs = await (await fetch("/api/runs")).json();
    if (!runs.length) {
      grid.innerHTML = '<div class="empty">No runs yet — set a limit and hit “run bench”.</div>';
      return null;
    }
    const prev = runSel.value;
    runSel.innerHTML = runs.map((r) => '<option value="' + r.id + '">' + r.id + " · " + r.cases + " cases</option>").join("");
    runSel.value = followNewest || !prev || ![...runSel.options].some((o) => o.value === prev) ? runs[0].id : prev;
    return runs[0].id;
  }

  async function pollBench() {
    const s = await (await fetch("/api/bench/status")).json();
    goBtn.disabled = s.running;
    logEl.style.display = s.running || s.exitCode ? "block" : "none";
    logEl.textContent = s.log.join("\\n");
    logEl.scrollTop = logEl.scrollHeight;
    if (s.running) {
      benchWasRunning = true;
      statusEl.className = "status running";
      await refreshRuns(true);
      const m = await loadRun(runSel.value, true);
      statusEl.textContent = "running… " + (m ? m.cases.length : 0) + "/" + s.total;
      setTimeout(pollBench, 2500);
    } else {
      if (benchWasRunning) {
        // final refresh — the last manifest flush fills in real costs
        benchWasRunning = false;
        await refreshRuns(true);
        await loadRun(runSel.value);
      }
      statusEl.className = s.exitCode ? "status err" : "status";
      statusEl.textContent = s.exitCode == null ? "" : s.exitCode === 0 ? "done ✓" : "failed (exit " + s.exitCode + ")";
    }
  }

  goBtn.onclick = async () => {
    // A run can't start without a stated hypothesis.
    const hypothesis = hypInput.value.trim();
    if (!hypothesis) {
      statusEl.className = "status err";
      statusEl.textContent = "state a hypothesis first";
      hypInput.focus();
      return;
    }
    const limit = limitInput.value ? Number(limitInput.value) : null;
    const res = await fetch("/api/bench", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ limit, hypothesis }),
    });
    if (!res.ok) {
      statusEl.className = "status err";
      statusEl.textContent = (await res.json()).error;
      return;
    }
    hypInput.value = "";  // consumed by this run; the next run needs a fresh one
    pollBench();
  };

  async function init() {
    const s = await (await fetch("/api/bench/status")).json();
    limitInput.placeholder = "all " + s.total;
    runSel.onchange = () => loadRun(runSel.value);
    await refreshRuns(false);
    const wanted = new URLSearchParams(location.search).get("run");
    if (wanted && [...runSel.options].some((o) => o.value === wanted)) runSel.value = wanted;
    if (runSel.value) loadRun(runSel.value);
    pollBench();
  }
  init();
</script>`;

// A read-only leaderboard of every run — cost, time, and quality side by side,
// so you can see whether a change actually moved the needle across runs.
const HISTORY_HTML = `<!doctype html><meta charset="utf-8"><title>Run history</title>
<style>
  body{font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;color:#0f172a;background:#f8fafc}
  header{position:sticky;top:0;background:#fff;border-bottom:1px solid #e2e8f0;padding:14px 24px;display:flex;align-items:center;gap:14px;z-index:1}
  h1{font-size:18px;margin:0} a{color:#2563eb;text-decoration:none} a:hover{text-decoration:underline}
  .wrap{padding:24px}
  table{border-collapse:collapse;width:100%;background:#fff;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden}
  th,td{padding:10px 14px;text-align:left;border-bottom:1px solid #f1f5f9;font-size:13px;white-space:nowrap}
  th{background:#f8fafc;color:#475569;font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.03em}
  tbody tr:last-child td{border-bottom:none} tbody tr:hover{background:#f8fafc}
  td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
  td.best{font-weight:700;color:#0f172a}
  .run{font-weight:600;color:#0f172a} .muted{color:#94a3b8}
  .q{display:inline-block;min-width:34px;text-align:center;padding:2px 8px;border-radius:999px;font-weight:600;font-variant-numeric:tabular-nums}
  .q.na{background:#f1f5f9;color:#94a3b8}
  .rf{margin-top:4px;font-size:11px;font-variant-numeric:tabular-nums;white-space:nowrap}
  .rf span{margin-left:8px} .rf span:first-child{margin-left:0}
  .rf .p{color:#15803d} .rf .r{color:#b45309} .rf .f{color:#b91c1c}
  td.journal{white-space:normal;max-width:340px;font-size:12px;line-height:1.4;color:#334155;vertical-align:top}
  td.journal .jk{color:#64748b;font-weight:600;text-transform:uppercase;font-size:10px;letter-spacing:.03em}
  td.journal .jline{margin:1px 0}
  td.journal .miss{color:#b45309;font-style:italic}
  td.journal details{margin-top:5px} td.journal summary{cursor:pointer;color:#475569;font-weight:600}
  td.journal .rerun{margin-top:4px;padding-left:8px;border-left:2px solid #e2e8f0}
  tr.arch{opacity:.5} tr.arch:hover{opacity:.75}
  button.archbtn{background:#fff;color:#475569;border:1px solid #cbd5e1;border-radius:6px;padding:3px 9px;font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}
  button.archbtn:hover{background:#f1f5f9}
  .toggle{margin-left:auto;display:flex;align-items:center;gap:6px;color:#64748b;font-size:13px;cursor:pointer;user-select:none}
  .empty{padding:48px;color:#64748b}
</style>
<header>
  <h1>Run history</h1>
  <a href="/">← explorer</a>
  <label class="toggle"><input type="checkbox" id="showArch"> show archived <span id="archCount"></span></label>
</header>
<div class="wrap"><div id="root"></div></div>
<script>
  const fmtTime = (ms) => ms == null ? "—" : (ms / 1000).toFixed(1) + "s";
  const fmtCost = (u) => u == null ? "—" : "$" + u.toFixed(4);
  const fmtWhen = (iso, id) => { try { return new Date(iso || id.replace(/-(\\d\\d)-(\\d\\d)-(\\d\\d\\d)Z$/, ":$1:$2.$3Z")).toLocaleString(); } catch { return id; } };
  // Green→amber→red ramp for a 0–5 quality score.
  const qColor = (q) => { const t = Math.max(0, Math.min(1, q / 5)); const h = Math.round(t * 130); return "hsl(" + h + ",70%,42%)"; };
  const esc = (s) => String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");

  const root = document.getElementById("root");
  const showArch = document.getElementById("showArch");
  const archCount = document.getElementById("archCount");
  let allRuns = [];

  function render() {
    if (!allRuns.length) { root.innerHTML = '<div class="empty">No runs yet.</div>'; return; }
    const archivedRuns = allRuns.filter((r) => r.archived);
    archCount.textContent = archivedRuns.length ? "(" + archivedRuns.length + ")" : "";
    const visible = allRuns.filter((r) => showArch.checked || !r.archived);
    if (!visible.length) {
      root.innerHTML = '<div class="empty">Every run is archived — tick “show archived” to see them.</div>';
      return;
    }
    // Best-in-column, so a leader jumps out: lowest latency, lowest cost/case,
    // and (once ratings land) highest pass rate and quality. Only mark a winner when more than
    // one run has the figure — bolding a lone value says nothing. Ties all win.
    // Ranked over active runs only, so an archived run never claims a crown.
    const ranked = allRuns.filter((r) => !r.archived);
    const perCaseVal = (r) => (r.totalCostUsd != null && r.cases ? r.totalCostUsd / r.cases : null);
    const best = (vals, pick) => {
      const nums = vals.filter((v) => v != null);
      return nums.length > 1 ? nums.reduce(pick) : null;
    };
    // Pass rate = passed / (passed+failed) over the cases that actually have a
    // verdict; null until any land. This is the headline number — a run that
    // ships correct diagrams matters more than one that scores prettily.
    const passRateVal = (r) => {
      const v = r.verdicts;
      const n = v ? v.passed + v.failed : 0;
      return n ? v.passed / n : null;
    };
    const bestLatency = best(ranked.map((r) => r.p50LatencyMs), Math.min);
    const bestPerCase = best(ranked.map(perCaseVal), Math.min);
    const bestPassRate = best(ranked.map(passRateVal), Math.max);
    const bestQuality = best(ranked.map((r) => r.quality), Math.max);
    const isBest = (v, b) => b != null && v != null && Math.abs(v - b) < 1e-9;
    const cls = (win) => "num" + (win ? " best" : "");
    // The evaluator's pass/fail tally for the run. Hidden until ratings land.
    const verdictsHtml = (v) => {
      if (!v || (v.passed + v.failed) === 0) return "";
      return '<div class="rf">' +
        '<span class="p" title="evaluator passed these diagrams">' + v.passed + ' pass</span>' +
        '<span class="f" title="evaluator failed these diagrams">' + v.failed + ' fail</span>' +
        '</div>';
    };
    // Legacy tally of the in-generator critique→revise round. Hidden for runs
    // without those outcomes (anything after the loop moved to the evaluator).
    const refHtml = (t) => {
      if (!t || (t.passed + t.revised + t.failed) === 0) return "";
      return '<div class="rf">' +
        '<span class="p" title="critic approved the draft as-is">' + t.passed + ' passed</span>' +
        '<span class="r" title="critic found issues; SVG revised">' + t.revised + ' revised</span>' +
        '<span class="f" title="critique/revision errored; draft kept">' + t.failed + ' failed</span>' +
        '</div>';
    };
    // The experiment journal for a run: its hypothesis and finding, plus any
    // single-case reruns tucked into a details/summary so the row stays compact.
    const line = (k, v, missTxt) => '<div class="jline"><span class="jk">' + k + '</span> ' +
      (v && v.trim() ? esc(v) : '<span class="miss">' + missTxt + '</span>') + '</div>';
    const journalHtml = (entries) => {
      entries = entries || [];
      const run = entries.find((e) => e.id === "run");
      const reruns = entries.filter((e) => e.kind === "rerun");
      if (!run && !reruns.length) return '<span class="muted">—</span>';
      let html = "";
      if (run) html = line("hypothesis", run.hypothesis, "none recorded") + line("finding", run.conclusion, "not recorded yet");
      if (reruns.length) {
        html += '<details><summary>' + reruns.length + ' rerun' + (reruns.length > 1 ? "s" : "") + '</summary>' +
          reruns.map((e) => '<div class="rerun"><div class="jline"><span class="jk">' + esc(e.caseId || "") + '</span></div>' +
            line("hypothesis", e.hypothesis, "none") + line("finding", e.conclusion, "not recorded") + "</div>").join("") +
          '</details>';
      }
      return html;
    };
    const rows = visible.map((r) => {
      const prv = passRateVal(r);
      const pr = (prv == null
        ? '<span class="q na" title="no verdicts yet">—</span>'
        : '<span class="q" style="background:' + qColor(prv * 5) + '22;color:' + qColor(prv * 5) + '" title="' + r.verdicts.passed + ' of ' + (r.verdicts.passed + r.verdicts.failed) + ' passed">' + Math.round(prv * 100) + '%</span>') +
        verdictsHtml(r.verdicts);
      const q = (r.quality == null
        ? '<span class="q na" title="no ratings yet">—</span>'
        : '<span class="q" style="background:' + qColor(r.quality) + '22;color:' + qColor(r.quality) + '" title="' + r.rated + ' of ' + r.cases + ' rated">' + r.quality.toFixed(2) + '</span>') +
        refHtml(r.refine);
      const pc = perCaseVal(r);
      const perCase = pc != null ? fmtCost(pc) : "—";
      const archBtn = '<button class="archbtn" data-id="' + esc(r.id) + '" data-archived="' + !!r.archived + '">' +
        (r.archived ? "unarchive" : "archive") + "</button>";
      return '<tr' + (r.archived ? ' class="arch"' : "") + '>' +
        '<td><a class="run" href="/?run=' + encodeURIComponent(r.id) + '">' + esc(r.id) + '</a>' +
          (r.model ? '<div class="muted">' + esc(r.model) + '</div>' : '') + '</td>' +
        '<td class="muted">' + esc(fmtWhen(r.createdAt, r.id)) + '</td>' +
        '<td class="num">' + r.cases + '</td>' +
        '<td class="' + cls(isBest(r.p50LatencyMs, bestLatency)) + '">' + fmtTime(r.p50LatencyMs) + '</td>' +
        '<td class="' + cls(isBest(pc, bestPerCase)) + '">' + perCase + '</td>' +
        '<td class="' + cls(isBest(prv, bestPassRate)) + '">' + pr + '</td>' +
        '<td class="' + cls(isBest(r.quality, bestQuality)) + '">' + q + '</td>' +
        '<td class="journal">' + journalHtml(r.journal) + '</td>' +
        '<td>' + archBtn + '</td>' +
      '</tr>';
    }).join("");
    root.innerHTML = '<table><thead><tr>' +
      '<th>Run</th><th>When</th>' +
      '<th class="num">Cases</th><th class="num">p50 latency</th>' +
      '<th class="num">Cost / case</th><th class="num">Pass rate</th><th class="num">Quality</th><th>Hypothesis / Finding</th><th></th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table>';
  }

  async function load() {
    allRuns = await (await fetch("/api/history")).json();
    render();
  }

  showArch.addEventListener("change", render);

  // Archive / unarchive from the row button. Optimistically flips the local flag
  // and re-renders; the run's files are untouched on disk either way.
  root.addEventListener("click", async (e) => {
    const btn = e.target.closest(".archbtn");
    if (!btn) return;
    const id = btn.dataset.id;
    const archived = btn.dataset.archived !== "true"; // toggle
    btn.disabled = true;
    const res = await fetch("/api/archive", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: id, archived }),
    }).catch(() => null);
    if (res && res.ok) {
      const r = allRuns.find((x) => x.id === id);
      if (r) r.archived = archived;
      render();
    } else {
      btn.disabled = false;
      alert("Failed to " + (archived ? "archive" : "unarchive") + " run.");
    }
  });

  load();
</script>`;

const handlers = {
  hostname: "0.0.0.0",
  async fetch(req: Request) {
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
      return Response.json(await benchStatus());
    }
    if (url.pathname === "/api/bench" && req.method === "POST") {
      if (bench && bench.exitCode === null) {
        return Response.json({ error: "a benchmark is already running" }, { status: 409 });
      }
      const body = (await req.json().catch(() => ({}))) as { limit?: number | null; hypothesis?: string };
      if (!body.hypothesis?.trim()) {
        return Response.json({ error: "a hypothesis is required to start a run" }, { status: 400 });
      }
      const limit = body.limit && Number.isFinite(body.limit) && body.limit > 0 ? Math.floor(body.limit) : null;
      startBench(limit, body.hypothesis);
      return Response.json({ started: true, limit });
    }
    if (url.pathname.startsWith("/runs/")) {
      const path = resolve(runsDir, decodeURIComponent(url.pathname.slice("/runs/".length)));
      if (!path.startsWith(runsDir)) return new Response("forbidden", { status: 403 });
      const file = Bun.file(path);
      return (await file.exists()) ? new Response(file) : new Response("not found", { status: 404 });
    }
    return new Response("not found", { status: 404 });
  },
};

// Under `bun --hot` this module re-runs on every save. We keep ONE server alive
// across reloads (stashed on globalThis) and just swap in the freshly-evaluated
// handlers — so a browser reload serves the new HTML/JS without the port moving
// out from under you. A cold start binds the real server, walking upward from
// PORT until one is free (so several explorers can run side by side); binding
// the actual server, not a throwaway probe, means success guarantees the port
// is ours. Set PORT to pin the starting point.
declare global {
  var __explorer: Bun.Server | undefined;
}

if (globalThis.__explorer) {
  globalThis.__explorer.reload(handlers);
} else {
  let server: Bun.Server | undefined;
  for (let port = PORT; port < PORT + 100; port++) {
    try {
      server = Bun.serve({ port, ...handlers });
      break;
    } catch (err: any) {
      if (err?.code === "EADDRINUSE") continue;
      throw err;
    }
  }
  if (!server) throw new Error(`no free port in ${PORT}–${PORT + 99}`);
  globalThis.__explorer = server;
  console.log(`explorer → http://0.0.0.0:${server.port} (reachable via Tailscale)`);
}
