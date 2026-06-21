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

## Quickstart

Prerequisites: **Node.js 18+**, **Terraform**, and **unzip** on your `PATH`.

**Build infrastructure visually** — drag-and-drop a graph, then one click runs
`terraform init` + the Console (no terminal beyond this):

```bash
git clone https://github.com/nathanjmorton/tf2wsim.git && cd tf2wsim && npm run builder
```

Open **http://localhost:3100/**, drag Queue/Function/Bucket nodes onto the
canvas, wire an edge from a publisher to a function, then click **Init & Open
Console** — it generates the Terraform, initializes it, starts the simulator,
and opens the Console once everything is running.

**Or run the prebuilt example** straight in the Console:

```bash
git clone https://github.com/nathanjmorton/tf2wsim.git && cd tf2wsim && npm run quickstart
```

That installs dependencies, initializes the example Terraform project in
`examples/basic` (an SQS → Lambda app), and launches the Wing Console on it.
Open **http://localhost:3000/** and you'll see the resource tree and the live
map graph with the event edge from `aws_sqs_queue.work` to
`aws_lambda_function.processor`. Push a message to the queue from its panel to
watch the Lambda fire. Press `Ctrl-C` to stop; set `PORT=4000` to use a
different port.

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
| `aws_apigatewayv2_api` (HTTP API) | `cloud.Api` |
| `aws_lambda_function_url` | synthetic `cloud.Api` (catch-all route to the function) |
| `aws_s3_bucket_website_configuration` (+ `aws_s3_object`) | `cloud.Website` (static files materialized) |

### Event wiring (reconstructed from the TF graph)

| Terraform pattern | becomes |
|---|---|
| `aws_lambda_event_source_mapping` (SQS) | `sim.EventMapping` Queue→Function |
| `aws_sns_topic_subscription` | `sim.EventMapping` Topic→Function |
| `aws_s3_bucket_notification` | `sim.EventMapping` Bucket→Function |
| `aws_cloudwatch_event_target` | `sim.EventMapping` Schedule→Function |
| `aws_apigatewayv2_route` + `_integration` | `sim.EventMapping` Api→Function (method + path) |

The simulator enforces IAM-like policies, so for each edge tf2wsim also grants
the publisher the operations (`invoke`, `hasAvailableWorkers`, …) it needs on
the subscriber function.

### Capabilities (Function → Bucket)

When a Lambda *references* an S3 bucket (e.g. `environment { variables = {
STORAGE_BUCKET = aws_s3_bucket.storage.bucket } }`), tf2wsim grants it bucket
access in the simulator: it injects an env var `TF2WSIM_BUCKETS` mapping the
bucket's Terraform name to its runtime handle, and adds the `put`/`get`/`list`/…
policies. Handler code reaches the bucket with:

```js
const { makeSimulatorClient } = require("@winglang/sdk/lib/simulator/client");
const handle = JSON.parse(process.env.TF2WSIM_BUCKETS).storage;
const bucket = makeSimulatorClient(
  process.env.WING_SIMULATOR_URL, handle, process.env.WING_SIMULATOR_CALLER);
await bucket.put(key, data);
```

## Usage

```bash
npm install

# from a Terraform directory (runs terraform plan for you):
node bin/tf2wsim.js build path/to/tfdir -o out.wsim

# or from an existing `terraform show -json` file:
node bin/tf2wsim.js build --json plan.json -o out.wsim

# load it in the simulator and print the resource list:
node bin/tf2wsim.js run out.wsim

# open the Wing Console on the Terraform graph (interactive UI):
node bin/tf2wsim.js console path/to/tfdir -p 3000
# ...or against a prebuilt plan.json:
node bin/tf2wsim.js console plan.json -p 3000

# open the drag-and-drop builder to author Terraform visually:
node bin/tf2wsim.js builder path/to/new-project -p 3100
```

See `examples/basic` for an SQS→Lambda example with a real Node handler.

Starting the Console prints a live progress spinner through each phase
(`terraform plan` → translate → start simulator) and only prints the
`open: http://localhost:…` line once the simulator's resources are actually
running — so you never click a half-loaded URL. If `terraform plan` fails (e.g.
you forgot `terraform init`), the error is surfaced immediately instead of
hanging.

## The Builder (Terraform from a canvas)

`tf2wsim builder <outdir>` is the inverse of the translator: a drag-and-drop
canvas that *generates* Terraform. Drag Bucket / Queue / Function / Topic nodes
onto the canvas, drag from a publisher's right port to a Function's left port
to wire a trigger, and edit each Function's handler **inline** (or upload a
standalone `.js`/`.mjs` file). The default handler takes the event and returns
an editable default result.

Two buttons:

- **Generate Terraform** writes `main.tf` plus one `src/<name>.js` per function
  into the target directory (and previews the generated `main.tf`).
- **Init & Open Console** does the whole loop for you — generate →
  `terraform init` (first time only) → start the Wing Console on the project →
  open it in a new tab once the simulator is up. The inspector shows live
  progress through each phase, and surfaces any `terraform` error inline.

Start it from the CLI or the script:

```bash
npm run builder                          # installs deps, opens the builder on :3100
# or directly:
node bin/tf2wsim.js builder ./my-project -p 3100 --console-port 3000
```

The launched Console runs as a child process and is torn down when you stop the
builder. The builder is a self-contained HTML canvas (`ui/builder.html`) served
by `src/builder.js`; generation logic lives in `src/generate.js` and is
mapper-for-mapper symmetric with the resource table above.

> On an exe.dev VM, reach the builder at `https://<vm>.exe.xyz:3100/` and the
> launched Console at `https://<vm>.exe.xyz:3000/` — the "Open the Console" link
> is rewritten to the proxy host automatically.

## The Console

`tf2wsim console` boots the real [Wing Console](https://www.npmjs.com/package/@wingconsole/app)
(`@wingconsole/app@0.85.49`) but feeds it a `.wsim` produced from Terraform
instead of from a compiled Wing program. You get the full Console experience
— a resource hierarchy, an interaction panel per resource, and a live trace log
— driven entirely by your `.tf`.

**How the seam works:** the Console's server calls
`require("@winglang/compiler").compile(wingfile)` and uses the returned
`outputDir` as the simulator file. `src/console.js` installs a `Module._load`
hook that intercepts `@winglang/compiler` and swaps in our own `compile` that
runs `terraform plan` + tf2wsim's `synth()` and returns the resulting `.wsim`
directory in the `{ outputDir, wingcErrors, preflightError }` shape the Console
expects. The Console never knows it isn't talking to the Wing compiler.

Because the Console also watches the source directory, editing the `.tf`
re-plans and live-reloads the simulated graph.

### Resource map

The center canvas renders the resource graph with the event edges between
nodes (e.g. an arrow from `aws_sqs_queue.work` to
`aws_lambda_function.processor`). The Console's map view renders the children
of the `root/Default` construct scope, so tf2wsim nests every resource under
`root/Default/<tf-address>` to match — see `ROOT_SCOPE` in `src/constants.js`.

### State-lock cleanup

The simulator guards its state directory with a lockfile
(`<wsim>/.state/.lock`). If a Console is killed uncleanly, that lock can linger
and block the next run with *"Another instance of the simulator is already
running"*. tf2wsim makes recovery deterministic: it writes an ownership pidfile
(`.tf2wsim-owner`) next to the lock, and on startup:

- **no lock** → record our PID and continue;
- **lock owned by a dead PID (or unknown)** → orphaned, so remove it and take over;
- **lock owned by a live PID** → a real instance is running, so refuse with a clear error.

On `SIGINT`/`SIGTERM` the Console also tries to stop the simulator (releasing
the lock), with a hard-timeout fallback so shutdown never hangs.

In the screenshot below, pushing a message to `aws_sqs_queue.work` from the
Console's *Push Message* box flows through the reconstructed event mapping and
invokes `aws_lambda_function.processor` — all defined in `main.tf`, none of it
Wing:

```
order-processor received: {"messages":[{ "payload":"{\"orderId\":7,...}" }]}
  -> aws_lambda_function.processor
```

The Queue's panel even shows **Timeout: 45s**, mapped straight from the
`visibility_timeout_seconds = 45` in the Terraform config.

## Example: image upload (website → Function URL → S3)

`examples/website-upload` is a real, useful end-to-end flow defined entirely in
Terraform and run entirely in the simulator:

1. an **S3 website bucket** serves an upload form (`aws_s3_object` → served by
   `cloud.Website`),
2. the form posts to a **Lambda Function URL** (`aws_lambda_function_url` → a
   synthetic `cloud.Api`),
3. the **Lambda validates** the request (image type + size limit) and
4. **stores the image** in an S3 storage bucket.

Run it with one command:

```bash
npm run example:upload
```

When the Console is ready, use the floating **“\u{1F517} Open\u2026” launcher**
(bottom-right of the Console) to open the upload form — or go straight to it:

```
http://localhost:3000/tf2wsim/site/aws_s3_bucket_website_configuration.site/
```

Drop in an image — it flows **website → Function URL → validator Lambda → S3** and
appears in the Console's Bucket panel, where you can **preview and download** it
(the bytes come back intact — see *binary files* below). Non-image uploads are
rejected with `415`.

> `examples/upload` is the simpler API-Gateway variant of the same flow, with a
> built-in form at `/tf2wsim/upload`.

### The “Open…” launcher

The Console doesn't know about our website/form routes, so the bridge injects a
small floating launcher into the Console's page that links to any running sim
Website and the built-in upload form — no URL-pasting. (It's injected by
intercepting the Console's `index.html`; the Console UI is otherwise untouched.)

### Binary files (and the download fix)

The sim Bucket stores **UTF-8 text only** — its `get()` uses a *fatal* UTF-8
decoder, so raw image bytes can't be read back (downloads would fail). The Wing
Console's own convention is that binary-by-extension files (`.png`, `.jpg`, …)
are carried as **base64** for both upload and download. So the validator Lambda
stores the base64 string (which the form already sends), and the Console's
Download button base64-decodes it back to the exact original bytes.

### Lambda Function URLs

A `aws_lambda_function_url` is a direct HTTPS endpoint for one function — no API
Gateway, no routes, no integrations. tf2wsim maps it to a synthetic `cloud.Api`
with a catch-all route bound to that function, so it's **one Terraform resource
instead of three** (`api` + `integration` + `route`) for the common case.

### The browser bridge

There's a wrinkle worth knowing: each simulated resource (Api, Bucket) binds an
*ephemeral localhost port*, reachable from inside the VM but **not from your
browser** through the exe.dev proxy. Only the Console's own server is
browser-reachable. So tf2wsim mounts a small **bridge** on the Console's express
server (via `onExpressCreated`):

| route | purpose |
|---|---|
| `GET /tf2wsim/upload` | serves the built-in upload form |
| `GET /tf2wsim/apis` | lists running sim Apis (+ their live URLs) |
| `ALL /tf2wsim/call/<apiName>/<path>` | forwards a browser request to that sim Api |
| `GET /tf2wsim/sites` | lists running sim Websites (+ proxy URLs) |
| `ALL /tf2wsim/site/<name>/<path>` | proxies the sim Website (so the browser can load it) |

The bridge finds a running Api's port from its sim state
(`<wsim>/.state/<addr>/state.json`), and a Website's live URL via the Console's
own `website.url` tRPC endpoint. See `src/bridge.js`.

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
  capabilities.js Function -> Bucket access (handle env vars + storage policies)
  funcurl.js    aws_lambda_function_url -> synthetic single-route cloud.Api
  website.js    S3 website hosting -> cloud.Website (materializes aws_s3_object files)
  bridge.js     browser-reachable upload form + sim-Api/Website proxy (mounted on Console)
  resolver.js   lambda zip -> runnable JS handler shim
  synth.js      orchestrates the above -> .wsim directory
  console.js    boots the Wing Console (compiler intercept, progress, lock reclaim)
  generate.js   inverse: builder graph -> Terraform config + handler files
  builder.js    HTTP server hosting the drag-and-drop builder UI
  tokens.js     wsim token + address helpers
  constants.js  Wing type FQN / classname / inflight-file tables
ui/builder.html the drag-and-drop canvas (vanilla JS, self-contained)
bin/tf2wsim.js  CLI (build / run / console / builder)
scripts/quickstart.sh  install + run the example in the Console (npm run quickstart)
scripts/builder.sh     install + open the drag-and-drop builder (npm run builder)
```

## License

MIT. Bundles ideas from the MIT-licensed Wing SDK.
