"use strict";
// Wires resource-to-resource *capabilities* that the simulator enforces with
// IAM-like policies. Today: Function -> Bucket access.
//
// In Terraform, a Lambda is granted bucket access implicitly (an IAM role +
// usually an env var holding the bucket name, e.g.
//   environment { variables = { STORAGE_BUCKET = aws_s3_bucket.storage.bucket } }
// ). The Wing simulator instead needs (a) the bucket's runtime *handle* so the
// handler can call it via makeSimulatorClient, and (b) an explicit policy
// granting the operations.
//
// So for every Function that *references* a Bucket (detected from the TF config
// `references`), we:
//   - inject env var TF2WSIM_BUCKETS = { "<bucketTfName>": "<handleToken>", ... }
//     (the token resolves to the live handle at simulator start), and
//   - grant put/get/list/delete/exists/signedUrl/publicUrl on that bucket.
//
// Handlers then do:
//   const { makeSimulatorClient } = require("@winglang/sdk/lib/simulator/client");
//   const h = JSON.parse(process.env.TF2WSIM_BUCKETS)["storage"];
//   const bucket = makeSimulatorClient(process.env.WING_SIMULATOR_URL, h, process.env.WING_SIMULATOR_CALLER);
//   await bucket.put(key, data);
const { WING_TYPES } = require("./constants");
const { handleToken } = require("./tokens");

const BUCKET_GRANTS = [
  "put",
  "putJson",
  "get",
  "getJson",
  "tryGet",
  "tryGetJson",
  "list",
  "delete",
  "exists",
  "metadata",
  "copy",
  "rename",
  "signedUrl",
  "publicUrl",
];

// Given the built resource map, the TF resources, the address->path map and the
// config `refs`, attach bucket capabilities to functions. Mutates `resources`.
// Returns a list of { functionPath, bucketPath, bucketTfName } it wired.
function applyCapabilities({ resources, tfResources, addressToPath, refs }) {
  const wired = [];
  const addressType = {};
  const tfNameByAddress = {};
  for (const r of tfResources) {
    addressType[r.address] = r.type;
    tfNameByAddress[r.address] = r.name;
  }

  for (const tf of tfResources) {
    if (tf.type !== "aws_lambda_function") continue;
    const fnPath = addressToPath[tf.address];
    if (!fnPath || !resources[fnPath]) continue;

    // Which buckets does this function reference (anywhere in its config)?
    const referenced = new Set();
    const argRefs = refs[tf.address] || {};
    for (const list of Object.values(argRefs)) {
      for (const addr of list) {
        if (addressType[addr] === "aws_s3_bucket" && addressToPath[addr]) {
          referenced.add(addr);
        }
      }
    }
    if (referenced.size === 0) continue;

    const fn = resources[fnPath];
    fn.props.environmentVariables = fn.props.environmentVariables || {};
    fn.policy = fn.policy || [];

    const bucketMap = {};
    for (const bucketAddr of referenced) {
      const bucketPath = addressToPath[bucketAddr];
      const tfName = tfNameByAddress[bucketAddr];
      bucketMap[tfName] = handleToken(bucketPath);
      for (const op of BUCKET_GRANTS) {
        fn.policy.push({ operation: op, resourceHandle: handleToken(bucketPath) });
      }
      // make the function depend on the bucket so it starts after it
      fn.deps = Array.from(new Set([...(fn.deps || []), bucketPath]));
      wired.push({ functionPath: fnPath, bucketPath, bucketTfName: tfName });
    }
    // Tokens embedded inside this JSON string are resolved at sim start.
    fn.props.environmentVariables.TF2WSIM_BUCKETS = JSON.stringify(bucketMap);
  }
  return wired;
}

module.exports = { applyCapabilities, BUCKET_GRANTS };
