"use strict";
// Unit + integration tests for tf2wsim. Run with: npm test
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { synth } = require("../src/synth");
const { discoverEdges } = require("../src/edges");
const { parsePlan } = require("../src/parser");

function sdkLibDir() {
  const pkg = require.resolve("@winglang/sdk/package.json");
  return path.join(path.dirname(pkg), "lib");
}

let passed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { console.log("  \u2713 " + name); passed++; })
    .catch((e) => { console.error("  \u2717 " + name + "\n    " + e.stack); process.exitCode = 1; });
}

async function main() {
  const exampleDir = path.join(__dirname, "..", "examples", "basic");
  const planPath = path.join(exampleDir, "plan.json");
  const haveExamplePlan = fs.existsSync(planPath);

  console.log("parser/edges:");
  await test("discovers SQS->Lambda edge from event_source_mapping", () => {
    const tfJson = {
      planned_values: { root_module: { resources: [
        { address: "aws_sqs_queue.q", type: "aws_sqs_queue", name: "q", values: {} },
        { address: "aws_lambda_function.f", type: "aws_lambda_function", name: "f", values: {} },
        { address: "aws_lambda_event_source_mapping.m", type: "aws_lambda_event_source_mapping", name: "m", values: {} },
      ] } },
      configuration: { root_module: { resources: [
        { address: "aws_lambda_event_source_mapping.m", type: "aws_lambda_event_source_mapping", expressions: {
          event_source_arn: { references: ["aws_sqs_queue.q.arn", "aws_sqs_queue.q"] },
          function_name: { references: ["aws_lambda_function.f.arn", "aws_lambda_function.f"] },
        } },
      ] } },
    };
    const { resources, refs } = parsePlan(tfJson);
    const edges = discoverEdges(resources, refs);
    assert.strictEqual(edges.length, 1);
    assert.strictEqual(edges[0].publisher, "aws_sqs_queue.q");
    assert.strictEqual(edges[0].subscriber, "aws_lambda_function.f");
  });

  console.log("console lock reclaim:");
  {
    const { reclaimStaleLock } = require("../src/console");
    const mkSim = () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wsim-lock-"));
      fs.mkdirSync(path.join(dir, ".state"), { recursive: true });
      return dir;
    };
    const writeLock = (dir, ownerPid) => {
      fs.writeFileSync(path.join(dir, ".state", ".lock"), "");
      if (ownerPid !== undefined) {
        fs.writeFileSync(path.join(dir, ".state", ".tf2wsim-owner"), String(ownerPid));
      }
    };
    const lockExists = (dir) => fs.existsSync(path.join(dir, ".state", ".lock"));

    await test("reclaims a lock whose owner pid is dead", () => {
      const dir = mkSim();
      writeLock(dir, 999999); // pid that's virtually certain not to exist
      const r = reclaimStaleLock(dir);
      assert.strictEqual(r.live, false);
      assert.strictEqual(r.reclaimed, true);
      assert.ok(!lockExists(dir), "orphaned lock should be removed");
    });

    await test("refuses to reclaim a lock held by a live foreign pid", () => {
      const dir = mkSim();
      // Use a definitely-live pid other than ours: the test process's own
      // parent. If unavailable, fall back to pid 1 (init), always alive.
      const livePid = process.ppid && process.ppid !== process.pid ? process.ppid : 1;
      writeLock(dir, livePid);
      const r = reclaimStaleLock(dir);
      assert.strictEqual(r.live, true, "should report a live owner");
      assert.ok(lockExists(dir), "live lock must not be removed");
    });

    await test("no lock present -> records ownership, no error", () => {
      const dir = mkSim();
      const r = reclaimStaleLock(dir);
      assert.strictEqual(r.live, false);
      const owner = fs.readFileSync(path.join(dir, ".state", ".tf2wsim-owner"), "utf8").trim();
      assert.strictEqual(owner, String(process.pid));
    });
  }

  console.log("capabilities + api wiring:");
  {
    const { discoverEdges } = require("../src/edges");
    const { applyCapabilities } = require("../src/capabilities");
    const { WING_TYPES } = require("../src/constants");
    const { handleToken } = require("../src/tokens");

    await test("discovers an apigatewayv2 route -> lambda edge with method/path", () => {
      const resources = [
        { address: "aws_apigatewayv2_api.api", type: "aws_apigatewayv2_api", name: "api", values: {} },
        { address: "aws_apigatewayv2_integration.up", type: "aws_apigatewayv2_integration", name: "up", values: {} },
        { address: "aws_apigatewayv2_route.up", type: "aws_apigatewayv2_route", name: "up", values: { route_key: "POST /upload" } },
        { address: "aws_lambda_function.f", type: "aws_lambda_function", name: "f", values: {} },
      ];
      const refs = {
        "aws_apigatewayv2_integration.up": { integration_uri: ["aws_lambda_function.f"] },
        "aws_apigatewayv2_route.up": {
          api_id: ["aws_apigatewayv2_api.api"],
          target: ["aws_apigatewayv2_integration.up"],
        },
      };
      const edges = discoverEdges(resources, refs);
      assert.strictEqual(edges.length, 1);
      assert.strictEqual(edges[0].publisher, "aws_apigatewayv2_api.api");
      assert.strictEqual(edges[0].subscriber, "aws_lambda_function.f");
      assert.deepStrictEqual(edges[0].route, { method: "POST", pathPattern: "/upload" });
    });

    await test("maps aws_lambda_function_url to a synthetic Api with ANY route", () => {
      const { synth } = require("../src/synth");
      // build a tiny in-memory plan with a function + function url
      // (synth needs a real handler zip, so we just check edge synthesis here)
      const { applyFunctionUrls } = require("../src/funcurl");
      const fnPath = "root/Default/aws_lambda_function.f";
      const resources = {
        [fnPath]: { type: WING_TYPES.FUNCTION, path: fnPath, props: {} },
      };
      const tfResources = [
        { address: "aws_lambda_function.f", type: "aws_lambda_function", name: "f", values: {} },
        { address: "aws_lambda_function_url.f", type: "aws_lambda_function_url", name: "f", values: { cors: [{ allow_origins: ["*"], allow_methods: ["*"] }] } },
      ];
      const addressToPath = { "aws_lambda_function.f": fnPath };
      const refs = { "aws_lambda_function_url.f": { function_name: ["aws_lambda_function.f"] } };
      const edges = applyFunctionUrls({
        resources, tfResources, addressToPath, refs,
        pathFor: (a) => "root/Default/" + a,
        addrFor: (p) => "c8" + Buffer.from(p).toString("hex").slice(0, 30).padEnd(30, "0"),
      });
      const apiPath = "root/Default/aws_lambda_function_url.f";
      assert.strictEqual(resources[apiPath].type, WING_TYPES.API, "function url -> Api");
      assert.strictEqual(edges.length, 1);
      assert.strictEqual(edges[0].route.method, "ANY");
    });

    await test("grants a function bucket access when it references a bucket", () => {
      const fnPath = "root/Default/aws_lambda_function.f";
      const bucketPath = "root/Default/aws_s3_bucket.b";
      const resources = {
        [fnPath]: { type: WING_TYPES.FUNCTION, path: fnPath, props: { environmentVariables: {} } },
        [bucketPath]: { type: WING_TYPES.BUCKET, path: bucketPath, props: {} },
      };
      const tfResources = [
        { address: "aws_lambda_function.f", type: "aws_lambda_function", name: "f" },
        { address: "aws_s3_bucket.b", type: "aws_s3_bucket", name: "b" },
      ];
      const addressToPath = {
        "aws_lambda_function.f": fnPath,
        "aws_s3_bucket.b": bucketPath,
      };
      const refs = { "aws_lambda_function.f": { environment: ["aws_s3_bucket.b"] } };
      const wired = applyCapabilities({ resources, tfResources, addressToPath, refs });
      assert.strictEqual(wired.length, 1);
      const fn = resources[fnPath];
      const buckets = JSON.parse(fn.props.environmentVariables.TF2WSIM_BUCKETS);
      assert.strictEqual(buckets.b, handleToken(bucketPath));
      assert.ok(fn.policy.some((p) => p.operation === "put" && p.resourceHandle === handleToken(bucketPath)));
      assert.ok(fn.deps.includes(bucketPath));
    });
  }

  console.log("generate (builder -> terraform):");
  {
    const { generate } = require("../src/generate");
    await test("emits provider, resources, handler, and event wiring", () => {
      const { files, warnings } = generate({
        nodes: [
          { id: "n1", type: "queue", name: "Orders", props: { visibilityTimeout: 45 } },
          { id: "n2", type: "function", name: "Worker", code: "" },
          { id: "n3", type: "bucket", name: "Archive" },
        ],
        edges: [{ source: "n1", target: "n2" }],
      });
      assert.strictEqual(warnings.length, 0);
      assert.ok(files["main.tf"].includes('resource "aws_sqs_queue" "orders"'));
      assert.ok(files["main.tf"].includes("visibility_timeout_seconds = 45"));
      assert.ok(files["main.tf"].includes('resource "aws_lambda_function" "worker"'));
      assert.ok(files["main.tf"].includes('resource "aws_s3_bucket" "archive"'));
      assert.ok(files["main.tf"].includes("aws_lambda_event_source_mapping"));
      assert.ok(files["src/worker.js"].includes("exports.handler"));
    });

    await test("uses inline handler code when provided", () => {
      const code = "exports.handler = async () => ({ custom: true });\n";
      const { files } = generate({
        nodes: [{ id: "f", type: "function", name: "Custom", code }],
        edges: [],
      });
      assert.strictEqual(files["src/custom.js"], code);
    });

    await test("warns on an edge whose target isn't a function", () => {
      const { warnings } = generate({
        nodes: [
          { id: "a", type: "queue", name: "Q" },
          { id: "b", type: "bucket", name: "B" },
        ],
        edges: [{ source: "a", target: "b" }],
      });
      assert.ok(warnings.some((w) => /must be a function/.test(w)));
    });

    await test("deduplicates colliding sanitized names", () => {
      const { files } = generate({
        nodes: [
          { id: "1", type: "queue", name: "My Queue" },
          { id: "2", type: "queue", name: "my-queue" },
        ],
        edges: [],
      });
      // both sanitize to "my_queue"; second must be suffixed
      assert.ok(files["main.tf"].includes('"my_queue"'));
      assert.ok(files["main.tf"].includes('"my_queue_2"'));
    });
  }

  console.log("synth:");
  if (haveExamplePlan) {
    await test("translates example plan.json into a loadable .wsim", async () => {
      const tfJson = JSON.parse(fs.readFileSync(planPath, "utf8"));
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "wsim-"));
      const res = synth({ tfJson, outDir, tfDir: exampleDir, sdkLibDir: sdkLibDir() });
      assert.ok(res.resourceCount >= 4, "expected >=4 resources");
      assert.strictEqual(res.edges.length, 1);
      const man = JSON.parse(fs.readFileSync(path.join(outDir, "simulator.json"), "utf8"));
      assert.ok(man.types["@winglang/sdk.cloud.Queue"], "queue type registered");
      assert.ok(man.resources["root/Default/EventMapping0"], "event mapping emitted");
    });

    await test("simulator invokes the lambda when a message is pushed", async () => {
      const { simulator } = require("@winglang/sdk");
      const tfJson = JSON.parse(fs.readFileSync(planPath, "utf8"));
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "wsim-"));
      synth({ tfJson, outDir, tfDir: exampleDir, sdkLibDir: sdkLibDir() });
      const sim = new simulator.Simulator({ simfile: outDir });
      let invoked = false;
      sim.onTrace({ callback: (t) => {
        if (t.data && String(t.data.message).includes("order-processor received")) invoked = true;
      }});
      await sim.start();
      const qp = sim.listResources().find((p) => p.includes("sqs_queue"));
      await sim.getResource(qp).push(JSON.stringify({ orderId: 1 }));
      await new Promise((r) => setTimeout(r, 1500));
      await sim.stop();
      assert.ok(invoked, "lambda handler was not invoked");
    });
  } else {
    console.log("  - skipped basic example tests (no plan.json)");
  }

  const uploadDir = path.join(__dirname, "..", "examples", "upload");
  const uploadPlan = path.join(uploadDir, "plan.json");
  if (fs.existsSync(uploadPlan)) {
    const http = require("http");
    const post = (base, p, body) =>
      new Promise((resolve, reject) => {
        const u = new URL(base);
        const r = http.request(
          { hostname: u.hostname, port: u.port, path: p, method: "POST", headers: { "content-type": "application/json" } },
          (res) => { let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve({ status: res.statusCode, body: d })); }
        );
        r.on("error", reject); r.write(body); r.end();
      });

    await test("upload example: api -> validate lambda -> bucket (image stored)", async () => {
      const { simulator } = require("@winglang/sdk");
      const tfJson = JSON.parse(fs.readFileSync(uploadPlan, "utf8"));
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "wsim-up-"));
      synth({ tfJson, outDir, tfDir: uploadDir, sdkLibDir: sdkLibDir() });
      const sim = new simulator.Simulator({ simfile: outDir });
      await sim.start();
      try {
        const apiPath = sim.listResources().find((p) => p.includes("apigatewayv2_api"));
        const apiUrl = sim.getResourceConfig(apiPath).attrs.url;
        const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
        const ok = await post(apiUrl, "/upload", JSON.stringify({ filename: "p.png", contentType: "image/png", dataBase64: png }));
        assert.strictEqual(ok.status, 200, `valid upload should 200, got ${ok.status}: ${ok.body}`);
        const bad = await post(apiUrl, "/upload", JSON.stringify({ filename: "n.txt", contentType: "text/plain", dataBase64: "aGk=" }));
        assert.strictEqual(bad.status, 415, "non-image should be rejected with 415");
        const bucketPath = sim.listResources().find((p) => p.includes("s3_bucket"));
        const list = await sim.getResource(bucketPath).list();
        assert.strictEqual(list.length, 1, "exactly one (valid) image should be stored");
      } finally {
        await sim.stop();
      }
    });
  }

  const siteDir = path.join(__dirname, "..", "examples", "website-upload");
  const sitePlan = path.join(siteDir, "plan.json");
  if (fs.existsSync(sitePlan)) {
    const http = require("http");
    const get = (url) =>
      new Promise((resolve, reject) => {
        const u = new URL(url);
        http.get({ hostname: u.hostname, port: u.port, path: u.pathname || "/" }, (res) => {
          let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve({ status: res.statusCode, body: d }));
        }).on("error", reject);
      });
    const post = (base, p, body) =>
      new Promise((resolve, reject) => {
        const u = new URL(base);
        const r = http.request({ hostname: u.hostname, port: u.port, path: p, method: "POST", headers: { "content-type": "application/json" } },
          (res) => { let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve({ status: res.statusCode, body: d })); });
        r.on("error", reject); r.write(body); r.end();
      });

    await test("website-upload example: site serves form, function URL stores image", async () => {
      const { simulator } = require("@winglang/sdk");
      const tfJson = JSON.parse(fs.readFileSync(sitePlan, "utf8"));
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "wsim-site-"));
      synth({ tfJson, outDir, tfDir: siteDir, sdkLibDir: sdkLibDir() });
      const sim = new simulator.Simulator({ simfile: outDir });
      await sim.start();
      try {
        const sitePath = sim.listResources().find((p) => p.includes("website_configuration"));
        const siteUrl = sim.getResourceConfig(sitePath).attrs.url;
        const page = await get(siteUrl + "/");
        assert.strictEqual(page.status, 200);
        assert.ok(/Upload an image/.test(page.body), "website should serve the upload form");

        const apiPath = sim.listResources().find((p) => p.includes("function_url"));
        const apiUrl = sim.getResourceConfig(apiPath).attrs.url;
        const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
        const up = await post(apiUrl, "/", JSON.stringify({ filename: "x.png", contentType: "image/png", dataBase64: png }));
        assert.strictEqual(up.status, 200, `function URL upload should 200: ${up.body}`);

        const storagePath = sim.listResources().find((p) => p.includes("s3_bucket.storage"));
        const list = await sim.getResource(storagePath).list();
        assert.strictEqual(list.length, 1, "image should be stored");
      } finally {
        await sim.stop();
      }
    });
  }

  console.log(`\n${passed} passed`);
}

main();
