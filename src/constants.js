"use strict";
// The construct-tree scope under which all resources live. The Wing Console's
// map view renders the children of `root/Default` (Wing nests an app's
// resources under a "Default" construct), so we mirror that layout to make the
// graph render.
module.exports.ROOT_SCOPE = "root/Default";

// Canonical Wing SDK simulator type FQNs and the inflight class that backs each.
// These match @winglang/sdk's target-sim SIMULATOR_CLASS_DATA table.
module.exports.WING_TYPES = {
  BUCKET: "@winglang/sdk.cloud.Bucket",
  QUEUE: "@winglang/sdk.cloud.Queue",
  FUNCTION: "@winglang/sdk.cloud.Function",
  TOPIC: "@winglang/sdk.cloud.Topic",
  SCHEDULE: "@winglang/sdk.cloud.Schedule",
  API: "@winglang/sdk.cloud.Api",
  SECRET: "@winglang/sdk.cloud.Secret",
  EVENT_MAPPING: "@winglang/sdk.sim.EventMapping",
};

// className for each FQN, used to build the simulator.json `types` table.
module.exports.WING_CLASSNAMES = {
  "@winglang/sdk.cloud.Bucket": "Bucket",
  "@winglang/sdk.cloud.Queue": "Queue",
  "@winglang/sdk.cloud.Function": "Function",
  "@winglang/sdk.cloud.Topic": "Topic",
  "@winglang/sdk.cloud.Schedule": "Schedule",
  "@winglang/sdk.cloud.Api": "Api",
  "@winglang/sdk.cloud.Secret": "Secret",
  "@winglang/sdk.sim.EventMapping": "EventMapping",
};

// inflight source file (relative to target-sim) for each FQN.
module.exports.WING_INFLIGHT_FILE = {
  "@winglang/sdk.cloud.Bucket": "bucket.inflight",
  "@winglang/sdk.cloud.Queue": "queue.inflight",
  "@winglang/sdk.cloud.Function": "function.inflight",
  "@winglang/sdk.cloud.Topic": "topic.inflight",
  "@winglang/sdk.cloud.Schedule": "schedule.inflight",
  "@winglang/sdk.cloud.Api": "api.inflight",
  "@winglang/sdk.cloud.Secret": "secret.inflight",
  "@winglang/sdk.sim.EventMapping": "event-mapping.inflight",
};
