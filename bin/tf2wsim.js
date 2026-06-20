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
  const { startConsole } = require("../src/console");
  const entrypoint = path.resolve(args._[0] || ".");
  const port = args.port || 3000;
  const server = await startConsole({ entrypoint, port });
  const url = `http://localhost:${server.port}/`;
  console.log(`\u2713 Wing Console for ${entrypoint}`);
  console.log(`  open: ${url}`);
  // keep the process alive
  process.stdin.resume();
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  switch (cmd) {
    case "build": return cmdBuild(args);
    case "run": return cmdRun(args);
    case "console": return cmdConsole(args);
    default:
      console.log("Usage: tf2wsim <build|run|console> ...");
      console.log("  build <tfdir> [-o out.wsim]");
      console.log("  build --json plan.json [-o out.wsim]");
      console.log("  run <out.wsim>");
      console.log("  console <tfdir|plan.json> [-p port]");
      process.exit(cmd ? 1 : 0);
  }
}

main().catch((e) => { console.error("Error:", e.message); process.exit(1); });
