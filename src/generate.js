"use strict";
// Inverse of the translator: given a visual graph (nodes + edges + per-function
// handler code), generate a Terraform configuration plus Lambda handler files
// that the rest of tf2wsim (plan → synth → Console) already understands.
//
// Graph spec shape:
//   {
//     nodes: [{ id, type, name, props?, code? }],
//     edges: [{ source, target }]   // source/target are node ids
//   }
// where type ∈ { bucket, queue, function, topic }.
//
// We emit:
//   - main.tf            the provider + resources + event wiring
//   - src/<name>.js      one file per function (from inline `code` or default)
// and return { files: { path: contents } } for the caller to write.

const TYPE_TF = {
  bucket: "aws_s3_bucket",
  queue: "aws_sqs_queue",
  function: "aws_lambda_function",
  topic: "aws_sns_topic",
  schedule: "aws_cloudwatch_event_rule",
  website: "aws_s3_bucket_website_configuration",
};

// A sane default Node handler: receives the event, logs it, returns a default
// result the user can edit. Kept intentionally tiny and dependency-free.
function defaultHandlerCode(name) {
  return (
    `// Handler for ${name}. Receives the trigger event and returns a result.\n` +
    `// Edit freely — it runs in the Wing simulator's Node sandbox.\n` +
    `exports.handler = async (event) => {\n` +
    `  console.log(${JSON.stringify(name)}, "received:", JSON.stringify(event));\n` +
    `  return { ok: true, handledBy: ${JSON.stringify(name)} };\n` +
    `};\n`
  );
}

// Sanitize a user-provided name into a valid Terraform identifier + AWS-ish
// resource name. Falls back to the type if empty.
function sanitize(name, fallback) {
  const base = String(name || fallback).trim().toLowerCase();
  const id = base.replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || fallback;
  return id;
}

function hclString(s) {
  return '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

const PROVIDER_BLOCK = `terraform {
  required_providers {
    aws     = { source = "hashicorp/aws", version = "~> 5.0" }
    archive = { source = "hashicorp/archive", version = "~> 2.0" }
  }
}

provider "aws" {
  region                      = "us-east-1"
  access_key                  = "test"
  secret_key                  = "test"
  skip_credentials_validation = true
  skip_requesting_account_id  = true
  skip_metadata_api_check     = true
}
`;

function generate(spec) {
  const nodes = spec.nodes || [];
  const edges = spec.edges || [];
  const files = {};
  const blocks = [PROVIDER_BLOCK];
  const warnings = [];

  // Assign each node a stable, unique TF local name.
  const used = new Set();
  const tfName = {};
  for (const n of nodes) {
    let nm = sanitize(n.name, n.type);
    let i = 2;
    while (used.has(nm)) nm = `${sanitize(n.name, n.type)}_${i++}`;
    used.add(nm);
    tfName[n.id] = nm;
  }
  const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));

  for (const n of nodes) {
    const name = tfName[n.id];
    if (n.type === "bucket") {
      blocks.push(
        `resource "aws_s3_bucket" "${name}" {\n` +
          `  bucket        = ${hclString(name + "-bucket")}\n` +
          `  force_destroy = true\n` +
          `}`
      );
    } else if (n.type === "queue") {
      const vis = (n.props && n.props.visibilityTimeout) || 30;
      const ret = (n.props && n.props.retention) || 3600;
      blocks.push(
        `resource "aws_sqs_queue" "${name}" {\n` +
          `  name                       = ${hclString(name + "-queue")}\n` +
          `  visibility_timeout_seconds = ${Number(vis)}\n` +
          `  message_retention_seconds  = ${Number(ret)}\n` +
          `}`
      );
    } else if (n.type === "topic") {
      blocks.push(
        `resource "aws_sns_topic" "${name}" {\n` +
          `  name = ${hclString(name + "-topic")}\n` +
          `}`
      );
    } else if (n.type === "function") {
      const handlerFile = `src/${name}.js`;
      files[handlerFile] = n.code && n.code.trim() ? n.code : defaultHandlerCode(name);
      const timeout = (n.props && n.props.timeout) || 30;
      const env = (n.props && n.props.env) || {};
      const envHcl = Object.keys(env).length
        ? `\n  environment {\n    variables = {\n` +
          Object.entries(env)
            .map(([k, v]) => `      ${k} = ${hclString(v)}`)
            .join("\n") +
          `\n    }\n  }`
        : "";
      blocks.push(
        `data "archive_file" "${name}_zip" {\n` +
          `  type        = "zip"\n` +
          `  source_file = "\${path.module}/${handlerFile}"\n` +
          `  output_path = "\${path.module}/build/${name}.zip"\n` +
          `}\n\n` +
          `resource "aws_lambda_function" "${name}" {\n` +
          `  function_name = ${hclString(name)}\n` +
          `  filename      = data.archive_file.${name}_zip.output_path\n` +
          `  handler       = "${name}.handler"\n` +
          `  runtime       = "nodejs20.x"\n` +
          `  role          = "arn:aws:iam::000000000000:role/lambda"\n` +
          `  timeout       = ${Number(timeout)}` +
          envHcl +
          `\n}`
      );
      // Optional Lambda Function URL (direct HTTP endpoint, no API Gateway).
      if (n.props && n.props.functionUrl) {
        blocks.push(
          `resource "aws_lambda_function_url" "${name}" {\n` +
            `  function_name      = aws_lambda_function.${name}.function_name\n` +
            `  authorization_type = "NONE"\n` +
            `  cors {\n` +
            `    allow_origins = ["*"]\n` +
            `    allow_methods = ["*"]\n` +
            `  }\n` +
            `}`
        );
      }
    } else if (n.type === "schedule") {
      // EventBridge schedule rule. The cron expression triggers a function via
      // an aws_cloudwatch_event_target edge (added in the wiring loop below).
      const cron = (n.props && n.props.cron) || "0/5 * * * ? *";
      blocks.push(
        `resource "aws_cloudwatch_event_rule" "${name}" {\n` +
          `  name                = ${hclString(name + "-rule")}\n` +
          `  schedule_expression = "cron(${cron})"\n` +
          `}`
      );
    } else if (n.type === "website") {
      // S3 static website: a bucket + website configuration + an index.html
      // object materialized from the node's inline HTML.
      const htmlFile = `site/${name}/index.html`;
      files[htmlFile] = n.code && n.code.trim() ? n.code : defaultWebsiteHtml(name);
      blocks.push(
        `resource "aws_s3_bucket" "${name}" {\n` +
          `  bucket        = ${hclString(name + "-site")}\n` +
          `  force_destroy = true\n` +
          `}\n\n` +
          `resource "aws_s3_bucket_website_configuration" "${name}" {\n` +
          `  bucket = aws_s3_bucket.${name}.id\n` +
          `  index_document {\n    suffix = "index.html"\n  }\n` +
          `}\n\n` +
          `resource "aws_s3_object" "${name}_index" {\n` +
          `  bucket       = aws_s3_bucket.${name}.id\n` +
          `  key          = "index.html"\n` +
          `  source       = "\${path.module}/${htmlFile}"\n` +
          `  content_type = "text/html"\n` +
          `}`
      );
    } else {
      warnings.push(`Unknown node type "${n.type}" (node ${n.id}) — skipped.`);
    }
  }

  // Event wiring. Only publisher→function edges are meaningful; map each to the
  // Terraform resource that wires that trigger.
  let esmCount = 0;
  let snsCount = 0;
  let s3Count = 0;
  let schedCount = 0;
  for (const e of edges) {
    const src = byId[e.source];
    const tgt = byId[e.target];
    if (!src || !tgt) continue;
    if (tgt.type !== "function") {
      warnings.push(
        `Edge ${e.source}→${e.target} ignored: target must be a function.`
      );
      continue;
    }
    const s = tfName[e.source];
    const t = tfName[e.target];
    if (src.type === "queue") {
      blocks.push(
        `resource "aws_lambda_event_source_mapping" "esm_${esmCount++}" {\n` +
          `  event_source_arn = aws_sqs_queue.${s}.arn\n` +
          `  function_name    = aws_lambda_function.${t}.arn\n` +
          `  batch_size       = 1\n` +
          `}`
      );
    } else if (src.type === "topic") {
      blocks.push(
        `resource "aws_sns_topic_subscription" "sns_${snsCount++}" {\n` +
          `  topic_arn = aws_sns_topic.${s}.arn\n` +
          `  protocol  = "lambda"\n` +
          `  endpoint  = aws_lambda_function.${t}.arn\n` +
          `}`
      );
    } else if (src.type === "bucket") {
      blocks.push(
        `resource "aws_s3_bucket_notification" "s3_${s3Count}" {\n` +
          `  bucket = aws_s3_bucket.${s}.id\n` +
          `  lambda_function {\n` +
          `    lambda_function_arn = aws_lambda_function.${t}.arn\n` +
          `    events              = ["s3:ObjectCreated:*"]\n` +
          `  }\n` +
          `}`
      );
      s3Count++;
    } else if (src.type === "schedule") {
      blocks.push(
        `resource "aws_cloudwatch_event_target" "sched_${schedCount++}" {\n` +
          `  rule = aws_cloudwatch_event_rule.${s}.name\n` +
          `  arn  = aws_lambda_function.${t}.arn\n` +
          `}`
      );
    } else {
      warnings.push(
        `Edge ${e.source}→${e.target} ignored: ${src.type} cannot trigger a function.`
      );
    }
  }

  files["main.tf"] = blocks.join("\n\n") + "\n";
  return { files, warnings };
}

function defaultWebsiteHtml(name) {
  return (
    `<!doctype html>\n<meta charset="utf-8"/>\n<title>${name}</title>\n` +
    `<h1>${name}</h1>\n<p>Served from an S3 website bucket.</p>\n`
  );
}

module.exports = { generate, defaultHandlerCode, defaultWebsiteHtml, TYPE_TF };
