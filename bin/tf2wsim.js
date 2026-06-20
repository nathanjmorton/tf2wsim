#!/usr/bin/env node
"use strict";
// tf2wsim: translate a Terraform configuration into a Wing simulator (.wsim)
// directory, then optionally run it.
//
// Usage:
//   tf2wsim build   <tfdir> [-o out.wsim]    # plan + translate
//   tf2wsim build   --json plan.json [-o ...] # translate an existing show -json
//   tf2wsim run     <out.wsim>               # load in the simulator, print tree
//   tf2wsim console <tfdir|plan.json> [-p N] # open the Wing Console on the TF graph
//   tf2wsim builder <outdir> [-p N]          # drag-and-drop builder that writes TF
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { synth } = require("../src/synth");

function sdkLibDir() {
  const pkg = require.resolve("@winglang/sdk/package.json");
  return path.join(path.dirname(pkg), "lib");
}

function terraformShowJson(tfDir) {
  // Produce a plan and render it as JSON. Requires `terraform init` already run.
  const plan = path.join(tfDir, ".tf2wsim.plan");
  execFileSync("terraform", [`-chdir=${tfDir}`, "plan", "-out", ".tf2wsim.plan", "-input=false"], {
    stdio: "inherit",
  });
  const out = execFileSync(
    "terraform",
    [`-chdir=${tfDir}`, "show", "-json", ".tf2wsim.plan"],
    { maxBuffer: 64 * 1024 * 1024 }
  );
  try { fs.unlinkSync(plan); } catch {}
  return JSON.parse(out.toString());
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-o" || a === "--out") args.out = argv[++i];
    else if (a === "-p" || a === "--port") args.port = parseInt(argv[++i], 10);
    else if (a === "--console-port") args.consolePort = parseInt(argv[++i], 10);
    else if (a === "--json") args.json = argv[++i];
    else args._.push(a);
  }
  return args;
}

function cmdBuild(args) {
  let tfJson, tfDir;
  if (args.json) {
    tfJson = JSON.parse(fs.readFileSync(args.json, "utf8"));
    tfDir = path.dirname(path.resolve(args.json));
  } else {
    tfDir = path.resolve(args._[0] || ".");
    tfJson = terraformShowJson(tfDir);
  }
  const outDir = path.resolve(args.out || "out.wsim");
  const res = synth({ tfJson, outDir, tfDir, sdkLibDir: sdkLibDir() });
  console.log(`\u2713 wrote ${res.resourceCount} resources to ${outDir}`);
  if (res.edges.length) console.log(`  ${res.edges.length} event wiring edge(s)`);
  if (res.skipped.length) {
    console.log("  skipped (unsupported) TF resources:");
    for (const s of res.skipped) console.log(`    - ${s.address} (${s.type})`);
  }
}

async function cmdRun(args) {
  const { simulator } = require("@winglang/sdk");
  const dir = path.resolve(args._[0] || "out.wsim");
  const sim = new simulator.Simulator({ simfile: dir });
  sim.onTrace({
    callback: (t) => {
      if (t.data && t.data.message) console.log(`[${t.level}] ${t.sourcePath}: ${t.data.message}`);
    },
  });
  await sim.start();
  console.log("\nResources:", sim.listResources());
  await sim.stop();
}

async function cmdConsole(args) {
  const { startConsole, waitForReady, progress } = require("../src/console");
  const entrypoint = path.resolve(args._[0] || ".");
  const port = args.port || 3000;

  const isTTY = process.stdout.isTTY;
  const dim = (s) => (isTTY ? `\x1b[2m${s}\x1b[0m` : s);
  const cyan = (s) => (isTTY ? `\x1b[36m${s}\x1b[0m` : s);
  const green = (s) => (isTTY ? `\x1b[32m${s}\x1b[0m` : s);

  // A tiny single-line spinner that explains the current phase. Stays quiet on
  // non-TTY (CI/logs) where we just print discrete status lines instead.
  let frame = 0;
  const frames = ["\u280b", "\u2819", "\u2839", "\u2838", "\u283c", "\u2834", "\u2826", "\u2827", "\u2807", "\u280f"];
  let label = "Starting the Wing Console…";
  let timer;
  const render = () => {
    if (!isTTY) return;
    process.stdout.write(`\r${cyan(frames[frame = (frame + 1) % frames.length])} ${label}   `);
  };
  const setLabel = (text) => {
    label = text;
    if (isTTY) render();
    else console.log(`  ${text}`);
  };
  const stopSpinner = () => {
    if (timer) clearInterval(timer);
    if (isTTY) process.stdout.write("\r\x1b[2K"); // clear the line
  };

  // Narrate the phases as the (background) compile runs.
  progress.on("plan:start", () =>
    setLabel("Running terraform plan… " + dim("(first run downloads the AWS provider — this can take a minute)"))
  );
  progress.on("plan:done", () => setLabel("Translating Terraform → Wing simulator…"));
  progress.on("synth:done", (s) =>
    setLabel(
      `Starting simulator — ${s.resourceCount} resources, ${s.edges} edge(s)` +
        (s.skipped ? `, ${s.skipped} skipped` : "") + "…"
    )
  );
  progress.on("compile:error", (e) => setLabel(`Problem: ${e.message.split("\n")[0]}`));

  if (isTTY) timer = setInterval(render, 90);
  setLabel(label);

  const server = await startConsole({ entrypoint, port });
  const url = `http://localhost:${server.port}/`;
  setLabel("Waiting for the simulator to come online…");

  const status = await waitForReady(server.port);
  stopSpinner();

  if (status.ready) {
    console.log(`${green("\u2713")} Wing Console ready — ${status.started} resources started`);
    console.log(`  open: ${green(url)}`);
    console.log(dim("  (editing the Terraform re-plans and live-reloads; Ctrl-C to stop)"));
  } else {
    console.log(`${isTTY ? "\x1b[33m!\x1b[0m" : "!"} Console is running at ${url}, but the simulator isn't fully up yet:`);
    console.log(dim("  " + (status.error || "unknown").split("\n").join("\n  ")));
    console.log(dim("  The Console UI will show details and retry on changes."));
  }
  // keep the process alive
  process.stdin.resume();
}

async function cmdBuilder(args) {
  const { startBuilder } = require("../src/builder");
  const outDir = path.resolve(args._[0] || "./tf-project");
  const port = args.port || 3100;
  const consolePort = args.consolePort || 3000;
  fs.mkdirSync(outDir, { recursive: true });
  const { port: actual } = await startBuilder({ outDir, port, consolePort });
  console.log(`\u2713 tf2wsim builder`);
  console.log(`  target dir: ${outDir}`);
  console.log(`  open: http://localhost:${actual}/`);
  console.log(`  Drag a graph, then click "Init & Open Console" to simulate it.`);
  process.stdin.resume();
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  switch (cmd) {
    case "build": return cmdBuild(args);
    case "run": return cmdRun(args);
    case "console": return cmdConsole(args);
    case "builder": return cmdBuilder(args);
    default:
      console.log("Usage: tf2wsim <build|run|console|builder> ...");
      console.log("  build <tfdir> [-o out.wsim]");
      console.log("  build --json plan.json [-o out.wsim]");
      console.log("  run <out.wsim>");
      console.log("  console <tfdir|plan.json> [-p port]");
      console.log("  builder <outdir> [-p port]");
      process.exit(cmd ? 1 : 0);
  }
}

main().catch((e) => { console.error("Error:", e.message); process.exit(1); });
