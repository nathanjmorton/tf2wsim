"use strict";
// Discovers "publisher triggers subscriber-Lambda" edges from the Terraform
// graph. Each TF pattern that wires an event source to a Lambda becomes one
// edge { publisher: <tf address>, subscriber: <tf address> }.
//
// We rely on the `refs` map (built by parser.js from the configuration block)
// to resolve which concrete resource an argument like `event_source_arn` or
// `function_name` points at, since planned values only carry literal strings.

function byType(resources) {
  const m = {};
  for (const r of resources) (m[r.type] = m[r.type] || []).push(r);
  return m;
}

// From a list of referenced addresses, pick the first whose TF type is in
// `wanted`. Returns the address or null.
function pickRef(refList, addressType, wanted) {
  for (const addr of refList || []) {
    if (wanted.includes(addressType[addr])) return addr;
  }
  return null;
}

function discoverEdges(resources, refs) {
  const edges = [];
  const grouped = byType(resources);
  const addressType = {};
  for (const r of resources) addressType[r.address] = r.type;

  // --- aws_lambda_event_source_mapping: SQS/Kinesis/Dynamo -> Lambda ---
  for (const esm of grouped.aws_lambda_event_source_mapping || []) {
    const r = refs[esm.address] || {};
    const publisher = pickRef(r.event_source_arn, addressType, [
      "aws_sqs_queue",
    ]);
    const subscriber = pickRef(r.function_name, addressType, [
      "aws_lambda_function",
    ]);
    if (publisher && subscriber) edges.push({ publisher, subscriber });
  }

  // --- aws_sns_topic_subscription: SNS -> Lambda ---
  for (const sub of grouped.aws_sns_topic_subscription || []) {
    const r = refs[sub.address] || {};
    const publisher = pickRef(r.topic_arn, addressType, ["aws_sns_topic"]);
    const subscriber = pickRef(r.endpoint, addressType, ["aws_lambda_function"]);
    if (publisher && subscriber) edges.push({ publisher, subscriber });
  }

  // --- aws_s3_bucket_notification: S3 -> Lambda ---
  // (bucket is the publisher; lambda_function blocks list the subscribers)
  for (const n of grouped.aws_s3_bucket_notification || []) {
    const r = refs[n.address] || {};
    const publisher = pickRef(r.bucket, addressType, ["aws_s3_bucket"]);
    // references for nested lambda_function blocks are flattened by the parser
    const subs = (r.lambda_function || []).filter(
      (a) => addressType[a] === "aws_lambda_function"
    );
    for (const subscriber of subs) {
      if (publisher) edges.push({ publisher, subscriber });
    }
  }

  // --- aws_cloudwatch_event_target: EventBridge schedule rule -> Lambda ---
  for (const t of grouped.aws_cloudwatch_event_target || []) {
    const r = refs[t.address] || {};
    const publisher = pickRef(r.rule, addressType, [
      "aws_cloudwatch_event_rule",
    ]);
    const subscriber = pickRef(r.arn, addressType, ["aws_lambda_function"]);
    if (publisher && subscriber) edges.push({ publisher, subscriber });
  }

  return edges;
}

module.exports = { discoverEdges };
