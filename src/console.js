"use strict";
// Boots the Wing Console (@wingconsole/app) but feeds it a .wsim produced from
// Terraform instead of from a compiled Wing program.
//
// How: the Console's server calls `require("@winglang/compiler").compile(wingfile)`
// and uses the returned `outputDir` as the simulator file. We install a
// Module._load hook that intercepts `@winglang/compiler` and replaces `compile`
// with our own function that:
//   1. obtains terraform JSON (runs `terraform plan` for a dir/.tf, or reads a
//      prebuilt plan.json), and
//   2. runs tf2wsim's synth() to write a .wsim directory, then
//   3. returns it in the { outputDir, wingcErrors, preflightError } shape the
//      Console expects.
//
// The Console also watches the source directory and recompiles on change, so
// editing the .tf re-plans and live-reloads the simulated graph.
const fs = require("fs");
const path = require("path");
const Module = require("module");
const { EventEmitter } = require("events");
const { execFileSync } = require("child_process");
const { synth } = require("./synth");

// Progress bus. The compile step (which the Console runs in the background)
// emits lifecycle events here so the CLI can show the user what's happening
// while the first `terraform plan` + synth + simulator start runs. Events:
//   "plan:start"  ()                      terraform plan is about to run
//   "plan:done"   ()                      plan finished, JSON parsed
//   "synth:done"  ({resourceCount,edges,skipped})  .wsim written
//   "compile:error" (Error)               something failed during compile
const progress = new EventEmitter();

function sdkLibDir() {
  const pkg = require.resolve("@winglang/sdk/package.json");
  return path.join(path.dirname(pkg), "lib");
}

// The simulator guards its state directory with a lockfile at
// <simdir>/.state/.lock whose mtime it refreshes every ~1s. If a previous
// Console was killed uncleanly, that lock lingers and blocks the next run with
// "Another instance of the simulator is already running...". The SDK's own
// staleness check (mtime > 10s) doesn't help if you restart quickly.
//
// We make reclamation deterministic with an ownership pidfile we write next to
// the lock. On startup:
//   - no lock        -> nothing to do; record our PID as owner
//   - lock + owner dead (or no owner recorded) -> orphaned; remove and take over
//   - lock + owner alive and not us            -> a real instance owns it; error
// This avoids the timing race of an mtime-based heuristic (the SDK refreshes
// the lock every second, so a freshly-orphaned lock still looks "fresh").
function ownerPath(simDir) {
  return path.join(simDir, ".state", ".tf2wsim-owner");
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0); // signal 0 = existence check
    return true;
  } catch (e) {
    return e.code === "EPERM"; // exists but not ours to signal
  }
}

function reclaimStaleLock(simDir, log = () => {}) {
  const lockPath = path.join(simDir, ".state", ".lock");
  const ownPath = ownerPath(simDir);
  let lockExists = true;
  try {
    fs.statSync(lockPath);
  } catch (e) {
    if (e.code === "ENOENT") lockExists = false;
    else throw e;
  }

  if (lockExists) {
    let owner;
    try {
      owner = parseInt(fs.readFileSync(ownPath, "utf8").trim(), 10);
    } catch {
      owner = NaN;
    }
    if (owner === process.pid) {
      // We already own this state dir (e.g. a live reload). Leave the lock be.
      return { reclaimed: false, live: false };
    }
    if (Number.isInteger(owner) && pidAlive(owner)) {
      // A different, live tf2wsim console owns this state directory.
      return { reclaimed: false, live: true };
    }
    // Orphaned lock (owner dead, or unknown owner) — reclaim it.
    fs.rmSync(lockPath, { force: true });
    log(`tf2wsim: removed orphaned simulator lock (previous owner pid ${owner || "unknown"})\n`);
  }

  // Record ourselves as the current owner.
  fs.mkdirSync(path.dirname(ownPath), { recursive: true });
  fs.writeFileSync(ownPath, String(process.pid));
  return { reclaimed: lockExists, live: false };
}

// Produce terraform JSON for a given entrypoint (a .tf file, a directory, or a
// prebuilt `terraform show -json` file).
function terraformJsonFor(entrypoint) {
  const ep = path.resolve(entrypoint);
  const stat = fs.existsSync(ep) ? fs.statSync(ep) : null;
  if (stat && stat.isFile() && ep.endsWith(".json")) {
    return { tfJson: JSON.parse(fs.readFileSync(ep, "utf8")), tfDir: path.dirname(ep) };
  }
  const tfDir = stat && stat.isDirectory() ? ep : path.dirname(ep);
  const planFile = path.join(tfDir, "target", ".tf2wsim.plan");
  fs.mkdirSync(path.join(tfDir, "target"), { recursive: true });
  progress.emit("plan:start");
  try {
    // Capture (don't inherit) terraform's verbose output so the CLI can render
    // a clean progress spinner; surface it only if the plan fails.
    execFileSync(
      "terraform",
      [`-chdir=${tfDir}`, "plan", "-out", "target/.tf2wsim.plan", "-input=false"],
      { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 128 * 1024 * 1024 }
    );
  } catch (e) {
    const detail = (e.stderr || e.stdout || "").toString().trim();
    throw new Error(`terraform plan failed${detail ? ":\n" + detail : ""}`);
  }
  const out = execFileSync(
    "terraform",
    [`-chdir=${tfDir}`, "show", "-json", "target/.tf2wsim.plan"],
    { maxBuffer: 128 * 1024 * 1024 }
  );
  try { fs.unlinkSync(planFile); } catch {}
  progress.emit("plan:done");
  return { tfJson: JSON.parse(out.toString()), tfDir };
}

// Our drop-in replacement for @winglang/compiler's `compile`.
async function tfCompile(entrypoint, options = {}) {
  const preflightLog = options.preflightLog || (() => {});
  try {
    const { tfJson, tfDir } = terraformJsonFor(entrypoint);
    // Stable output dir under target/ so the Console's watcher ignores it and
    // simulator.update() can diff against the previous run on reload.
    const outDir = path.join(tfDir, "target", "console.wsim");
    // Reclaim a lock orphaned by a previously-killed Console before the server
    // tries to (re)start the simulator on this state directory.
    const lock = reclaimStaleLock(outDir, preflightLog);
    if (lock.live) {
      throw new Error(
        `A simulator lock at ${path.join(outDir, ".state", ".lock")} is being ` +
          `actively held — another tf2wsim console may be running on this ` +
          `directory. Stop it first, or use a different terraform directory.`
      );
    }
    const res = synth({ tfJson, outDir, tfDir, sdkLibDir: sdkLibDir() });
    progress.emit("synth:done", {
      resourceCount: res.resourceCount,
      edges: res.edges.length,
      skipped: res.skipped.length,
    });
    preflightLog(
      `tf2wsim: ${res.resourceCount} resources, ${res.edges.length} event edge(s)` +
        (res.skipped.length ? `, ${res.skipped.length} skipped` : "") + "\n"
    );
    return { outputDir: outDir, wingcErrors: [], preflightError: undefined };
  } catch (err) {
    progress.emit("compile:error", err);
    return { outputDir: undefined, wingcErrors: [], preflightError: err };
  }
}

// Install the require interception for @winglang/compiler.
function patchCompiler() {
  const realCompilerPath = require.resolve("@winglang/compiler");
  const realCompiler = require("@winglang/compiler");
  // A proxy that returns our compile for `.compile` and passes everything else
  // (BuiltinPlatform, CompileError, …) through to the real module.
  const proxied = new Proxy(realCompiler, {
    get(target, prop, receiver) {
      if (prop === "compile") return tfCompile;
      return Reflect.get(target, prop, receiver);
    },
  });
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    const resolved = (() => {
      try { return Module._resolveFilename(request, parent, isMain); } catch { return null; }
    })();
    if (resolved === realCompilerPath) return proxied;
    return origLoad.apply(this, arguments);
  };
}

// The Console derives its file watcher's root from `path.dirname(wingfile)` and
// ignores `<that dir>/target/**`. If we hand it a *directory*, dirname() points
// at the parent and our `target/console.wsim` output is no longer ignored — the
// watcher then re-triggers compile on every synth, looping forever. So always
// resolve a directory entrypoint to a file that lives *inside* the tf dir.
function resolveWingfile(entrypoint) {
  const ep = path.resolve(entrypoint);
  const stat = fs.existsSync(ep) ? fs.statSync(ep) : null;
  if (stat && stat.isDirectory()) {
    const tf = fs.readdirSync(ep).find((f) => f.endsWith(".tf"));
    // A real .tf file is ideal (watcher reacts to edits); otherwise a stable
    // sentinel path inside the dir keeps dirname() pointing at the tf dir.
    return path.join(ep, tf || "main.tf");
  }
  return ep;
}

async function startConsole({ entrypoint, port }) {
  patchCompiler();
  // Require AFTER patching so the Console's bundle picks up our compiler proxy.
  const { createConsoleApp } = require("@wingconsole/app");
  process.env.NO_SIGN_IN = process.env.NO_SIGN_IN || "true";
  process.env.WING_DISABLE_ANALYTICS = process.env.WING_DISABLE_ANALYTICS || "1";
  const server = await createConsoleApp({
    wingfile: resolveWingfile(entrypoint),
    requestedPort: port,
    requireSignIn: false,
    requireAcceptTerms: false,
    hostUtils: {
      async openExternal() {},
    },
  });

  // Release the simulator lock cleanly on exit so the next run isn't blocked.
  // server.close() stops the simulator (and thus releases its lockfile), but it
  // can hang if a sandbox worker is wedged — so we cap it with a hard timeout
  // and exit regardless. (If we're killed with SIGKILL or the close hangs past
  // the timeout, the pidfile-based reclaim on the next run cleans up anyway.)
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    const forceExit = setTimeout(() => process.exit(0), 3000);
    forceExit.unref?.();
    try {
      if (typeof server.close === "function") {
        await new Promise((resolve) => server.close(resolve));
      }
    } catch {
      // best-effort
    } finally {
      clearTimeout(forceExit);
      process.exit(0);
    }
  };
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => void shutdown());
  }

  return server;
}

// Poll the running Console until the simulator has actually started its
// resources (so we only tell the user "open this URL" once the map is live),
// or until an error/ timeout. Returns { ready, error, started, total }.
async function waitForReady(port, { timeoutMs = 120000, intervalMs = 500 } = {}) {
  const http = require("http");
  const get = (p) =>
    new Promise((resolve) => {
      const req = http.get(
        { host: "127.0.0.1", port, path: p, timeout: 3000 },
        (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => {
            try { resolve(JSON.parse(body)); } catch { resolve(null); }
          });
        }
      );
      req.on("error", () => resolve(null));
      req.on("timeout", () => { req.destroy(); resolve(null); });
    });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // Surface a compile error immediately rather than waiting out the timeout.
    const errResp = await get("/trpc/app.error");
    const errData = errResp && errResp.result && errResp.result.data;
    if (errData) return { ready: false, error: String(errData) };

    const mapResp = await get("/trpc/app.map");
    const data = mapResp && mapResp.result && mapResp.result.data;
    if (data && data.tree) {
      const children =
        (data.tree.children &&
          data.tree.children.Default &&
          data.tree.children.Default.children) ||
        {};
      const states = Object.values(children).map(
        (c) => c.hierarchichalRunningState
      );
      const total = states.length;
      const started = states.filter((s) => s === "started").length;
      if (total > 0 && started === total) {
        return { ready: true, started, total };
      }
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return { ready: false, error: "timed out waiting for the simulator to start" };
}

module.exports = {
  startConsole,
  tfCompile,
  reclaimStaleLock,
  waitForReady,
  progress,
};
