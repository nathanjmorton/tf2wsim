"use strict";
// Parses `terraform show -json <plan>` (or `terraform show -json` of state).
// Produces a normalized view:
//   resources: [{ address, type, name, values }]
//   refs:      Map<address, Map<argName, address[]>>  (from configuration block)
//
// We need both the *values* (planned_values / state) for props, and the
// *configuration* block for reference edges (which resource points at which),
// because Terraform's planned values don't preserve the symbolic links between
// resources — those only live in `configuration.*.expressions[].references`.

function collectValues(module, acc) {
  for (const r of module.resources || []) {
    if (r.mode && r.mode !== "managed") continue;
    acc.push({
      address: r.address,
      type: r.type,
      name: r.name,
      values: r.values || {},
    });
  }
  for (const c of module.child_modules || []) collectValues(c, acc);
}

// Build a map of address -> { argName -> [referenced addresses] }.
function collectRefs(module, acc, prefix = "") {
  for (const r of module.resources || []) {
    const address = (prefix ? prefix + "." : "") + r.address;
    const argRefs = {};
    for (const [arg, expr] of Object.entries(r.expressions || {})) {
      const refs = extractRefs(expr);
      if (refs.length) argRefs[arg] = refs;
    }
    acc[address] = argRefs;
  }
  for (const c of module.child_modules || []) {
    collectRefs(c.module || c, acc, prefix);
  }
}

// References in a configuration expression can be nested (blocks/lists). Walk
// recursively and gather any `references` arrays, normalizing each reference to
// its "type.name" resource address (dropping attribute suffixes like `.arn`).
function extractRefs(expr) {
  const out = [];
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node.references)) {
      for (const ref of node.references) {
        const addr = normalizeRef(ref);
        if (addr) out.push(addr);
      }
    }
    for (const v of Object.values(node)) {
      if (Array.isArray(v)) v.forEach(visit);
      else if (v && typeof v === "object") visit(v);
    }
  };
  visit(expr);
  return [...new Set(out)];
}

// "aws_sqs_queue.work.arn" -> "aws_sqs_queue.work". Skip var/local/data refs.
function normalizeRef(ref) {
  const parts = ref.split(".");
  if (parts.length < 2) return null;
  if (["var", "local", "data", "module", "each", "count", "path"].includes(parts[0])) return null;
  return parts[0] + "." + parts[1];
}

function parsePlan(json) {
  const resources = [];
  if (json.planned_values && json.planned_values.root_module) {
    collectValues(json.planned_values.root_module, resources);
  } else if (json.values && json.values.root_module) {
    // `terraform show -json` of state
    collectValues(json.values.root_module, resources);
  }
  const refs = {};
  if (json.configuration && json.configuration.root_module) {
    collectRefs(json.configuration.root_module, refs);
  }
  return { resources, refs };
}

module.exports = { parsePlan, extractRefs, normalizeRef };
