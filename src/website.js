"use strict";
// S3 static website hosting -> cloud.Website.
//
// In Terraform a static site is an aws_s3_bucket plus an
// aws_s3_bucket_website_configuration (index/error documents), with files
// uploaded as aws_s3_object resources. The Wing simulator's Website serves a
// local directory over HTTP, so we:
//   - for each aws_s3_bucket_website_configuration, find its bucket,
//   - materialize that bucket's aws_s3_object files into a local static dir,
//   - synthesize a cloud.Website pointing at that dir (with index/error docs).
//
// The bucket itself is still mapped to a cloud.Bucket by the normal path; the
// Website is an *additional* resource that serves the same logical content.
const fs = require("fs");
const path = require("path");

// Resolve the file contents for an aws_s3_object. TF supports `content`
// (inline), `source` (a local file path), or `content_base64`.
function objectContents(values, tfDir) {
  if (typeof values.content === "string") return Buffer.from(values.content);
  if (typeof values.content_base64 === "string") {
    return Buffer.from(values.content_base64, "base64");
  }
  if (typeof values.source === "string") {
    const p = path.isAbsolute(values.source)
      ? values.source
      : path.join(tfDir || process.cwd(), values.source);
    try {
      return fs.readFileSync(p);
    } catch {
      return null;
    }
  }
  return null;
}

// Mutates `resources` (adds Website resources). Returns a list of synthesized
// website paths. `pathFor`/`addrFor` keep id/addr conventions consistent.
function applyWebsites({ resources, tfResources, addressToPath, refs, outDir, tfDir, pathFor, addrFor }) {
  const grouped = {};
  for (const r of tfResources) (grouped[r.type] = grouped[r.type] || []).push(r);
  const addressType = {};
  const bucketTfNameByAddr = {};
  for (const r of tfResources) {
    addressType[r.address] = r.type;
    bucketTfNameByAddr[r.address] = r.name;
  }

  const websites = [];
  const consumedObjects = [];
  for (const cfg of grouped.aws_s3_bucket_website_configuration || []) {
    // Which bucket does this website config target?
    const cfgRefs = refs[cfg.address] || {};
    let bucketAddr = null;
    for (const list of Object.values(cfgRefs)) {
      for (const addr of list) {
        if (addressType[addr] === "aws_s3_bucket") bucketAddr = addr;
      }
    }
    if (!bucketAddr) continue;

    // index/error documents from the config values.
    const v = cfg.values || {};
    const indexDoc =
      (Array.isArray(v.index_document) ? v.index_document[0] : v.index_document)?.suffix ||
      "index.html";
    const errorDoc =
      (Array.isArray(v.error_document) ? v.error_document[0] : v.error_document)?.key;

    // Materialize the bucket's objects into a static dir.
    const siteName = bucketTfNameByAddr[bucketAddr] || "site";
    const staticDir = path.join(outDir, "websites", siteName);
    fs.mkdirSync(staticDir, { recursive: true });
    let fileCount = 0;
    for (const obj of grouped.aws_s3_object || []) {
      const objRefs = refs[obj.address] || {};
      let targetsBucket = false;
      for (const list of Object.values(objRefs)) {
        if (list.includes(bucketAddr)) targetsBucket = true;
      }
      if (!targetsBucket) continue;
      const key = (obj.values && obj.values.key) || null;
      if (!key) continue;
      const contents = objectContents(obj.values || {}, tfDir);
      if (contents == null) continue;
      const dest = path.join(staticDir, key);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, contents);
      consumedObjects.push(obj.address);
      fileCount++;
    }
    // If no objects were found, leave a minimal placeholder so the site serves.
    if (fileCount === 0) {
      fs.writeFileSync(
        path.join(staticDir, indexDoc),
        `<!doctype html><meta charset="utf-8"><title>${siteName}</title>` +
          `<p>Static site "${siteName}" — no aws_s3_object files were found to materialize.</p>`
      );
    }

    const wpath = pathFor(cfg.address);
    addressToPath[cfg.address] = wpath;
    resources[wpath] = {
      type: require("./constants").WING_TYPES.WEBSITE,
      path: wpath,
      addr: addrFor(wpath),
      props: {
        // The sim Website serves this dir directly (it isn't resolved against
        // simdir like Function.sourceCodeFile), so store an absolute path.
        staticFilesPath: path.resolve(staticDir),
        fileRoutes: {},
        ...(errorDoc ? { errorDocument: errorDoc } : {}),
      },
    };
    websites.push(wpath);
  }
  return { websites, consumedObjects };
}

module.exports = { applyWebsites };
