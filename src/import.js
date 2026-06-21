"use strict";
// Reverse of generate.js: turn an existing Terraform configuration into the
// builder's graph spec ({ nodes, edges }) so users can *iterate* on an existing
// setup in the drag-and-drop canvas instead of starting from scratch.
//
// It reuses the same primitives as the forward translator:
//   - parser.parsePlan  -> normalized resources + reference edges
//   - edges.discoverEdges-> publisher->function event wiring (incl. routes)
// and adds:
//   - reverse type mapping (aws_* -> builder node type)
//   - prop extraction (queue timeouts, function timeout/env)
//   - handler code recovery (read the lambda's source file from disk)
//
// Node layout: we auto-place nodes in columns by role (publishers | functions |
// sinks) so the imported graph is readable immediately.
const fs = require("fs");
const path = require("path");
const { parsePlan } = require("./parser");
const { discoverEdges } = require("./edges");

// aws_* type -> builder node type. Only the types the builder can render.
const TF_TO_NODE = {
  aws_s3_bucket: "bucket",
  aws_sqs_queue: "queue",
  aws_lambda_function: "function",
  aws_sns_topic: "topic",
};

// Roles drive column placement in the canvas.
const ROLE = { bucket: "sink", queue: "publisher", topic: "publisher", function: "function" };

// Find the handler source file for a lambda by walking the archive_file data
// source it references (TF's common zip pattern), then reading it from disk.
// `rawConfigRefs` maps a resource address to ALL of its raw config references
// (including data.* ones, which parser.parsePlan deliberately drops).
function recoverHandlerCode(fnTf, dataResources, rawConfigRefs, tfDir) {
  // Find an archive_file whose output this function uses, via raw config refs.
  const allRefs = rawConfigRefs[fnTf.address] || [];
  let archiveName = null;
  for (const r of allRefs) {
    // references look like "data.archive_file.fn" or "archive_file.fn"
    const m = r.match(/(?:data\.)?archive_file\.([A-Za-z0-9_]+)/);
    if (m) archiveName = m[1];
  }
  // Resolve the archive's source_file from the data resource values.
  let sourceFile = null;
  if (archiveName) {
    const arc = dataResources.find(
      (d) => d.type === "archive_file" && d.name === archiveName
    );
    if (arc && arc.values && arc.values.source_file) sourceFile = arc.values.source_file;
  }
  // Fall back to a direct `filename` if it points at a .js file.
  if (!sourceFile && fnTf.values && /\.(c|m)?js$/.test(fnTf.values.filename || "")) {
    sourceFile = fnTf.values.filename;
  }
  if (!sourceFile) return null;
  const abs = path.isAbsolute(sourceFile)
    ? sourceFile
    : path.join(tfDir || process.cwd(), sourceFile);
  try {
    return fs.readFileSync(abs, "utf8");
  } catch {
    return null;
  }
}

// Extract builder props for a resource from its TF values.
function extractProps(nodeType, values = {}) {
  if (nodeType === "queue") {
    return {
      ...(values.visibility_timeout_seconds != null
        ? { visibilityTimeout: values.visibility_timeout_seconds }
        : {}),
      ...(values.message_retention_seconds != null
        ? { retention: values.message_retention_seconds }
        : {}),
    };
  }
  if (nodeType === "function") {
    const env = {};
    const envBlock = Array.isArray(values.environment) ? values.environment[0] : values.environment;
    if (envBlock && envBlock.variables) Object.assign(env, envBlock.variables);
    return {
      ...(values.timeout != null ? { timeout: values.timeout } : {}),
      ...(Object.keys(env).length ? { env } : {}),
    };
  }
  return {};
}

// Lay nodes out in role columns. Returns { x, y } for the Nth node in a column.
function layout(role, indexInColumn) {
  const COLS = { publisher: 60, function: 380, sink: 700 };
  const x = COLS[role] != null ? COLS[role] : 380;
  const y = 60 + indexInColumn * 120;
  return { x, y };
}

// Main entry: terraform JSON -> { nodes, edges, warnings }.
function importPlan(tfJson, { tfDir } = {}) {
  const { resources, refs } = parsePlan(tfJson);
  // parsePlan only returns managed resources; we also need data sources for
  // handler recovery, so pull those from the plan directly.
  const dataResources = collectDataResources(tfJson);
  // Raw config refs (incl. data.* ones parsePlan drops) for handler recovery.
  const rawConfigRefs = collectRawConfigRefs(tfJson);

  const warnings = [];
  const nodes = [];
  const idByAddress = {};
  const columnCount = { publisher: 0, function: 0, sink: 0 };

  for (const tf of resources) {
    const nodeType = TF_TO_NODE[tf.type];
    if (!nodeType) {
      // Resources the builder can't represent (api gateway, function urls,
      // website configs, event source mappings, etc.) are noted, not imported.
      continue;
    }
    const id = "n" + (nodes.length + 1);
    idByAddress[tf.address] = id;
    const role = ROLE[nodeType];
    const pos = layout(role, columnCount[role]++);
    const node = {
      id,
      type: nodeType,
      name: tf.name,
      props: extractProps(nodeType, tf.values),
      x: pos.x,
      y: pos.y,
    };
    if (nodeType === "function") {
      node.code = recoverHandlerCode(tf, dataResources, rawConfigRefs, tfDir) || "";
      if (!node.code) {
        warnings.push(
          `Could not recover handler code for "${tf.name}" (no readable source file); a default handler will be used.`
        );
      }
    }
    nodes.push(node);
  }

  // Reverse the event wiring into builder edges (publisher -> function).
  const rawEdges = discoverEdges(resources, refs);
  const edges = [];
  for (const e of rawEdges) {
    const source = idByAddress[e.publisher];
    const target = idByAddress[e.subscriber];
    if (source && target) edges.push({ source, target });
  }

  // Note unsupported-but-present resources so the user knows what wasn't imported.
  const supported = new Set(Object.keys(TF_TO_NODE));
  const unsupported = [...new Set(resources.filter((r) => !supported.has(r.type)).map((r) => r.type))];
  if (unsupported.length) {
    warnings.push(
      `Imported the supported resources; these types aren't representable in the builder and were left out: ${unsupported.join(", ")}.`
    );
  }

  return { nodes, edges, warnings };
}

// Gather every raw reference string from a resource's configuration
// expressions, keyed by resource address — unlike parser.parsePlan, this keeps
// data.* references (needed to find a lambda's archive_file source).
function collectRawConfigRefs(tfJson) {
  const out = {};
  const visit = (node, acc) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node.references)) acc.push(...node.references);
    for (const v of Object.values(node)) {
      if (Array.isArray(v)) v.forEach((x) => visit(x, acc));
      else if (v && typeof v === "object") visit(v, acc);
    }
  };
  const walk = (mod) => {
    if (!mod) return;
    for (const r of mod.resources || []) {
      const acc = [];
      for (const expr of Object.values(r.expressions || {})) visit(expr, acc);
      out[r.address] = acc;
    }
    for (const c of mod.child_modules || []) walk(c.module || c);
  };
  walk(tfJson.configuration && tfJson.configuration.root_module);
  return out;
}

function collectDataResources(tfJson) {
  const out = [];
  const walk = (mod) => {
    if (!mod) return;
    for (const r of mod.resources || []) {
      if (r.mode === "data") out.push({ type: r.type, name: r.name, values: r.values || {} });
    }
    for (const c of mod.child_modules || []) walk(c);
  };
  // data resource values land in prior_state for plan output
  walk(tfJson.prior_state && tfJson.prior_state.values && tfJson.prior_state.values.root_module);
  walk(tfJson.planned_values && tfJson.planned_values.root_module);
  walk(tfJson.values && tfJson.values.root_module);
  return out;
}

module.exports = { importPlan, TF_TO_NODE };
