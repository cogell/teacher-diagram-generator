/**
 * The explorer UI — the two HTML pages (main grid + run history), extracted
 * verbatim from explore.ts so the Cloudflare Worker (worker/) and the local
 * Bun server (explore.ts) serve the exact same interface. Pure strings, no IO.
 */
export const HTML = `<!doctype html><meta charset="utf-8"><title>Number-line explorer</title>
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
  .brief{font-size:12px;color:#64748b;margin:-4px 0 8px}
  .brief summary{cursor:pointer;user-select:none}
  .brief div{white-space:pre-wrap;padding:6px 8px;margin-top:4px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px}
  .brief pre{white-space:pre-wrap;word-break:break-word;max-height:260px;overflow:auto;background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:6px 8px;margin:4px 0 0;font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;color:#334155}
  .modelsrc{margin-top:6px}
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
    <label for="rewrite" class="summary">rewrite</label>
    <select id="rewrite" title="A pre-pass model rewrites each teacher request into an explicit drawing brief before generation (REWRITE=haiku|sonnet)">
      <option value="none">none</option>
      <option value="haiku">haiku 4.5</option>
      <option value="sonnet">sonnet 5</option>
    </select>
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
  const rewriteSel = document.getElementById("rewrite");
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
      // A benching run rewrites run.json constantly — a torn read parses as
      // garbage. Return null and keep the previous render; next tick catches up.
      fetch("/runs/" + id + "/run.json").then((r) => r.json()).catch(() => null),
      fetch("/runs/" + id + "/notes.json").then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
      fetch("/runs/" + id + "/ratings.json").then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
      fetch("/runs/" + id + "/journal.json").then((r) => (r.ok ? r.json() : { entries: [] })).catch(() => ({ entries: [] })),
    ]);
    if (!m || !Array.isArray(m.cases)) return;
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
      // The drawing brief this case was drawn from (REWRITE pre-pass runs only),
      // collapsed under the original request so the A/B is inspectable per card.
      const rwLabel = { haiku: "haiku 4.5", sonnet: "sonnet 5" }[c.rewriteModel] || "rewrite";
      const brief = c.rewrittenRequest
        ? '<details class="brief"><summary>drawing brief (' + rwLabel + ')</summary><div>' +
          esc(c.rewrittenRequest) + "</div></details>"
        : "";
      // What the model actually wrote, before any of our SVG layers touched it:
      // the JSON spec on the template path (via "spec"), the raw pre-prepareSvg
      // SVG on the direct path, and the persisted raw replies for failed
      // attempts. Panels lazy-load on first open; runs older than source
      // persistence just report the file as not stored.
      const srcs = [];
      if (c.via === "spec") {
        srcs.push({ file: c.id + ".spec.json", label: "model output — JSON spec" });
        srcs.push({ file: c.id + ".svg", label: "rendered template SVG (pre-cleanup)" });
      } else if (c.image) {
        srcs.push({ file: c.id + ".svg", label: "model output — raw SVG (pre-cleanup)" });
      }
      (c.attempts || []).forEach((a, i) => {
        if (a.draft) srcs.push({ file: a.draft, label: "failed attempt " + (i + 1) + " — raw reply" });
      });
      const modelSrc = srcs.map((s) =>
        '<details class="brief modelsrc" data-file="' + esc(s.file) + bust + '"><summary>' +
        s.label + "</summary><pre>loading…</pre></details>").join("");
      return '<div class="card" data-case="' + esc(c.id) + '"><div class="hd">' + idEl +
        badge +
        '<span class="meta">' + (c.latencyMs / 1000).toFixed(1) + "s · $" + c.costUsd.toFixed(4) + "</span>" + evalBtn + "</div>" +
        '<div class="req">' + esc(c.request) + "</div>" + brief + img + modelSrc +
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

  // Lazy-load a model-output panel the first time it's opened. (The 'toggle'
  // event doesn't bubble, so listen for clicks on the summary instead.) A
  // bench-driven grid rebuild resets the panel to collapsed + unloaded, which
  // is fine — reopening just fetches again.
  grid.addEventListener("click", async (e) => {
    const sum = e.target.closest(".modelsrc > summary");
    if (!sum) return;
    const det = sum.parentElement;
    if (det.dataset.loaded) return;
    det.dataset.loaded = "1";
    const pre = det.querySelector("pre");
    try {
      const res = await fetch("/runs/" + runSel.value + "/" + det.dataset.file);
      pre.textContent = res.ok
        ? await res.text()
        : "not stored for this run (runs from before source persistence don\\u2019t have it)";
    } catch (err) {
      pre.textContent = "failed to load: " + String((err && err.message) || err);
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
    // One flaky tick must never kill the poll loop: the benchmark rewrites
    // run.json after every case, so a fetch can catch it mid-write and fail to
    // parse — swallow it and let the next tick catch up. (This exact failure
    // used to end the loop, freezing the status at a stale "running… N/M".)
    let s;
    try {
      s = await (await fetch("/api/bench/status")).json();
    } catch {
      setTimeout(pollBench, 2500);
      return;
    }
    goBtn.disabled = s.running;
    logEl.style.display = s.running || s.exitCode ? "block" : "none";
    logEl.textContent = s.log.join("\\n");
    logEl.scrollTop = logEl.scrollHeight;
    if (s.running) {
      benchWasRunning = true;
      statusEl.className = "status running";
      try {
        await refreshRuns(true);
        const m = await loadRun(runSel.value, true);
        const n = m ? m.cases.length : 0;
        // Generation done but the process still alive = the post-run tail:
        // waiting out background evals, then the cost lookup. Say so instead
        // of an eternal "running… 30/30".
        statusEl.textContent = (m && n >= s.total ? "finishing (evals & costs)… " : "running… ") +
          n + "/" + s.total;
      } catch {
        // stale tick — leave the previous render in place
      }
      setTimeout(pollBench, 2500);
    } else {
      if (benchWasRunning) {
        // final refresh — the last manifest flush fills in real costs
        benchWasRunning = false;
        try {
          await refreshRuns(true);
          await loadRun(runSel.value);
        } catch { /* the 2.5s eval poll or a reload will catch up */ }
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
      body: JSON.stringify({ limit, hypothesis, rewrite: rewriteSel.value }),
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
export const HISTORY_HTML = `<!doctype html><meta charset="utf-8"><title>Run history</title>
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
  .rw{display:inline-block;margin-left:6px;padding:0 7px;border-radius:999px;font-size:11px;font-weight:600;background:#ede9fe;color:#6d28d9;vertical-align:1px}
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
  tbody tr.hl>td{background:#eff6ff;box-shadow:inset 3px 0 0 #2563eb}
  button.archbtn{background:#fff;color:#475569;border:1px solid #cbd5e1;border-radius:6px;padding:3px 9px;font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}
  button.archbtn:hover{background:#f1f5f9}
  .toggle{margin-left:auto;display:flex;align-items:center;gap:6px;color:#64748b;font-size:13px;cursor:pointer;user-select:none}
  .empty{padding:48px;color:#64748b}
  .panel{background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:16px 18px 12px;margin-bottom:18px}
  .panel h2{font-size:12px;text-transform:uppercase;letter-spacing:.03em;color:#475569;font-weight:600;margin:0 0 2px}
  .panel .sub{color:#94a3b8;font-size:12px;margin:0 0 6px}
  .panel svg{display:block;width:100%;height:auto;overflow:visible}
  .grid{stroke:#f1f5f9} .axis{stroke:#cbd5e1} .tick{fill:#94a3b8;font-size:11px}
  .axlabel{fill:#64748b;font-size:11px;font-weight:600}
  circle.dot{cursor:pointer;stroke:#fff;stroke-width:1.5;transition:stroke .1s}
  circle.dot:hover{stroke:#0f172a;stroke-width:2}
  circle.dot.arch{opacity:.3}
  .legend{display:flex;gap:18px;align-items:center;margin-top:6px;font-size:11px;color:#64748b;flex-wrap:wrap}
  .legend b{color:#475569;font-weight:600} .legend .sz{display:inline-flex;align-items:center;gap:5px}
  .legend .sz i{display:inline-block;border-radius:50%;background:#cbd5e1;border:1px solid #94a3b8}
  .noplot{color:#b45309;font-size:11px;margin-top:6px}
  .tip{position:fixed;pointer-events:none;z-index:10;background:#0f172a;color:#fff;padding:8px 10px;border-radius:8px;font-size:12px;line-height:1.45;max-width:280px;opacity:0;transition:opacity .08s;box-shadow:0 6px 20px rgba(15,23,42,.28)}
  .tip.show{opacity:1}
  .tip .th{font-weight:700} .tip .tm{color:#94a3b8;font-size:11px;margin-bottom:3px}
  .tip .tr{display:flex;justify-content:space-between;gap:14px} .tip .tr span:last-child{font-variant-numeric:tabular-nums}
  .tip .thyp{margin-top:5px;padding-top:5px;border-top:1px solid #334155;color:#cbd5e1;font-style:italic}
</style>
<header>
  <h1>Run history</h1>
  <a href="/">← explorer</a>
  <label class="toggle"><input type="checkbox" id="showArch"> show archived <span id="archCount"></span></label>
</header>
<div class="wrap"><div id="chart"></div><div id="root"></div></div>
<div class="tip" id="tip"></div>
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
      const rw = r.rewrite
        ? '<span class="rw" title="generated from drawing briefs written by a ' + esc(r.rewrite) +
          ' pre-pass (REWRITE=' + esc(r.rewrite) + ')">rewrite · ' +
          ({ haiku: "haiku 4.5", sonnet: "sonnet 5" }[r.rewrite] || esc(r.rewrite)) + '</span>'
        : "";
      return '<tr data-run="' + esc(r.id) + '"' + (r.archived ? ' class="arch"' : "") + '>' +
        '<td><a class="run" href="/?run=' + encodeURIComponent(r.id) + '">' + esc(r.id) + '</a>' + rw +
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
    renderChart(visible);
  }

  // ---- trade-off scatter -----------------------------------------------------
  // One dot per run: x = cost/case, y = pass rate, dot size = p50 latency.
  // Both axes point "toward better" (cheaper toward the left, higher pass rate
  // up), so the strong runs cluster top-left and the Pareto frontier reads by
  // eye. Reuses the table's green→amber→red ramp so a dot and its row agree.
  // chartPts is the last-rendered plot set, keyed by index for the tooltip.
  const tip = document.getElementById("tip");
  let chartPts = [];
  const fmtPct = (p) => Math.round(p * 100) + "%";

  function renderChart(visible) {
    const chart = document.getElementById("chart");
    const pts = visible.map((r) => {
      const v = r.verdicts;
      const n = v ? v.passed + v.failed : 0;
      const pr = n ? v.passed / n : null;
      const pc = (r.totalCostUsd != null && r.cases) ? r.totalCostUsd / r.cases : null;
      const runEntry = (r.journal || []).find((e) => e.id === "run");
      return { r, pr, pc, lat: r.p50LatencyMs, hyp: runEntry ? runEntry.hypothesis : null, passed: v ? v.passed : 0, total: n };
    });
    // Full-dataset runs only: partial LIMIT samples (6, 10, … cases) aren't
    // comparable on cost or pass rate, so they'd just be noise. A plotted run
    // also needs a verdict (y) and a cost (x).
    const FULL_CASES = 30;
    const plot = pts.filter((p) => p.r.cases === FULL_CASES && p.pr != null && p.pc != null);
    chartPts = plot;
    const skipped = pts.length - plot.length;
    const noplot = skipped
      ? '<div class="noplot">' + skipped + ' run' + (skipped > 1 ? "s" : "") + ' hidden — only full ' + FULL_CASES + '-case runs with a verdict and cost are plotted.</div>'
      : "";
    if (!plot.length) {
      chart.innerHTML = '<div class="panel"><h2>Cost vs. pass rate</h2>' +
        '<div class="sub">Nothing to plot yet — needs a full ' + FULL_CASES + '-case run with a verdict and a recorded cost.</div>' + noplot + '</div>';
      return;
    }

    const W = 760, H = 380, mL = 54, mR = 22, mT = 16, mB = 46;
    const pw = W - mL - mR, ph = H - mT - mB;
    // Cost axis starts at 0 (an absolute floor for cost/case) and pads the top.
    const xMax = Math.max(...plot.map((p) => p.pc)) * 1.1 || 1;
    const xOf = (c) => mL + (c / xMax) * pw;
    const yOf = (pr) => mT + (1 - pr) * ph; // pr 0..1, higher = up
    // Latency → radius. Bigger dot = slower run (noted in the legend). Falls
    // back to a mid radius when a run has no latency figure.
    const lats = plot.map((p) => p.lat).filter((l) => l != null);
    const latMin = lats.length ? Math.min(...lats) : 0;
    const latMax = lats.length ? Math.max(...lats) : 1;
    const rOf = (lat) => { if (lat == null) return 6; if (latMax === latMin) return 9; return 5 + ((lat - latMin) / (latMax - latMin)) * 10; };

    let svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Cost per case versus pass rate for each run">';
    // Horizontal gridlines + pass-rate ticks at every 25%.
    for (let i = 0; i <= 4; i++) {
      const pr = i / 4, y = yOf(pr);
      svg += '<line class="grid" x1="' + mL + '" y1="' + y + '" x2="' + (W - mR) + '" y2="' + y + '"/>' +
        '<text class="tick" x="' + (mL - 8) + '" y="' + (y + 4) + '" text-anchor="end">' + fmtPct(pr) + '</text>';
    }
    // Cost ticks along the bottom.
    for (let i = 0; i <= 4; i++) {
      const c = (xMax * i) / 4, x = xOf(c);
      svg += '<line class="grid" x1="' + x + '" y1="' + mT + '" x2="' + x + '" y2="' + (mT + ph) + '"/>' +
        '<text class="tick" x="' + x + '" y="' + (mT + ph + 18) + '" text-anchor="middle">' + fmtCost(c) + '</text>';
    }
    // Axes.
    svg += '<line class="axis" x1="' + mL + '" y1="' + mT + '" x2="' + mL + '" y2="' + (mT + ph) + '"/>' +
      '<line class="axis" x1="' + mL + '" y1="' + (mT + ph) + '" x2="' + (W - mR) + '" y2="' + (mT + ph) + '"/>' +
      '<text class="axlabel" x="' + (mL + pw / 2) + '" y="' + (H - 6) + '" text-anchor="middle">cost / case →</text>' +
      '<text class="axlabel" transform="translate(14,' + (mT + ph / 2) + ') rotate(-90)" text-anchor="middle">pass rate →</text>';
    // Dots, largest first so small fast runs sit on top and stay hoverable.
    plot.map((p, i) => ({ p, i })).sort((a, b) => rOf(b.p.lat) - rOf(a.p.lat)).forEach(({ p, i }) => {
      const color = qColor(p.pr * 5);
      svg += '<a href="/?run=' + encodeURIComponent(p.r.id) + '">' +
        '<circle class="dot' + (p.r.archived ? ' arch' : '') + '" data-i="' + i + '" ' +
        'cx="' + xOf(p.pc).toFixed(1) + '" cy="' + yOf(p.pr).toFixed(1) + '" r="' + rOf(p.lat).toFixed(1) + '" ' +
        'fill="' + color + '" fill-opacity="0.75"/></a>';
    });
    svg += '</svg>';

    const legend = '<div class="legend">' +
      '<span><b>y</b> pass rate &nbsp; <b>x</b> cost / case</span>' +
      '<span class="sz"><b>size</b> p50 latency' +
      '<i style="width:8px;height:8px"></i>fast<i style="width:18px;height:18px"></i>slow</span>' +
      '<span>top-left = better</span>' +
      '<span>full ' + FULL_CASES + '-case runs only</span></div>';

    chart.innerHTML = '<div class="panel"><h2>Cost vs. pass rate</h2>' +
      '<div class="sub">Each run placed by cost and pass rate; dot size is p50 latency. Click a dot to open the run.</div>' +
      svg + legend + noplot + '</div>';
  }

  // Highlight (and clear) the table row for a run id — links a hovered dot to
  // its row in the list below.
  const highlightRow = (id) => {
    root.querySelectorAll("tr.hl").forEach((tr) => tr.classList.remove("hl"));
    if (!id) return;
    const row = [...root.querySelectorAll("tr[data-run]")].find((tr) => tr.dataset.run === id);
    if (row) row.classList.add("hl");
  };

  // Shared tooltip, driven by the dot's data-i index into chartPts.
  const chartEl = document.getElementById("chart");
  chartEl.addEventListener("mouseover", (e) => {
    const dot = e.target.closest("circle.dot");
    if (!dot) return;
    const p = chartPts[+dot.dataset.i];
    if (!p) return;
    tip.innerHTML = '<div class="th">' + esc(p.r.id) + '</div>' +
      (p.r.model ? '<div class="tm">' + esc(p.r.model) + '</div>' : '') +
      '<div class="tr"><span>pass rate</span><span>' + fmtPct(p.pr) + ' (' + p.passed + '/' + p.total + ')</span></div>' +
      '<div class="tr"><span>cost / case</span><span>' + fmtCost(p.pc) + '</span></div>' +
      '<div class="tr"><span>p50 latency</span><span>' + fmtTime(p.lat) + '</span></div>' +
      (p.hyp && p.hyp.trim() ? '<div class="thyp">' + esc(p.hyp) + '</div>' : '');
    tip.classList.add("show");
    highlightRow(p.r.id);
  });
  chartEl.addEventListener("mousemove", (e) => {
    if (!tip.classList.contains("show")) return;
    // Keep the tip near the cursor but clamped inside the viewport.
    const pad = 14, w = tip.offsetWidth, h = tip.offsetHeight;
    let x = e.clientX + pad, y = e.clientY + pad;
    if (x + w > window.innerWidth - 4) x = e.clientX - pad - w;
    if (y + h > window.innerHeight - 4) y = e.clientY - pad - h;
    tip.style.left = x + "px";
    tip.style.top = y + "px";
  });
  chartEl.addEventListener("mouseout", (e) => {
    if (e.target.closest("circle.dot")) { tip.classList.remove("show"); highlightRow(null); }
  });

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
