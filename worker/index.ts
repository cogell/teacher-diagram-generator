/**
 * The deployed explorer — the same UI and API as `bun run explore`, running on
 * a Cloudflare Worker with runs stored in R2 and the whole site behind a
 * shared password (SITE_PASSWORD secret).
 *
 * Auth: POST /login compares the submitted password against SITE_PASSWORD
 * (via HMAC digests, so the comparison is constant-time and leaks no length)
 * and sets an HttpOnly session cookie whose value is itself an HMAC derived
 * from the secret — no session storage needed, rotating the secret revokes
 * every session. Everything else requires the cookie: pages redirect to
 * /login, API calls get a 401.
 *
 * One extra route the local explorer doesn't have: PUT /api/blob/runs/... —
 * Bearer-authenticated raw uploads, used by scripts/seed-runs.ts to copy the
 * local runs/ directory into the bucket.
 */
import process from "node:process";
import { makeExplorer, safeSegment, type Store } from "../core";
import { makeWorkerBench } from "./bench";
import { configureResvg } from "./resvg-shim";
import resvgWasm from "@resvg/resvg-wasm/index_bg.wasm";
import fontSans from "./fonts/DejaVuSans.ttf";
import fontSansBold from "./fonts/DejaVuSans-Bold.ttf";
import datasetJsonl from "../dataset.jsonl";

interface Env {
  RUNS: R2Bucket;
  OPENROUTER_API_KEY: string;
  SITE_PASSWORD: string;
}

// ---- R2-backed Store ----------------------------------------------------------
const key = (runId: string, file: string) => `runs/${runId}/${file}`;

const CONTENT_TYPES: Record<string, string> = {
  png: "image/png",
  json: "application/json",
  svg: "image/svg+xml",
  txt: "text/plain; charset=utf-8",
};
const contentType = (file: string) =>
  CONTENT_TYPES[file.split(".").pop() ?? ""] ?? "application/octet-stream";

const r2Store = (bucket: R2Bucket): Store => ({
  async listRunIds() {
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const res = await bucket.list({ prefix: "runs/", delimiter: "/", cursor });
      for (const p of res.delimitedPrefixes) ids.push(p.slice("runs/".length).replace(/\/$/, ""));
      cursor = res.truncated ? res.cursor : undefined;
    } while (cursor);
    return ids;
  },
  async readText(runId, file) {
    const o = await bucket.get(key(runId, file));
    return o ? o.text() : null;
  },
  async readBytes(runId, file) {
    const o = await bucket.get(key(runId, file));
    return o ? new Uint8Array(await o.arrayBuffer()) : null;
  },
  async write(runId, file, data) {
    await bucket.put(key(runId, file), data);
  },
  async remove(runId, file) {
    await bucket.delete(key(runId, file));
  },
  async exists(runId, file) {
    return (await bucket.head(key(runId, file))) !== null;
  },
  async serve(runId, file) {
    const o = await bucket.get(key(runId, file));
    if (!o) return new Response("not found", { status: 404 });
    // no-store: run.json mutates while a bench runs, and PNGs share names
    // across reruns (the UI cache-busts with a query param regardless).
    return new Response(o.body, {
      headers: { "content-type": contentType(file), "cache-control": "no-store" },
    });
  },
});

// ---- password gate --------------------------------------------------------------
const COOKIE = "explorer_session";
const enc = new TextEncoder();

const hmacHex = async (secret: string, message: string) => {
  const k = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", k, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

// The session token is deterministic per secret — no storage, and rotating
// SITE_PASSWORD invalidates every outstanding cookie.
const sessionToken = (password: string) => hmacHex(password, "coteach-explorer-session-v1");

// Compare via same-length hex digests so neither timing nor length leaks.
const constantTimeEqHex = (a: string, b: string) => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

const passwordMatches = async (submitted: string, actual: string) =>
  constantTimeEqHex(
    await hmacHex("coteach-explorer-pwcheck", submitted),
    await hmacHex("coteach-explorer-pwcheck", actual),
  );

const cookieValue = (req: Request, name: string) => {
  const header = req.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return null;
};

const isAuthed = async (req: Request, env: Env) => {
  const got = cookieValue(req, COOKIE);
  return got !== null && constantTimeEqHex(got, await sessionToken(env.SITE_PASSWORD));
};

const LOGIN_HTML = (error: string | null) => `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Number-line explorer — sign in</title>
<style>
  body{font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;color:#0f172a;background:#f8fafc;display:grid;place-items:center;min-height:100vh}
  form{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:28px 30px;width:300px;box-shadow:0 4px 24px rgba(15,23,42,.06)}
  h1{font-size:16px;margin:0 0 4px} p{margin:0 0 14px;color:#64748b;font-size:13px}
  input{font:inherit;width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #cbd5e1;border-radius:8px;margin-bottom:10px}
  button{font:inherit;width:100%;padding:8px 10px;border:1px solid #0f172a;border-radius:8px;background:#0f172a;color:#fff;cursor:pointer}
  .err{color:#dc2626;font-size:13px;margin:0 0 10px}
</style>
<form method="post" action="/login">
  <h1>Number-line explorer</h1>
  <p>Enter the password to continue.</p>
  ${error ? `<div class="err">${error}</div>` : ""}
  <input type="password" name="password" placeholder="password" autofocus autocomplete="current-password">
  <button>sign in</button>
</form>`;

const loginPage = (error: string | null = null, status = 200) =>
  new Response(LOGIN_HTML(error), {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });

const handleLogin = async (req: Request, env: Env, url: URL): Promise<Response> => {
  if (req.method !== "POST") return loginPage();
  const form = await req.formData().catch(() => null);
  const submitted = String(form?.get("password") ?? "");
  if (!submitted || !(await passwordMatches(submitted, env.SITE_PASSWORD))) {
    return loginPage("Wrong password.", 401);
  }
  const token = await sessionToken(env.SITE_PASSWORD);
  return new Response(null, {
    status: 302,
    headers: {
      location: new URL("/", url).toString(),
      "set-cookie": `${COOKIE}=${token}; Max-Age=2592000; Path=/; HttpOnly; Secure; SameSite=Lax`,
    },
  });
};

// ---- seeding: Bearer-authenticated raw upload -----------------------------------
// PUT /api/blob/runs/<runId>/<file> with `authorization: Bearer <SITE_PASSWORD>`.
// Used by scripts/seed-runs.ts to copy the local runs/ directory into R2.
const handleBlobPut = async (req: Request, env: Env, url: URL): Promise<Response> => {
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
  if (!token || !(await passwordMatches(token, env.SITE_PASSWORD))) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const parts = url.pathname.slice("/api/blob/".length).split("/").map(decodeURIComponent);
  if (parts.length !== 3 || parts[0] !== "runs" || !safeSegment(parts[1]) || !safeSegment(parts[2])) {
    return Response.json({ error: "expected /api/blob/runs/<runId>/<file>" }, { status: 400 });
  }
  await env.RUNS.put(parts.join("/"), await req.arrayBuffer());
  return Response.json({ ok: true });
};

// ---- wiring ----------------------------------------------------------------------
// The wasm renderer initializes once per isolate; fonts ride along because
// Workers have no system fonts for resvg to find.
let resvgReady: Promise<void> | undefined;
const ensureResvg = () =>
  (resvgReady ??= configureResvg(resvgWasm, [
    new Uint8Array(fontSans),
    new Uint8Array(fontSansBold),
  ]));

// The bench needs the *current* request's ExecutionContext for waitUntil.
let currentCtx: ExecutionContext | undefined;

let explorer: ((req: Request) => Promise<Response>) | undefined;
const getExplorer = (env: Env) => {
  if (!explorer) {
    const store = r2Store(env.RUNS);
    const datasetText = async () => datasetJsonl;
    const bench = makeWorkerBench(env.RUNS, store, datasetText, () => {
      if (!currentCtx) throw new Error("no execution context");
      return currentCtx;
    });
    explorer = makeExplorer(store, { datasetText, bench });
  }
  return explorer;
};

export default {
  async fetch(req, env, ctx): Promise<Response> {
    currentCtx = ctx;
    // Effect's Config and generator.ts read the key from process.env; make
    // sure the secret is there regardless of the populate-process-env flag.
    if (env.OPENROUTER_API_KEY) process.env.OPENROUTER_API_KEY = env.OPENROUTER_API_KEY;

    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/blob/") && req.method === "PUT") {
      return handleBlobPut(req, env, url);
    }
    if (url.pathname === "/login") {
      return handleLogin(req, env, url);
    }
    if (!(await isAuthed(req, env))) {
      const wantsPage = req.method === "GET" && (url.pathname === "/" || url.pathname === "/history");
      return wantsPage
        ? Response.redirect(new URL("/login", url).toString(), 302)
        : new Response("unauthorized", { status: 401 });
    }
    await ensureResvg(); // rerun/eval/bench all rasterize; cheap after the first call
    return getExplorer(env)(req);
  },
} satisfies ExportedHandler<Env>;
