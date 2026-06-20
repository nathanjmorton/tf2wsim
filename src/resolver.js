"use strict";
// Resolves a Terraform aws_lambda_function's deployment package into a single
// JS file the Wing simulator can execute. The sim's Function inflight expects a
// module that exports an async `handler(event)`.
//
// TF gives us `filename` (a local zip) + `handler` ("index.handler"). We unzip,
// find the entry module, and emit a thin shim file that re-exports the handler
// under the name the sim calls (always "handler").
//
// Limitations (documented, not hidden): Node.js packages only. Python/Go/other
// runtimes are detected and reported as unsupported. S3-sourced packages
// (s3_bucket/s3_key) are not fetched — only local `filename` zips.
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

function isNodeRuntime(runtime) {
  return !runtime || /^nodejs/.test(runtime);
}

// Returns absolute path to a runnable JS file, or throws with a clear reason.
function resolveHandler(tfValues, opts) {
  const { workdir, tfDir, resourceName } = opts;
  const runtime = tfValues.runtime;
  if (!isNodeRuntime(runtime)) {
    throw new Error(
      `lambda "${resourceName}": runtime "${runtime}" is not supported by the simulator (Node.js only).`
    );
  }
  const handlerSpec = tfValues.handler || "index.handler";
  const [modBase, fnName] = splitHandler(handlerSpec);

  const outDir = path.join(workdir, "handlers", resourceName);
  fs.mkdirSync(outDir, { recursive: true });

  let entryModule;
  if (tfValues.filename) {
    const zipPath = path.isAbsolute(tfValues.filename)
      ? tfValues.filename
      : path.join(tfDir || process.cwd(), tfValues.filename);
    entryModule = unzipAndFind(zipPath, outDir, modBase);
  } else if (tfValues.s3_bucket) {
    throw new Error(
      `lambda "${resourceName}": S3-sourced packages are not supported; use a local filename zip.`
    );
  } else {
    // No package at all — emit a stub so the topology still simulates.
    const stub = path.join(outDir, "index.js");
    fs.writeFileSync(
      stub,
      `exports.${fnName} = async (event) => { console.log(${JSON.stringify(
        resourceName
      )}, "invoked (stub, no package)", event); };\n`
    );
    entryModule = stub;
  }

  // Emit a shim that exposes the user's handler as exports.handler.
  const shim = path.join(outDir, "_wsim_entry.js");
  const rel = "./" + path.relative(outDir, entryModule).replace(/\\/g, "/");
  fs.writeFileSync(
    shim,
    `const mod = require(${JSON.stringify(rel)});\n` +
      `exports.handler = async (event) => mod.${fnName}(event);\n`
  );
  return shim;
}

function splitHandler(spec) {
  // "index.handler" -> ["index", "handler"]; "src/app.main" -> ["src/app","main"]
  const dot = spec.lastIndexOf(".");
  if (dot < 0) return [spec, "handler"];
  return [spec.slice(0, dot), spec.slice(dot + 1)];
}

function unzipAndFind(zipPath, outDir, modBase) {
  if (!fs.existsSync(zipPath)) {
    throw new Error(`lambda package not found: ${zipPath}`);
  }
  // Use the system unzip; falls back to node if unavailable.
  try {
    execFileSync("unzip", ["-o", "-q", zipPath, "-d", outDir]);
  } catch (e) {
    throw new Error(`failed to unzip ${zipPath}: ${e.message}`);
  }
  for (const cand of [modBase + ".js", modBase + ".cjs", modBase + ".mjs"]) {
    const p = path.join(outDir, cand);
    if (fs.existsSync(p)) return p;
  }
  throw new Error(`handler module "${modBase}" not found inside ${zipPath}`);
}

module.exports = { resolveHandler };
