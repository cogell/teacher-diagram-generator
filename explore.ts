/**
 * The explorer — a tiny local viewer for browsing benchmark runs.
 *
 *   bun run explore        # then open http://localhost:8000
 *
 * Pick a run from the dropdown to see every diagram it produced, with its
 * latency and cost. Run the benchmark a few times as you iterate, then compare.
 * There are no verdicts — judging what's right or wrong is up to you.
 */
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const PORT = Number(process.env.PORT ?? 8000);
const runsDir = new URL("./runs/", import.meta.url).pathname;

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

const HTML = `<!doctype html><meta charset="utf-8"><title>Number-line explorer</title>
<style>
  body{font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;color:#0f172a;background:#f8fafc}
  header{position:sticky;top:0;background:#fff;border-bottom:1px solid #e2e8f0;padding:14px 24px;display:flex;align-items:center;gap:14px;flex-wrap:wrap}
  h1{font-size:18px;margin:0} select{font:inherit;padding:5px 8px;border:1px solid #cbd5e1;border-radius:6px}
  .summary{color:#64748b;font-size:13px}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:16px;padding:24px}
  .card{background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:12px}
  .hd{display:flex;align-items:center;gap:8px;margin-bottom:6px}
  .id{font-weight:700;font-size:12px;color:#475569} .meta{margin-left:auto;color:#64748b;font-size:12px}
  .req{font-size:13px;color:#334155;margin-bottom:8px}
  img,.noimg{width:100%;border:1px solid #f1f5f9;border-radius:6px;background:#fff}
  .noimg{display:flex;align-items:center;justify-content:center;min-height:120px;color:#94a3b8;font-size:12px;padding:8px;text-align:center}
  .empty{padding:48px;color:#64748b}
</style>
<header>
  <h1>Number-line explorer</h1>
  <select id="run"></select>
  <span id="summary" class="summary"></span>
</header>
<div id="grid" class="grid"></div>
<script>
  const grid = document.getElementById("grid");
  const runSel = document.getElementById("run");
  const summary = document.getElementById("summary");
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  async function loadRun(id) {
    const m = await (await fetch("/runs/" + id + "/run.json")).json();
    summary.textContent = m.model + " · p50 " + (m.p50LatencyMs / 1000).toFixed(1) + "s · $" + m.totalCostUsd.toFixed(4) + " total";
    grid.innerHTML = m.cases.map((c) => {
      const img = c.image
        ? '<img src="/runs/' + id + "/" + c.image + '">'
        : '<div class="noimg">' + esc(c.error || "no render") + "</div>";
      return '<div class="card"><div class="hd"><span class="id">' + esc(c.id) + '</span>' +
        '<span class="meta">' + (c.latencyMs / 1000).toFixed(1) + "s · $" + c.costUsd.toFixed(4) + "</span></div>" +
        '<div class="req">' + esc(c.request) + "</div>" + img + "</div>";
    }).join("");
  }

  async function init() {
    const runs = await (await fetch("/api/runs")).json();
    if (!runs.length) {
      grid.innerHTML = '<div class="empty">No runs yet — run <code>bun run bench</code>, then reload.</div>';
      return;
    }
    runSel.innerHTML = runs.map((r) => '<option value="' + r.id + '">' + r.id + " · " + r.cases + " cases</option>").join("");
    runSel.onchange = () => loadRun(runSel.value);
    loadRun(runs[0].id);
  }
  init();
</script>`;

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/") {
      return new Response(HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (url.pathname === "/api/runs") {
      return Response.json(await listRuns());
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

console.log(`explorer → http://localhost:${PORT}`);
