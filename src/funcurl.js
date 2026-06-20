"use strict";
// aws_lambda_function_url -> a synthetic cloud.Api.
//
// A Lambda Function URL is a dedicated HTTPS endpoint for one function — no API
// Gateway, no routes, no integrations. In the simulator the closest faithful
// thing is a single-route cloud.Api with a catch-all `ANY /` route bound to the
// function. So for each aws_lambda_function_url we synthesize an Api resource
// and emit an edge (Api -> function) so the normal wiring path subscribes it.
//
// This reuses everything: the sim Api inflight, the EventMapping wiring, and the
// browser bridge (which proxies to any running sim Api). One TF resource instead
// of three.
const { WING_TYPES } = require("./constants");

// Build a CORS block from the function_url's `cors` config (best-effort), so a
// browser served from elsewhere can call it. Defaults to permissive.
function corsFrom(values) {
  const cors = Array.isArray(values && values.cors) ? values.cors[0] : values && values.cors;
  const origins = (cors && cors.allow_origins) || ["*"];
  const methods = (cors && cors.allow_methods) || ["*"];
  const headers = (cors && cors.allow_headers) || ["Content-Type"];
  const origin = origins.includes("*") ? "*" : origins.join(",");
  const methodList = methods.includes("*")
    ? "GET,POST,PUT,DELETE,PATCH,OPTIONS"
    : methods.join(",");
  return {
    defaultResponse: { "Access-Control-Allow-Origin": origin },
    optionsResponse: {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": methodList,
      "Access-Control-Allow-Headers": headers.join(","),
    },
  };
}

// Mutates `resources` (adds synthetic Apis) and returns edges in *path* form:
//   [{ publisherPath, subscriberPath, route }]
// `pathFor`/`addrFor` come from synth.js to keep id/addr conventions consistent.
function applyFunctionUrls({ resources, tfResources, addressToPath, refs, pathFor, addrFor }) {
  const edges = [];
  const addressType = {};
  for (const r of tfResources) addressType[r.address] = r.type;

  for (const tf of tfResources) {
    if (tf.type !== "aws_lambda_function_url") continue;
    // Resolve the referenced function.
    const argRefs = refs[tf.address] || {};
    let fnAddr = null;
    for (const list of Object.values(argRefs)) {
      for (const addr of list) {
        if (addressType[addr] === "aws_lambda_function") fnAddr = addr;
      }
    }
    const fnPath = fnAddr && addressToPath[fnAddr];
    if (!fnPath || !resources[fnPath]) continue;

    // Synthesize an Api named after the function url resource.
    const apiPath = pathFor(tf.address);
    addressToPath[tf.address] = apiPath;
    resources[apiPath] = {
      type: WING_TYPES.API,
      path: apiPath,
      addr: addrFor(apiPath),
      props: {
        openApiSpec: { openapi: "3.0.3", info: { title: tf.name, version: "1.0" }, paths: {} },
        corsHeaders: corsFrom(tf.values),
      },
    };
    // ANY catch-all so any method/path on the function URL reaches the handler.
    edges.push({
      publisherPath: apiPath,
      subscriberPath: fnPath,
      route: { method: "ANY", pathPattern: "/" },
    });
  }
  return edges;
}

module.exports = { applyFunctionUrls };
