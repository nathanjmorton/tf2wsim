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
const { execFileSync } = require("child_process");
const { synth } = require("./synth");

function sdkLibDir() {
  const pkg = require.resolve("@winglang/sdk/package.json");
  return path.join(path.dirname(pkg), "lib");
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
  execFileSync("terraform", [`-chdir=${tfDir}`, "plan", "-out", "target/.tf2wsim.plan", "-input=false"], {
    stdio: "inherit",
  });
  const out = execFileSync(
    "terraform",
    [`-chdir=${tfDir}`, "show", "-json", "target/.tf2wsim.plan"],
    { maxBuffer: 128 * 1024 * 1024 }
  );
  try { fs.unlinkSync(planFile); } catch {}
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
    const res = synth({ tfJson, outDir, tfDir, sdkLibDir: sdkLibDir() });
    preflightLog(
      `tf2wsim: ${res.resourceCount} resources, ${res.edges.length} event edge(s)` +
        (res.skipped.length ? `, ${res.skipped.length} skipped` : "") + "\n"
    );
    return { outputDir: outDir, wingcErrors: [], preflightError: undefined };
  } catch (err) {
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

async function startConsole({ entrypoint, port }) {
  patchCompiler();
  // Require AFTER patching so the Console's bundle picks up our compiler proxy.
  const { createConsoleApp } = require("@wingconsole/app");
  process.env.NO_SIGN_IN = process.env.NO_SIGN_IN || "true";
  process.env.WING_DISABLE_ANALYTICS = process.env.WING_DISABLE_ANALYTICS || "1";
  const server = await createConsoleApp({
    wingfile: path.resolve(entrypoint),
    requestedPort: port,
    requireSignIn: false,
    requireAcceptTerms: false,
    hostUtils: {
      async openExternal() {},
    },
  });
  return server;
}

module.exports = { startConsole, tfCompile };
