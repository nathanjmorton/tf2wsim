"use strict";
// Reconstructs event-source wiring from a Terraform graph and emits Wing
// sim.EventMapping resources plus the IAM-like policy statements the simulator
// requires for a publisher to invoke a subscriber Function.
//
// Terraform spreads "X triggers Lambda" across several resource types:
//   - aws_lambda_event_source_mapping { event_source_arn -> SQS, function_name -> Lambda }
//   - aws_sns_topic_subscription      { topic_arn -> SNS, endpoint -> Lambda }
//   - aws_s3_bucket_notification      { bucket -> S3, lambda_function[].lambda_function_arn -> Lambda }
//   - aws_cloudwatch_event_target     { rule -> schedule, arn -> Lambda }
// We detect each pattern, resolve the publisher & subscriber to their Wing
// resource paths, and synthesize an EventMapping.
const { WING_TYPES } = require("./constants");
const { handleToken } = require("./tokens");

// Per-publisher: which subscriptionProps the sim resource expects, and which
// operations the publisher must be granted on the subscriber Function.
const PUBLISHER_SPEC = {
  [WING_TYPES.QUEUE]: {
    subProps: () => ({ batchSize: 1 }),
    grants: ["hasAvailableWorkers", "invoke", "invokeAsync"],
  },
  [WING_TYPES.TOPIC]: {
    subProps: () => ({}),
    grants: ["invokeAsync"],
  },
  [WING_TYPES.SCHEDULE]: {
    subProps: () => ({}),
    grants: ["invoke"],
  },
};

// Given the wiring "edges" discovered from the TF graph, build EventMapping
// resource definitions and attach policy statements to the publisher resources.
//
//   edges: [{ publisherPath, subscriberPath }]
//   resources: the resource map being built (path -> { type, path, props, ... })
function applyWiring(edges, resources) {
  const mappings = {};
  let i = 0;
  for (const edge of edges) {
    const pub = resources[edge.publisherPath];
    const sub = resources[edge.subscriberPath];
    if (!pub || !sub) continue;
    if (sub.type !== WING_TYPES.FUNCTION) continue;
    const spec = PUBLISHER_SPEC[pub.type];
    if (!spec) continue;

    // grant the publisher permission to invoke the subscriber function
    pub.policy = pub.policy || [];
    for (const op of spec.grants) {
      pub.policy.push({ operation: op, resourceHandle: handleToken(edge.subscriberPath) });
    }

    const path = `root/EventMapping${i++}`;
    mappings[path] = {
      type: WING_TYPES.EVENT_MAPPING,
      path,
      props: {
        publisher: handleToken(edge.publisherPath),
        subscriber: handleToken(edge.subscriberPath),
        subscriptionProps: spec.subProps(),
      },
      deps: [edge.publisherPath, edge.subscriberPath],
    };
  }
  return mappings;
}

module.exports = { applyWiring, PUBLISHER_SPEC };
