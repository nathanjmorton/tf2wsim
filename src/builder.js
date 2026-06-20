"use strict";
// A tiny HTTP server hosting the drag-and-drop Terraform builder UI. The canvas
// lets you drop Bucket/Queue/Function/Topic nodes, connect publisher→function
// edges, and edit each function's handler code inline. "Generate" writes the
// Terraform config (+ handler files) via src/generate.js into a target
// directory — which you can then open with `tf2wsim console <dir>`.
const fs = require("fs");
const path = require("path");
const http = require("http");
const { generate } = require("./generate");

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json" });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

// Write generated files into outDir, refusing to escape it.
function writeFiles(outDir, files) {
  const written = [];
  for (const [rel, contents] of Object.entries(files)) {
    const abs = path.resolve(outDir, rel);
    if (!abs.startsWith(path.resolve(outDir) + path.sep)) {
      throw new Error(`refusing to write outside target: ${rel}`);
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contents);
    written.push(rel);
  }
  return written;
}

function startBuilder({ outDir, port = 3100 }) {
  const uiPath = path.join(__dirname, "..", "ui", "builder.html");
  const resolvedOut = path.resolve(outDir);

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
        const html = fs.readFileSync(uiPath, "utf8");
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(html);
      }
      if (req.method === "GET" && req.url === "/api/target") {
        return sendJson(res, 200, { outDir: resolvedOut });
      }
      if (req.method === "POST" && req.url === "/api/generate") {
        const spec = await readBody(req);
        const { files, warnings } = generate(spec);
        const written = writeFiles(resolvedOut, files);
        return sendJson(res, 200, {
          ok: true,
          outDir: resolvedOut,
          written,
          warnings,
          mainTf: files["main.tf"],
        });
      }
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    } catch (err) {
      sendJson(res, 400, { ok: false, error: String(err.message || err) });
    }
  });

  return new Promise((resolve) => {
    server.listen(port, "0.0.0.0", () => resolve({ server, port }));
  });
}

module.exports = { startBuilder };
