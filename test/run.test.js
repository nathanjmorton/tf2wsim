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
    console.log("  - skipped example tests (run: cd examples/basic && terraform init && terraform plan -out .p && terraform show -json .p > plan.json)");
  }

  console.log(`\n${passed} passed`);
}

main();
