"use strict";
// Orchestrates the translation: terraform JSON -> a .wsim directory that the
// real Wing simulator (and Console) can open.
const fs = require("fs");
const path = require("path");
const { parsePlan } = require("./parser");
const { mapResource } = require("./mappers");
const { resolveHandler } = require("./resolver");
const { applyWiring } = require("./wiring");
const { applyCapabilities } = require("./capabilities");
const { applyFunctionUrls } = require("./funcurl");
const { applyWebsites } = require("./website");
const { discoverEdges } = require("./edges");
const { addrFor } = require("./tokens");
const {
  WING_TYPES,
  WING_CLASSNAMES,
  WING_INFLIGHT_FILE,
  ROOT_SCOPE,
} = require("./constants");

// Turn a TF resource address ("aws_sqs_queue.work") into a Wing resource path
// ("root/Default/aws_sqs_queue.work"). We keep the TF address as a single leaf
// so it's recognizable in the Console, nested under the Default scope the
// Console's map view expects.
function pathFor(address) {
  return ROOT_SCOPE + "/" + address;
}

function buildTypesTable(sdkLibDir, usedTypes) {
  const types = {};
  for (const fqn of usedTypes) {
    const file = WING_INFLIGHT_FILE[fqn];
    types[fqn] = {
      className: WING_CLASSNAMES[fqn],
      sourcePath: path.join(sdkLibDir, "target-sim", file + ".js"),
    };
  }
  return types;
}

// Main entry. Returns the path to the created .wsim directory.
function synth({ tfJson, outDir, tfDir, sdkLibDir }) {
  const { resources: tfResources, refs } = parsePlan(tfJson);
  fs.mkdirSync(outDir, { recursive: true });

  const resources = {};
  const addressToPath = {};
  const skipped = [];

  // 1. Map each supported TF resource to a Wing sim resource.
  for (const tf of tfResources) {
    const mapped = mapResource(tf);
    if (!mapped) {
      skipped.push({ address: tf.address, type: tf.type });
      continue;
    }
    const rpath = pathFor(tf.address);
    addressToPath[tf.address] = rpath;

    // Resolve Lambda handler code into a runnable JS file.
    if (mapped.type === WING_TYPES.FUNCTION) {
      const shim = resolveHandler(tf.values, {
        workdir: outDir,
        tfDir,
        resourceName: tf.address.replace(/[^a-zA-Z0-9_.-]/g, "_"),
      });
      mapped.props.sourceCodeFile = path.relative(outDir, shim);
      delete mapped._raw;
    }

    resources[rpath] = {
      type: mapped.type,
      path: rpath,
      addr: addrFor(rpath),
      props: mapped.props,
    };
  }

  // 2. Wire Function -> Bucket capabilities (env handles + storage policies).
  applyCapabilities({ resources, tfResources, addressToPath, refs });

  // 2b. Lambda Function URLs become synthetic single-route Apis (path-form edges).
  const urlEdges = applyFunctionUrls({
    resources,
    tfResources,
    addressToPath,
    refs,
    pathFor,
    addrFor,
  });
  // 2c. S3 static website hosting -> cloud.Website (materializes objects).
  const { consumedObjects } = applyWebsites({
    resources,
    tfResources,
    addressToPath,
    refs,
    outDir,
    tfDir,
    pathFor,
    addrFor,
  });

  // Resources consumed into synthetic Apis/Websites were not really skipped:
  // funcurl/website set addressToPath for the resources they absorbed, and
  // website also reports the aws_s3_object files it materialized.
  const consumed = new Set(consumedObjects);
  for (let i = skipped.length - 1; i >= 0; i--) {
    const addr = skipped[i].address;
    if (addressToPath[addr] || consumed.has(addr)) skipped.splice(i, 1);
  }

  // 3. Discover event-source edges from the TF graph (raw TF addresses).
  const rawEdges = discoverEdges(tfResources, refs);
  // translate addresses -> wing paths (preserving any per-edge route metadata)
  const edges = rawEdges
    .map((e) => ({
      publisherPath: addressToPath[e.publisher],
      subscriberPath: addressToPath[e.subscriber],
      route: e.route,
    }))
    .filter((e) => e.publisherPath && e.subscriberPath)
    .concat(urlEdges);

  // 4. Synthesize EventMappings + publisher policies.
  const mappings = applyWiring(edges, resources);
  for (const [p, def] of Object.entries(mappings)) {
    def.addr = addrFor(p);
    resources[p] = def;
  }

  // 5. Build the types table (only for types actually used).
  const usedTypes = new Set(Object.values(resources).map((r) => r.type));
  const types = buildTypesTable(sdkLibDir, usedTypes);

  const sdkVersion = require(path.join(sdkLibDir, "constants")).SDK_VERSION;

  // 6. Write the three files that make up a .wsim directory.
  fs.writeFileSync(
    path.join(outDir, "simulator.json"),
    JSON.stringify({ types, resources, sdkVersion }, null, 2)
  );
  fs.writeFileSync(
    path.join(outDir, "tree.json"),
    JSON.stringify(buildTree(resources), null, 2)
  );
  fs.writeFileSync(
    path.join(outDir, "connections.json"),
    JSON.stringify({ connections: buildConnections(edges) }, null, 2)
  );

  return { outDir, skipped, resourceCount: Object.keys(resources).length, edges };
}

// Construct tree for the Console. Resources are nested under root/Default
// because the Console's map view renders the children of the "Default" scope.
function buildTree(resources) {
  const defaultChildren = {};
  for (const [rpath, def] of Object.entries(resources)) {
    const id = rpath.slice(ROOT_SCOPE.length + 1); // strip "root/Default/"
    defaultChildren[id] = {
      id,
      path: rpath,
      children: {},
      display: { title: id, description: def.type },
      constructInfo: { fqn: def.type, version: "0.0.0" },
    };
  }
  const defaultNode = {
    id: "Default",
    path: ROOT_SCOPE,
    children: defaultChildren,
    constructInfo: { fqn: "constructs.Construct", version: "0.0.0" },
  };
  return {
    version: "tree-0.1",
    tree: {
      id: "root",
      path: "root",
      children: { Default: defaultNode },
      constructInfo: { fqn: "constructs.Construct", version: "0.0.0" },
    },
  };
}

// Connections drive the Console's interaction graph (arrows between nodes).
function buildConnections(edges) {
  return edges.map((e) => ({
    source: e.publisherPath,
    target: e.subscriberPath,
    name: "event",
  }));
}

module.exports = { synth, pathFor };
