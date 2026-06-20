# tf2wsim

Drive the [Wing](https://github.com/winglang/wing) cloud simulator (and Console)
from a **Terraform** configuration — no Wing language or Wing compiler involved.

`tf2wsim` reads `terraform show -json` output, maps supported AWS resources onto
Wing's simulator resource primitives, reconstructs the event-source wiring that
Terraform spreads across multiple resources, and emits a `.wsim` directory that
the unmodified `@winglang/sdk` Simulator can open and run.

```
  main.tf ──terraform plan──▶ plan.json ──tf2wsim──▶ out.wsim ──▶ Wing Simulator / Console
```

## Why this works

The Wing SDK already separates the *language* from the *simulator* via a file
format. A `.wsim` directory is just three JSON files:

| file | contents |
|---|---|
| `simulator.json` | `{ sdkVersion, types, resources }` — the resource graph + a table mapping each type FQN to the inflight class that simulates it |
| `tree.json` | the construct tree (drives the Console's tree view) |
| `connections.json` | edges between resources (drives the Console's interaction graph) |

The Simulator loads `simulator.json`, and for each resource `require()`s the
inflight class named in the `types` table and calls `init(context)`. Nothing in
that path needs the Wing language — so we synthesize the JSON directly from
Terraform.

## Resource mapping

| Terraform | Wing sim type |
|---|---|
| `aws_s3_bucket` | `cloud.Bucket` |
| `aws_sqs_queue` | `cloud.Queue` |
| `aws_lambda_function` (Node.js) | `cloud.Function` |
| `aws_sns_topic` | `cloud.Topic` |
| `aws_secretsmanager_secret` | `cloud.Secret` |

### Event wiring (reconstructed from the TF graph)

| Terraform pattern | becomes |
|---|---|
| `aws_lambda_event_source_mapping` (SQS) | `sim.EventMapping` Queue→Function |
| `aws_sns_topic_subscription` | `sim.EventMapping` Topic→Function |
| `aws_s3_bucket_notification` | `sim.EventMapping` Bucket→Function |
| `aws_cloudwatch_event_target` | `sim.EventMapping` Schedule→Function |

The simulator enforces IAM-like policies, so for each edge tf2wsim also grants
the publisher the operations (`invoke`, `hasAvailableWorkers`, …) it needs on
the subscriber function.

## Usage

```bash
npm install

# from a Terraform directory (runs terraform plan for you):
node bin/tf2wsim.js build path/to/tfdir -o out.wsim

# or from an existing `terraform show -json` file:
node bin/tf2wsim.js build --json plan.json -o out.wsim

# load it in the simulator and print the resource list:
node bin/tf2wsim.js run out.wsim
```

See `examples/basic` for an SQS→Lambda example with a real Node handler.

## Lambda handler resolution

Terraform only points a Lambda at a deployment zip. tf2wsim unzips the local
`filename` package, finds the entry module from the `handler` setting
(`index.handler` → `index.js` exporting `handler`), and writes a thin shim that
exposes it as the `handler` the simulator calls.

**Limitations:** Node.js packages only; S3-sourced packages and non-Node
runtimes are reported and skipped. IAM/networking/provider-specific props that
have no local-sim meaning are ignored.

## Status / pinning

Pinned to `@winglang/sdk@0.85.49` (the last Wing release). The Wing project is
in wind-down, so pinning keeps the manifest schema stable underneath this tool.

## Architecture

```
src/
  parser.js     terraform show -json -> normalized resources + reference edges
  mappers.js    per-resource TF -> Wing type/props mapping
  edges.js      discover event-source wiring from the TF graph
  wiring.js     edges -> sim.EventMapping resources + publisher policies
  resolver.js   lambda zip -> runnable JS handler shim
  synth.js      orchestrates the above -> .wsim directory
  tokens.js     wsim token + address helpers
  constants.js  Wing type FQN / classname / inflight-file tables
bin/tf2wsim.js  CLI (build / run)
```

## License

MIT. Bundles ideas from the MIT-licensed Wing SDK.
