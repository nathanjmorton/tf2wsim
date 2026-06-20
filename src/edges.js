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

  // --- aws_apigatewayv2 HTTP API: Api -> Lambda, carrying the route(s) ---
  // Pattern: route(api_id -> api, target -> integration); integration
  // (integration_uri -> lambda). We resolve route -> integration -> lambda and
  // attach the route's method+path so wiring.js can subscribe the function.
  const integrations = {}; // integration address -> lambda address
  for (const integ of grouped.aws_apigatewayv2_integration || []) {
    const r = refs[integ.address] || {};
    const lambda = pickRef(r.integration_uri, addressType, ["aws_lambda_function"]);
    if (lambda) integrations[integ.address] = lambda;
  }
  for (const route of grouped.aws_apigatewayv2_route || []) {
    const r = refs[route.address] || {};
    const api = pickRef(r.api_id, addressType, ["aws_apigatewayv2_api"]);
    // route.target references an integration ("integrations/<id>"); resolve it.
    const integ = pickRef(r.target, addressType, ["aws_apigatewayv2_integration"]);
    const lambda = integ ? integrations[integ] : null;
    if (!api || !lambda) continue;
    const routeKey = (route.values && route.values.route_key) || "$default";
    const { method, path } = parseRouteKey(routeKey);
    edges.push({ publisher: api, subscriber: lambda, route: { method, pathPattern: path } });
  }

  return edges;
}

// "POST /upload" -> { method:"POST", path:"/upload" }; "$default" -> ANY "/".
function parseRouteKey(routeKey) {
  if (routeKey === "$default") return { method: "ANY", path: "/" };
  const [method, path] = routeKey.split(/\s+/);
  return { method: (method || "ANY").toUpperCase(), path: path || "/" };
}

module.exports = { discoverEdges };
