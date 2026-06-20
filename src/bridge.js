"use strict";
// A browser-reachable bridge mounted on the Console's own Express server (which
// IS reachable through the exe.dev proxy, unlike the sim Api's ephemeral
// localhost port). It serves a built-in upload form and forwards form POSTs to
// the running sim Api, so you can actually upload an image from your browser.
//
// How it finds the sim Api: the Api inflight persists its bound port in the
// resource's sim state dir (<wsim>/.state/<addr>/state.json -> { lastPort }).
// We read the manifest to find Api resources and their addrs, then read that
// state file to get the live URL. This needs no access to the Console's
// internals — just the .wsim directory the compiler produced.
const fs = require("fs");
const path = require("path");
const http = require("http");

// Find { path, url } for every running sim Api in the given .wsim dir.
function discoverApis(wsimDir) {
  const out = [];
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(wsimDir, "simulator.json"), "utf8"));
  } catch {
    return out;
  }
  for (const [rpath, def] of Object.entries(manifest.resources || {})) {
    if (def.type !== "@winglang/sdk.cloud.Api") continue;
    const stateFile = path.join(wsimDir, ".state", def.addr, "state.json");
    let port;
    try {
      port = JSON.parse(fs.readFileSync(stateFile, "utf8")).lastPort;
    } catch {
      port = undefined;
    }
    out.push({ path: rpath, name: rpath.split("/").pop(), url: port ? `http://127.0.0.1:${port}` : null });
  }
  return out;
}

// List Website resource paths from the manifest. Their live URL is a runtime
// attribute (not on disk), so we resolve it lazily via the Console's own tRPC
// `website.url` endpoint at request time (see websiteUrl below).
function websitePaths(wsimDir) {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(wsimDir, "simulator.json"), "utf8"));
  } catch {
    return [];
  }
  return Object.entries(manifest.resources || {})
    .filter(([, def]) => def.type === "@winglang/sdk.cloud.Website")
    .map(([rpath]) => ({ path: rpath, name: rpath.split("/").pop() }));
}

// Ask the Console's own server (on `selfPort`) for a Website's live URL.
function websiteUrl(selfPort, resourcePath) {
  return new Promise((resolve) => {
    const input = encodeURIComponent(JSON.stringify({ resourcePath }));
    http
      .get({ host: "127.0.0.1", port: selfPort, path: `/trpc/website.url?input=${input}`, timeout: 3000 }, (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => {
          try {
            const url = JSON.parse(d).result.data;
            resolve(url || null);
          } catch {
            resolve(null);
          }
        });
      })
      .on("error", () => resolve(null))
      .on("timeout", function () { this.destroy(); resolve(null); });
  });
}

function forward(apiUrl, method, routePath, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(apiUrl);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: routePath,
        method,
        headers,
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
      }
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
  });
}

// Mount the bridge routes on the Console's express app. `getWsimDir` returns the
// current .wsim directory (it can change across reloads). `getSelfPort` returns
// the Console's own listening port (used to resolve Website URLs via tRPC).
function mountBridge(app, getWsimDir, getSelfPort) {
  // List the running APIs (for the form's dropdown).
  app.get("/tf2wsim/apis", (req, res) => {
    res.json({ apis: discoverApis(getWsimDir()) });
  });

  // List running Websites with their (proxied) browser-reachable URLs.
  app.get("/tf2wsim/sites", async (req, res) => {
    const sites = websitePaths(getWsimDir());
    res.json({
      sites: sites.map((s) => ({ name: s.name, path: s.path, proxy: `/tf2wsim/site/${s.name}/` })),
    });
  });

  // Proxy a Website: GET /tf2wsim/site/<name>/<assetPath> -> the sim Website.
  app.all(/^\/tf2wsim\/site\/([^/]+)(\/.*)?$/, async (req, res) => {
    const name = req.params[0];
    const assetPath = req.params[1] || "/";
    const site = websitePaths(getWsimDir()).find((s) => s.name === name);
    if (!site) {
      res.status(404).json({ error: `no website named "${name}"` });
      return;
    }
    const url = await websiteUrl(getSelfPort ? getSelfPort() : 0, site.path);
    if (!url) {
      res.status(503).json({ error: `website "${name}" is not running yet` });
      return;
    }
    try {
      const r = await forward(url, req.method, assetPath, {}, null);
      res.status(r.status);
      if (r.headers["content-type"]) res.set("content-type", r.headers["content-type"]);
      res.send(r.body);
    } catch (err) {
      res.status(502).json({ error: String(err.message || err) });
    }
  });

  // Forward a call to a named sim Api: POST /tf2wsim/call/<apiName><routePath>
  app.all(/^\/tf2wsim\/call\/([^/]+)(\/.*)?$/, async (req, res) => {
    const apiName = req.params[0];
    const routePath = req.params[1] || "/";
    const apis = discoverApis(getWsimDir());
    const api = apis.find((a) => a.name === apiName) || apis[0];
    if (!api || !api.url) {
      res.status(503).json({ error: `no running sim Api named "${apiName}"` });
      return;
    }
    try {
      const body = await readBody(req);
      const r = await forward(api.url, req.method, routePath, { "content-type": req.headers["content-type"] || "application/json" }, body);
      res.status(r.status);
      if (r.headers["content-type"]) res.set("content-type", r.headers["content-type"]);
      res.send(r.body);
    } catch (err) {
      res.status(502).json({ error: String(err.message || err) });
    }
  });

  // Serve the built-in upload form.
  app.get("/tf2wsim/upload", (req, res) => {
    res.type("html").send(UPLOAD_FORM_HTML);
  });
}

const UPLOAD_FORM_HTML = `<!doctype html><html><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>tf2wsim · Image Upload</title>
<style>
  body{font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
  .card{background:#1e293b;border:1px solid #334155;border-radius:12px;padding:28px;width:420px;box-shadow:0 8px 30px rgba(0,0,0,.4)}
  h1{font-size:18px;margin:0 0 4px} p.sub{color:#94a3b8;margin:0 0 20px;font-size:13px}
  label{display:block;font-size:12px;color:#94a3b8;margin:14px 0 6px}
  select,input[type=file]{width:100%;background:#0f172a;color:#e2e8f0;border:1px solid #334155;border-radius:8px;padding:9px}
  button{margin-top:18px;width:100%;background:#38bdf8;color:#06283d;border:none;border-radius:8px;padding:11px;font-weight:600;font-size:14px;cursor:pointer}
  button:disabled{opacity:.5}
  .drop{margin-top:6px;border:2px dashed #334155;border-radius:10px;padding:22px;text-align:center;color:#94a3b8;font-size:13px}
  .drop.over{border-color:#38bdf8;color:#e2e8f0}
  #preview{margin-top:14px;max-width:100%;border-radius:8px;display:none}
  pre{background:#0f172a;border:1px solid #334155;border-radius:8px;padding:10px;font-size:12px;white-space:pre-wrap;margin-top:14px;max-height:180px;overflow:auto}
  .ok{color:#22c55e}.err{color:#f87171}
</style></head><body>
<div class="card">
  <h1>Upload an image</h1>
  <p class="sub">Sent to the simulated API → validated by the Lambda → stored in the S3 bucket.</p>
  <label>Target API</label>
  <select id="api"></select>
  <label>Route</label>
  <input id="route" value="/upload" style="width:100%;background:#0f172a;color:#e2e8f0;border:1px solid #334155;border-radius:8px;padding:9px"/>
  <div class="drop" id="drop">Drop an image here, or click to choose<br><input id="file" type="file" accept="image/*" style="display:none"/></div>
  <img id="preview"/>
  <button id="send" disabled>Upload</button>
  <pre id="out" style="display:none"></pre>
</div>
<script>
const $=id=>document.getElementById(id);
let file=null;
fetch("/tf2wsim/apis").then(r=>r.json()).then(d=>{
  $("api").innerHTML=(d.apis||[]).map(a=>'<option value="'+a.name+'">'+a.name+(a.url?'':' (not running)')+'</option>').join('')||'<option>no APIs found</option>';
});
const drop=$("drop");
drop.onclick=()=>$("file").click();
["dragenter","dragover"].forEach(e=>drop.addEventListener(e,ev=>{ev.preventDefault();drop.classList.add("over");}));
["dragleave","drop"].forEach(e=>drop.addEventListener(e,ev=>{ev.preventDefault();drop.classList.remove("over");}));
drop.addEventListener("drop",ev=>{ if(ev.dataTransfer.files[0]) setFile(ev.dataTransfer.files[0]); });
$("file").onchange=e=>{ if(e.target.files[0]) setFile(e.target.files[0]); };
function setFile(f){ file=f; const u=URL.createObjectURL(f); $("preview").src=u; $("preview").style.display="block"; $("send").disabled=false; drop.firstChild.textContent=f.name; }
$("send").onclick=async()=>{
  if(!file)return;
  $("send").disabled=true; $("send").textContent="Uploading…";
  const dataBase64=await new Promise(res=>{const r=new FileReader();r.onload=()=>res(r.result.split(",")[1]);r.readAsDataURL(file);});
  const api=$("api").value, route=$("route").value||"/upload";
  const out=$("out"); out.style.display="block"; out.textContent="…";
  try{
    const r=await fetch("/tf2wsim/call/"+api+route,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({filename:file.name,contentType:file.type,dataBase64})});
    const text=await r.text();
    out.className=r.ok?"ok":"err";
    out.textContent="HTTP "+r.status+"\n"+text;
  }catch(e){ out.className="err"; out.textContent=String(e); }
  $("send").disabled=false; $("send").textContent="Upload";
};
</script></body></html>`;

module.exports = { mountBridge, discoverApis };
