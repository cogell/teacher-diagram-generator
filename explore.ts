/**
 * The explorer — a tiny local viewer for browsing benchmark runs.
 *
 *   bun run explore        # then open http://localhost:8000
 *
 * Pick a run from the dropdown to see every diagram it produced, with its
 * latency and cost. You can also fire off new benchmark runs from the header:
 * set a case limit (or leave blank for all) and hit “run bench” — the grid
 * fills in live as cases complete. There are no verdicts — judging what's
 * right or wrong is up to you.
 */
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
      const m = JSON.parse(await Bun.file(join(runsDir, id, "run.json")).text());
      runs.push({ id, model: m.model, cases: m.cases.length });
    } catch {
      // skip incomplete runs
    }
  }
  return runs;
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
// One ratings.json per run dir, mapping case id → { score, note, updatedAt }.
// Ratings aren't produced yet — this is the storage + read path they'll land in.
// `score` is the quantitative axis (0–5); `note` is the qualitative axis. Quality
// for a run is the mean of its numeric scores, so the file can stay empty (or
// partially filled) and everything downstream still renders.
const ratingsFile = (runId: string) => {
  const dir = resolve(runsDir, runId);
  if (!dir.startsWith(runsDir) || runId.includes("/") || runId.includes("..")) return null;
  return join(dir, "ratings.json");
};

const readRatings = async (
  runId: string,
): Promise<Record<string, { score?: number; note?: string; updatedAt: string }>> => {
  const file = ratingsFile(runId);
  if (!file) return {};
  try {
    return JSON.parse(await Bun.file(file).text());
  } catch {
    return {};
  }
};

// Mean of the numeric scores in a run's ratings, or null if nothing is rated.
const qualityOf = (ratings: Record<string, { score?: number }>) => {
  const scores = Object.values(ratings)
    .map((r) => r.score)
    .filter((s): s is number => typeof s === "number" && Number.isFinite(s));
  if (!scores.length) return { avg: null as number | null, rated: 0 };
  return { avg: scores.reduce((a, b) => a + b, 0) / scores.length, rated: scores.length };
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
      const { avg, rated } = qualityOf(await readRatings(id));
      rows.push({
        id,
        model: m.model ?? null,
        createdAt: m.createdAt ?? null,
        cases: m.cases.length,
        p50LatencyMs: m.p50LatencyMs ?? null,
        totalCostUsd: m.totalCostUsd ?? null,
        quality: avg,
        rated,
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
let bench: BenchState | null = null;

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

const startBench = (limit: number | null) => {
  const proc = Bun.spawn(["bun", "benchmark.ts"], {
    cwd: rootDir,
    env: { ...process.env, ...(limit ? { LIMIT: String(limit) } : {}) },
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
  .id{font-weight:700;font-size:12px;color:#475569} .meta{margin-left:auto;color:#64748b;font-size:12px}
  .req{font-size:13px;color:#334155;margin-bottom:8px}
  img,.noimg{width:100%;border:1px solid #f1f5f9;border-radius:6px;background:#fff}
  .noimg{display:flex;align-items:center;justify-content:center;min-height:120px;color:#94a3b8;font-size:12px;padding:8px;text-align:center}
  textarea.note{width:100%;box-sizing:border-box;margin-top:8px;padding:6px 8px;border:1px solid #e2e8f0;border-radius:6px;font:12px/1.4 inherit;color:#334155;resize:vertical;min-height:34px}
  textarea.note::placeholder{color:#cbd5e1}
  .notehd{display:flex;align-items:center;margin-top:2px;min-height:14px}
  .saved{margin-left:auto;font-size:11px;color:#16a34a;opacity:0;transition:opacity .3s} .saved.show{opacity:1}
  .empty{padding:48px;color:#64748b}
  pre#log{margin:0 24px;padding:10px 12px;background:#0f172a;color:#cbd5e1;font-size:12px;border-radius:8px;max-height:180px;overflow:auto;display:none}
</style>
<header>
  <h1>Number-line explorer</h1>
  <a href="/history" class="summary" style="text-decoration:none">history →</a>
  <select id="run"></select>
  <span id="summary" class="summary"></span>
  <span style="margin-left:auto;display:flex;align-items:center;gap:8px">
    <label for="limit" class="summary">limit</label>
    <input id="limit" type="number" min="1" placeholder="all">
    <button id="go">run bench</button>
    <span id="status" class="status"></span>
  </span>
</header>
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
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  let benchWasRunning = false;

  async function loadRun(id) {
    if (!id) return;
    // Don't re-render (live polling) while a note is being typed — it would
    // destroy the textarea under the cursor. The next tick catches up.
    if (document.activeElement && document.activeElement.classList.contains("note")) return;
    const [m, notes] = await Promise.all([
      (await fetch("/runs/" + id + "/run.json")).json(),
      fetch("/runs/" + id + "/notes.json").then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
    ]);
    summary.textContent = (m.model ? m.model + " · " : "") + m.cases.length + " cases · p50 " +
      (m.p50LatencyMs / 1000).toFixed(1) + "s · $" + m.totalCostUsd.toFixed(4) + " total";
    grid.innerHTML = m.cases.map((c) => {
      const img = c.image
        ? '<img src="/runs/' + id + "/" + c.image + '">'
        : '<div class="noimg">' + esc(c.error || "no render") + "</div>";
      const note = notes[c.id] ? notes[c.id].text : "";
      return '<div class="card"><div class="hd"><span class="id">' + esc(c.id) + '</span>' +
        '<span class="meta">' + (c.latencyMs / 1000).toFixed(1) + "s · $" + c.costUsd.toFixed(4) + "</span></div>" +
        '<div class="req">' + esc(c.request) + "</div>" + img +
        '<textarea class="note" data-case="' + esc(c.id) + '" placeholder="notes — what\\u2019s wrong / right with this one?">' + esc(note) + "</textarea>" +
        '<div class="notehd"><span class="saved">saved ✓</span></div></div>';
    }).join("") || '<div class="empty">Run starting…</div>';
    return m;
  }

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
      const m = await loadRun(runSel.value);
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
    const limit = limitInput.value ? Number(limitInput.value) : null;
    const res = await fetch("/api/bench", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ limit }),
    });
    if (!res.ok) {
      statusEl.className = "status err";
      statusEl.textContent = (await res.json()).error;
      return;
    }
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
  .run{font-weight:600;color:#0f172a} .muted{color:#94a3b8}
  .q{display:inline-block;min-width:34px;text-align:center;padding:2px 8px;border-radius:999px;font-weight:600;font-variant-numeric:tabular-nums}
  .q.na{background:#f1f5f9;color:#94a3b8}
  .empty{padding:48px;color:#64748b}
</style>
<header>
  <h1>Run history</h1>
  <a href="/">← explorer</a>
</header>
<div class="wrap"><div id="root"></div></div>
<script>
  const fmtTime = (ms) => ms == null ? "—" : (ms / 1000).toFixed(1) + "s";
  const fmtCost = (u) => u == null ? "—" : "$" + u.toFixed(4);
  const fmtWhen = (iso, id) => { try { return new Date(iso || id.replace(/-(\\d\\d)-(\\d\\d)-(\\d\\d\\d)Z$/, ":$1:$2.$3Z")).toLocaleString(); } catch { return id; } };
  // Green→amber→red ramp for a 0–5 quality score.
  const qColor = (q) => { const t = Math.max(0, Math.min(1, q / 5)); const h = Math.round(t * 130); return "hsl(" + h + ",70%,42%)"; };
  const esc = (s) => String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");

  async function load() {
    const runs = await (await fetch("/api/history")).json();
    const root = document.getElementById("root");
    if (!runs.length) { root.innerHTML = '<div class="empty">No runs yet.</div>'; return; }
    const rows = runs.map((r) => {
      const q = r.quality == null
        ? '<span class="q na" title="no ratings yet">—</span>'
        : '<span class="q" style="background:' + qColor(r.quality) + '22;color:' + qColor(r.quality) + '" title="' + r.rated + ' of ' + r.cases + ' rated">' + r.quality.toFixed(2) + '</span>';
      const perCase = r.totalCostUsd != null && r.cases ? fmtCost(r.totalCostUsd / r.cases) : "—";
      return '<tr>' +
        '<td><a class="run" href="/?run=' + encodeURIComponent(r.id) + '">' + esc(r.id) + '</a>' +
          (r.model ? '<div class="muted">' + esc(r.model) + '</div>' : '') + '</td>' +
        '<td class="muted">' + esc(fmtWhen(r.createdAt, r.id)) + '</td>' +
        '<td class="num">' + r.cases + '</td>' +
        '<td class="num">' + fmtTime(r.p50LatencyMs) + '</td>' +
        '<td class="num">' + fmtCost(r.totalCostUsd) + '</td>' +
        '<td class="num">' + perCase + '</td>' +
        '<td class="num">' + q + '</td>' +
      '</tr>';
    }).join("");
    root.innerHTML = '<table><thead><tr>' +
      '<th>Run</th><th>When</th>' +
      '<th class="num">Cases</th><th class="num">p50 latency</th><th class="num">Total cost</th>' +
      '<th class="num">Cost / case</th><th class="num">Quality</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table>';
  }
  load();
</script>`;

// Find a free port starting at PORT, walking upward — so several explorers
// can run side by side. Set PORT to pin the starting point.
let port = PORT;
for (; port < PORT + 100; port++) {
  try {
    Bun.serve({ port, fetch: () => new Response() }).stop(true);
    break;
  } catch (err: any) {
    if (err?.code === "EADDRINUSE") continue;
    throw err;
  }
}

Bun.serve({
  port,
  hostname: "0.0.0.0",
  async fetch(req) {
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
    if (url.pathname === "/api/bench/status") {
      return Response.json(await benchStatus());
    }
    if (url.pathname === "/api/bench" && req.method === "POST") {
      if (bench && bench.exitCode === null) {
        return Response.json({ error: "a benchmark is already running" }, { status: 409 });
      }
      const body = (await req.json().catch(() => ({}))) as { limit?: number | null };
      const limit = body.limit && Number.isFinite(body.limit) && body.limit > 0 ? Math.floor(body.limit) : null;
      startBench(limit);
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
});

console.log(`explorer → http://0.0.0.0:${port} (reachable via Tailscale)`);
