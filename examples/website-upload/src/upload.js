// Validates an upload request and stores the image in the storage bucket.
// The request comes from the sim Api as { headers, body, method, path, query, vars }.
// `body` is the raw text the Api received (we send base64 image data from the form).
const { makeSimulatorClient } = require("@winglang/sdk/lib/simulator/client");

function bucket(name) {
  const handles = JSON.parse(process.env.TF2WSIM_BUCKETS || "{}");
  const handle = handles[name];
  if (!handle) throw new Error(`no bucket capability for "${name}" (have: ${Object.keys(handles)})`);
  return makeSimulatorClient(
    process.env.WING_SIMULATOR_URL,
    handle,
    process.env.WING_SIMULATOR_CALLER
  );
}

exports.handler = async (req) => {
  try {
    const payload = JSON.parse(req.body || "{}");
    const { filename, contentType, dataBase64 } = payload;

    // --- validation ---
    if (!filename || !dataBase64) {
      return json(400, { error: "filename and dataBase64 are required" });
    }
    if (contentType && !/^image\//.test(contentType)) {
      return json(415, { error: `unsupported content type: ${contentType}` });
    }
    const bytes = Buffer.from(dataBase64, "base64");
    const MAX = 5 * 1024 * 1024;
    if (bytes.length > MAX) {
      return json(413, { error: `file too large (${bytes.length} bytes, max ${MAX})` });
    }

    // --- store ---
    const key = `${Date.now()}-${filename.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
    const storage = bucket("storage");
    // Store the *base64* string. The sim Bucket only holds UTF-8 text (its get()
    // uses a fatal UTF-8 decoder, so raw binary can't be read back), and the Wing
    // Console treats binary-by-extension files (.png/.jpg/...) as base64 for both
    // upload and download — so storing base64 here makes the Console's Download
    // button produce the correct, intact image.
    await storage.put(key, dataBase64, { contentType: contentType || "application/octet-stream" });
    const all = await storage.list();

    console.log(`stored ${key} (${bytes.length} bytes); bucket now has ${all.length} object(s)`);
    return json(200, { ok: true, key, size: bytes.length, totalObjects: all.length });
  } catch (err) {
    console.error("upload error:", err.stack || err.message);
    return json(500, { error: String(err.message || err) });
  }
};

function json(status, obj) {
  return { status, headers: { "content-type": "application/json" }, body: JSON.stringify(obj) };
}
