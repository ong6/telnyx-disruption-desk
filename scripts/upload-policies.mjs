#!/usr/bin/env node
// Upload content/policies/*.md to the Cloud Storage bucket that get_policy reads, through the
// S3-compatible API (Signature V4, the Telnyx API key as the access key). Pass file names to
// upload only those; `--check` reads the bucket copies back and reports which differ.
// Usage: source scripts/env.sh && node scripts/upload-policies.mjs [--check] [refunds.md ...]
import { createHash, createHmac } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";

const REGION = "ap-southeast-1";
const BUCKET = "nimbus-desk-5feb1a"; // functions/desk-mcp/telnyx.toml
const HOST = `${REGION}.telnyxcloudstorage.com`;
const KEY = process.env.TELNYX_API_KEY;
const sha = (b) => createHash("sha256").update(b).digest("hex");
const hmac = (k, s) => createHmac("sha256", k).update(s).digest();

async function s3(method, key, body = "") {
  const path = `/${BUCKET}/${key.split("/").map(encodeURIComponent).join("/")}`;
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = amzDate.slice(0, 8);
  const payloadHash = sha(body);
  const headers = { host: HOST, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate };
  const signed = Object.keys(headers).sort().join(";");
  const canonical = [method, path, "", ...Object.keys(headers).sort().map((h) => `${h}:${headers[h]}`), "", signed, payloadHash].join("\n");
  const scope = `${day}/${REGION}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha(canonical)].join("\n");
  const kSigning = ["s3", "aws4_request"].reduce(hmac, hmac(hmac(`AWS4${KEY}`, day), REGION));
  const auth = `AWS4-HMAC-SHA256 Credential=${KEY}/${scope}, SignedHeaders=${signed}, Signature=${createHmac("sha256", kSigning).update(toSign).digest("hex")}`;
  const res = await fetch(`https://${HOST}${path}`, { method, headers: { ...headers, authorization: auth, ...(body ? { "content-type": "text/markdown" } : {}) }, body: body || undefined });
  return { status: res.status, text: await res.text() };
}

const args = process.argv.slice(2);
const check = args.includes("--check");
const files = args.filter((a) => !a.startsWith("--"));
const dir = new URL("../content/policies/", import.meta.url);
for (const name of files.length ? files : readdirSync(dir).filter((f) => f.endsWith(".md"))) {
  const local = readFileSync(new URL(name, dir), "utf8");
  if (check) {
    const r = await s3("GET", `policies/${name}`);
    console.log(name, r.status, r.status === 200 ? (r.text === local ? "same" : "differs") : r.text.slice(0, 200));
  } else {
    const r = await s3("PUT", `policies/${name}`, local);
    console.log(name, r.status, r.status === 200 ? "uploaded" : r.text.slice(0, 300));
  }
}
