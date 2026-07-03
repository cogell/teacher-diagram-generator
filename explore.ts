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
 *
 * All the route/run/notes/ratings logic lives in core.ts (shared with the
 * Cloudflare Worker deployment under worker/); this file provides the local
 * pieces: a filesystem Store over runs/, the child-process benchmark runner,
 * and the Bun server itself.
 */
import { readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeExplorer, parseDataset, type BenchController, type Store } from "./core";

const PORT = Number(process.env.PORT ?? 8000);
const rootDir = fileURLToPath(new URL("./", import.meta.url));
const runsDir = join(rootDir, "runs");

// core.ts validates runId/file segments before they reach the Store, so a
// plain join is safe here.
const fsStore: Store = {
  async listRunIds() {
    return (await readdir(runsDir).catch(() => [] as string[]));
  },
  async readText(runId, file) {
    try {
      return await Bun.file(join(runsDir, runId, file)).text();
    } catch {
      return null;
    }
  },
  async readBytes(runId, file) {
    try {
      return new Uint8Array(await Bun.file(join(runsDir, runId, file)).arrayBuffer());
    } catch {
      return null;
    }
  },
  async write(runId, file, data) {
    await Bun.write(join(runsDir, runId, file), data);
  },
  async remove(runId, file) {
    await unlink(join(runsDir, runId, file)).catch(() => {}); // already gone is fine
  },
  async exists(runId, file) {
    return Bun.file(join(runsDir, runId, file)).exists();
  },
  async serve(runId, file) {
    const f = Bun.file(join(runsDir, runId, file));
    return (await f.exists())
      ? new Response(f, { headers: { "cache-control": "no-store" } })
      : new Response("not found", { status: 404 });
  },
};

const datasetText = () => Bun.file(join(rootDir, "dataset.jsonl")).text().catch(() => "");
const datasetCount = async () => parseDataset(await datasetText()).length;

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

const startBench = (limit: number | null, hypothesis: string, rewrite: "haiku" | "sonnet" | null) => {
  // REWRITE is set or REMOVED explicitly — never inherited — so the header
  // toggle is the single source of truth even when the explorer itself was
  // started with REWRITE in its environment.
  const env: Record<string, string | undefined> = {
    ...process.env,
    ...(limit ? { LIMIT: String(limit) } : {}),
    HYPOTHESIS: hypothesis,
  };
  if (rewrite) env.REWRITE = rewrite;
  else delete env.REWRITE;
  const proc = Bun.spawn(["bun", "benchmark.ts"], {
    cwd: rootDir,
    env,
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

const benchController: BenchController = {
  async status() {
    const total = bench?.limit ?? (await datasetCount());
    return {
      running: bench !== null && bench.exitCode === null,
      limit: bench?.limit ?? null,
      total,
      startedAt: bench?.startedAt ?? null,
      exitCode: bench?.exitCode ?? null,
      log: bench?.log.slice(-15) ?? [],
    };
  },
  async start(limit, hypothesis, rewrite) {
    if (bench && bench.exitCode === null) {
      return Response.json({ error: "a benchmark is already running" }, { status: 409 });
    }
    startBench(limit, hypothesis, rewrite);
    return Response.json({ started: true, limit });
  },
};

const explorer = makeExplorer(fsStore, { datasetText, bench: benchController });

const handlers = {
  hostname: "0.0.0.0",
  fetch: (req: Request) => explorer(req),
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
