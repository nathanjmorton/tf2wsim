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

// aws_cloudwatch_event_rule (schedule_expression) -> cloud.Schedule
function mapSchedule(tf) {
  const v = tf.values || {};
  // schedule_expression is "cron(...)" or "rate(...)". The sim Schedule parses
  // with cron-parser, which wants *standard 5-field* cron — not AWS's 6-field
  // form (which has a Year field and uses '?'). Convert.
  const expr = v.schedule_expression || "";
  const m = /^cron\((.*)\)$/.exec(expr);
  const cronExpression = m ? awsCronToStandard(m[1]) : "0/5 * * * *";
  return { type: WING_TYPES.SCHEDULE, props: { cronExpression } };
}

// AWS cron (minute hour day-of-month month day-of-week year) -> standard cron
// (minute hour day-of-month month day-of-week). Drops the year field and maps
// '?' (AWS "no specific value") to '*'.
function awsCronToStandard(aws) {
  const parts = aws.trim().split(/\s+/);
  const five = parts.length >= 6 ? parts.slice(0, 5) : parts.slice(0, 5);
  return five.map((p) => (p === "?" ? "*" : p)).join(" ");
}

// aws_apigatewayv2_api (HTTP API) -> cloud.Api
// The sim Api needs an openApiSpec; routes are attached later as event
// subscriptions (see edges.js / wiring.js), so a minimal spec is enough here.
function mapApi(tf) {
  return {
    type: WING_TYPES.API,
    props: {
      openApiSpec: { openapi: "3.0.3", info: { title: tf.name, version: "1.0" }, paths: {} },
      // CORS so a browser form served elsewhere can call it.
      corsHeaders: {
        defaultResponse: { "Access-Control-Allow-Origin": "*" },
        optionsResponse: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      },
    },
  };
}

const MAPPERS = {
  aws_s3_bucket: mapBucket,
  aws_sqs_queue: mapQueue,
  aws_lambda_function: mapFunction,
  aws_sns_topic: mapTopic,
  aws_secretsmanager_secret: mapSecret,
  aws_apigatewayv2_api: mapApi,
  aws_cloudwatch_event_rule: mapSchedule,
};

function mapResource(tf) {
  const fn = MAPPERS[tf.type];
  if (!fn) return null;
  const out = fn(tf);
  return out;
}

module.exports = { mapResource, MAPPERS };
