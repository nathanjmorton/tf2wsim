"use strict";
// Maps individual Terraform resources (type + values) onto Wing simulator
// resource definitions. Each mapper returns { type, props } or null if the
// resource type isn't supported. Event wiring (Queue->Function etc.) is handled
// separately in wiring.js, not here.
const { WING_TYPES } = require("./constants");

// aws_s3_bucket -> cloud.Bucket
function mapBucket(tf) {
  return {
    type: WING_TYPES.BUCKET,
    props: {
      public: false,
      forceDestroy: !!tf.values.force_destroy,
      initialObjects: {},
      topics: {},
    },
  };
}

// aws_sqs_queue -> cloud.Queue
function mapQueue(tf) {
  const v = tf.values || {};
  // SQS visibility_timeout_seconds maps to Wing's per-message processing timeout.
  const timeout = v.visibility_timeout_seconds != null ? v.visibility_timeout_seconds : 30;
  // SQS message_retention_seconds (default 4 days) maps to retentionPeriod.
  const retentionPeriod = v.message_retention_seconds != null ? v.message_retention_seconds : 3600;
  return {
    type: WING_TYPES.QUEUE,
    props: { timeout, retentionPeriod },
  };
}

// aws_lambda_function -> cloud.Function
// `runtimeFile` is resolved by the caller (resolver.js) since TF only points at
// a zip; here we just record what we know. The caller injects sourceCodeFile.
function mapFunction(tf) {
  const v = tf.values || {};
  const env = {};
  // aws_lambda_function.environment is a list with one { variables = {...} }.
  const envBlock = Array.isArray(v.environment) ? v.environment[0] : v.environment;
  if (envBlock && envBlock.variables) Object.assign(env, envBlock.variables);
  // TF timeout is in seconds; Wing wants milliseconds.
  const timeoutMs = (v.timeout != null ? v.timeout : 3) * 1000;
  return {
    type: WING_TYPES.FUNCTION,
    props: {
      // sourceCodeFile filled in by resolver (handler bundle path).
      sourceCodeFile: null,
      sourceCodeLanguage: "javascript",
      environmentVariables: env,
      timeout: timeoutMs,
      concurrency: v.reserved_concurrent_executions > 0 ? v.reserved_concurrent_executions : 10,
    },
    // carry raw values forward for the resolver / wiring stages
    _raw: v,
  };
}

// aws_sns_topic -> cloud.Topic
function mapTopic(tf) {
  return { type: WING_TYPES.TOPIC, props: {} };
}

// aws_secretsmanager_secret -> cloud.Secret
function mapSecret(tf) {
  const v = tf.values || {};
  return { type: WING_TYPES.SECRET, props: { name: v.name || tf.name } };
}

const MAPPERS = {
  aws_s3_bucket: mapBucket,
  aws_sqs_queue: mapQueue,
  aws_lambda_function: mapFunction,
  aws_sns_topic: mapTopic,
  aws_secretsmanager_secret: mapSecret,
};

function mapResource(tf) {
  const fn = MAPPERS[tf.type];
  if (!fn) return null;
  const out = fn(tf);
  return out;
}

module.exports = { mapResource, MAPPERS };
