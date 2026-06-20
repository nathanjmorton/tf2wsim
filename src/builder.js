"use strict";
// A tiny HTTP server hosting the drag-and-drop Terraform builder UI. The canvas
// lets you drop Bucket/Queue/Function/Topic nodes, connect publisher→function
// edges, and edit each function's handler code inline. "Generate" writes the
// Terraform config (+ handler files) via src/generate.js into a target
// directory — which you can then open with `tf2wsim console <dir>`.
const fs = require("fs");
const path = require("path");
const http = require("http");
const net = require("net");
const { spawn, execFile } = require("child_process");
const { generate } = require("./generate");
const { waitForReady } = require("./console");

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json" });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

// Write generated files into outDir, refusing to escape it.
function writeFiles(outDir, files) {
  const written = [];
  for (const [rel, contents] of Object.entries(files)) {
    const abs = path.resolve(outDir, rel);
    if (!abs.startsWith(path.resolve(outDir) + path.sep)) {
      throw new Error(`refusing to write outside target: ${rel}`);
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contents);
    written.push(rel);
  }
  return written;
}

// ---- one-click "Init & Open Console" ----------------------------------------
// The builder can run `terraform init` (once) and launch the Wing Console on the
// generated project as a child process, so the user never touches a terminal.
// We track the child, restart it on each launch, and expose progress via a
// pollable status object.

let consoleChild = null;
let consoleChildPid = null; // remembered separately so cleanup works even after exit
let launchState = { phase: "idle", ready: false, error: null, consolePort: null };

function killConsoleChild() {
  const pid = consoleChildPid;
  consoleChild = null;
  consoleChildPid = null;
  if (!pid) return;
  // The child is its own process-group leader (spawned detached), so signal the
  // whole group to take down the Console *and* its simulator sandbox workers.
  try { process.kill(-pid, "SIGKILL"); } catch {}
  try { process.kill(pid, "SIGKILL"); } catch {}
}

function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.once("listening", () => s.close(() => resolve(true)));
    s.listen(port, "0.0.0.0");
  });
}

// Pick a free port in the exe.dev-proxyable range (3000-9999) starting at pref,
// so the Console binds the exact port we hand it (no silent fallback) and the
// user can reach it through the proxy.
async function pickConsolePort(pref) {
  for (let p = pref; p < pref + 30 && p <= 9999; p++) {
    if (await portFree(p)) return p;
  }
  throw new Error("no free port available in range 3000-9999 for the Console");
}

function execFileP(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) {
        const detail = (stderr || stdout || err.message || "").toString().trim();
        reject(new Error(detail));
      } else resolve({ stdout, stderr });
    });
  });
}

async function launchConsole(outDir, spec, preferredPort) {
  launchState = { phase: "generating", ready: false, error: null, consolePort: null };
  try {
    // 1. (re)generate so the launch always reflects the current canvas
    const { files } = generate(spec);
    writeFiles(outDir, files);

    // 2. terraform init (once) — downloads providers, writes the lock file
    if (!fs.existsSync(path.join(outDir, ".terraform"))) {
      launchState.phase = "terraform init";
      await execFileP("terraform", [`-chdir=${outDir}`, "init", "-input=false"]);
    }

    // 3. (re)start the Console child on a free, proxyable port
    launchState.phase = "starting console";
    const consolePort = await pickConsolePort(preferredPort || 3000);
    launchState.consolePort = consolePort;
    killConsoleChild();
    const cliPath = path.join(__dirname, "..", "bin", "tf2wsim.js");
    consoleChild = spawn(
      process.execPath,
      [cliPath, "console", outDir, "-p", String(consolePort)],
      { detached: true, stdio: "ignore" }
    );
    consoleChildPid = consoleChild.pid;
    consoleChild.unref();
    consoleChild.on("exit", (code) => {
      // If the child dies before/while we're waiting, surface it.
      if (!launchState.ready && launchState.phase !== "idle") {
        launchState.phase = "error";
        launchState.error = launchState.error || `console process exited (code ${code})`;
      }
      if (consoleChild && consoleChild.exitCode !== null) consoleChild = null;
    });

    // 4. wait until the simulator's resources are actually running
    const status = await waitForReady(consolePort, { timeoutMs: 180000 });
    if (status.ready) {
      launchState.phase = "ready";
      launchState.ready = true;
      launchState.started = status.started;
      launchState.total = status.total;
    } else {
      launchState.phase = "error";
      launchState.error = status.error || "the simulator did not become ready";
    }
  } catch (err) {
    launchState.phase = "error";
    launchState.error = String(err.message || err);
  }
}

// Build a URL the *user's browser* can use to reach the launched Console.
// On exe.dev the user hits the builder through the proxy at
// https://<vm>.exe.xyz:<builderPort>/, and reaches other ports at
// https://<vm>.exe.xyz:<port>/. So derive the host from the incoming request
// and swap in the console's port. Locally this resolves to http://host:port/.
function consoleUrlFor(req, consolePort) {
  if (consolePort == null) return null;
  const host = (req.headers.host || "localhost").replace(/:\d+$/, "");
  const xfproto = (req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  // exe.dev proxy terminates TLS and forwards; prefer the forwarded scheme,
  // else assume https for *.exe.xyz hosts and http otherwise.
  const proto = xfproto || (/\.exe\.xyz$/i.test(host) ? "https" : "http");
  return `${proto}://${host}:${consolePort}/`;
}

function startBuilder({ outDir, port = 3100, consolePort = 3000 }) {
  const uiPath = path.join(__dirname, "..", "ui", "builder.html");
  const resolvedOut = path.resolve(outDir);
  const consolePref = consolePort;

  // Make sure the launched Console child (and its sandbox workers) die with the
  // builder. On a signal we kill the child group, then exit explicitly.
  process.on("exit", () => killConsoleChild());
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      killConsoleChild();
      process.exit(0);
    });
  }

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
        const html = fs.readFileSync(uiPath, "utf8");
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(html);
      }
      if (req.method === "GET" && req.url === "/api/target") {
        return sendJson(res, 200, { outDir: resolvedOut });
      }
      if (req.method === "POST" && req.url === "/api/generate") {
        const spec = await readBody(req);
        const { files, warnings } = generate(spec);
        const written = writeFiles(resolvedOut, files);
        return sendJson(res, 200, {
          ok: true,
          outDir: resolvedOut,
          written,
          warnings,
          mainTf: files["main.tf"],
        });
      }
      if (req.method === "POST" && req.url === "/api/launch") {
        const spec = await readBody(req);
        // Kick off the (async) init+launch but respond immediately; the UI
        // polls /api/launch/status for progress.
        void launchConsole(resolvedOut, spec, consolePref);
        return sendJson(res, 200, { ok: true, started: true });
      }
      if (req.method === "GET" && req.url === "/api/launch/status") {
        return sendJson(res, 200, {
          ...launchState,
          url: consoleUrlFor(req, launchState.consolePort),
        });
      }
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    } catch (err) {
      sendJson(res, 400, { ok: false, error: String(err.message || err) });
    }
  });

  return new Promise((resolve) => {
    server.listen(port, "0.0.0.0", () => resolve({ server, port }));
  });
}

module.exports = { startBuilder };
