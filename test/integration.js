const { simulator } = require("@winglang/sdk");
const path = require("path");

async function main() {
  const dir = process.argv[2];
  const sim = new simulator.Simulator({ simfile: dir });
  let invoked = false;
  sim.onTrace({ callback: (t) => {
    const m = t.data && t.data.message;
    if (m) {
      if (String(m).includes("order-processor received")) invoked = true;
      console.log(`[${t.level}] ${t.sourcePath}: ${m}`);
    }
  }});
  await sim.start();
  const queuePath = sim.listResources().find(p => p.includes("sqs_queue"));
  const q = sim.getResource(queuePath);
  await q.push(JSON.stringify({ orderId: 42 }));
  await new Promise(r => setTimeout(r, 1500));
  await sim.stop();
  console.log(invoked ? "\nPASS: lambda was invoked via SQS event mapping" : "\nFAIL: lambda not invoked");
  process.exit(invoked ? 0 : 1);
}
main().catch(e => { console.error(e); process.exit(1); });
