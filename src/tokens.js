"use strict";
// Helpers for producing Wing simulator tokens & addresses.
const crypto = require("crypto");

// A reference to another resource's runtime "handle" attribute. The Wing
// simulator resolves this at start() time once the target resource is up.
function handleToken(resourcePath) {
  return `\${wsim#${resourcePath}#attrs.handle}`;
}

// A reference to an arbitrary runtime attribute (e.g. a bucket/api url).
function attrToken(resourcePath, attr) {
  return `\${wsim#${resourcePath}#attrs.${attr}}`;
}

// Wing addresses are 32-hex-char ids prefixed with "c8". We derive a stable one
// from the resource path so re-running the translator is deterministic.
function addrFor(resourcePath) {
  const h = crypto.createHash("sha256").update(resourcePath).digest("hex");
  return "c8" + h.slice(0, 30);
}

module.exports = { handleToken, attrToken, addrFor };
