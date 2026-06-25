/* Shared data store for the VM Operations SLA Monitor.
 *
 * GET  /api/data  -> returns the latest published workbook JSON (or {} if none).
 *                   Public; every visitor reads the same figures.
 * POST /api/data  -> publishes a workbook JSON so everyone sees it.
 *                   Requires header  Authorization: Bearer <ADMIN_TOKEN>.
 *
 * Storage is a single Vercel Blob at sla-data/current.json.
 *
 * The blob is written with access: "private". Vercel Blob stores created today
 * default to PRIVATE, and a private blob is NOT fetchable by its plain URL — so
 * the old public put + plain-URL read silently failed on a private store, leaving
 * uploads stranded on the uploader's device. Reads now go through a short-lived
 * presigned GET URL (issueSignedToken -> presignUrl -> fetch), which requires
 * @vercel/blob v2. A legacy public blob at the same path is still read via the
 * list() fallback, so this keeps working on an older public store too.
 *
 * Required environment variables (set in the Vercel project):
 *   BLOB_READ_WRITE_TOKEN  - added automatically when a Blob store is connected.
 *                            (A non-default store may expose it under another name;
 *                            we also detect any value starting with vercel_blob_rw_.)
 *   ADMIN_TOKEN            - a secret you choose; admins enter it to publish.
 *
 * Until those are set the endpoint stays inert: GET returns {} and POST returns
 * an error, so the app simply falls back to its on-device behaviour.
 */
import { put, list, issueSignedToken, presignUrl } from "@vercel/blob";

const PATH = "sla-data/current.json";

/* Find the Vercel Blob read/write token. Normally it's BLOB_READ_WRITE_TOKEN, but a
   connected store can expose the token under a non-standard env var name (e.g. when the
   store isn't the project default). Every R/W token's *value* starts with
   "vercel_blob_rw_", so we fall back to matching by value — making detection
   independent of the variable name. */
function blobToken() {
  if (process.env.BLOB_READ_WRITE_TOKEN) return process.env.BLOB_READ_WRITE_TOKEN;
  for (const v of Object.values(process.env)) {
    if (typeof v === "string" && v.startsWith("vercel_blob_rw_")) return v;
  }
  return undefined;
}

/* Read the stored JSON. Tries a presigned private GET first (the store's default
   today); falls back to list() + plain-URL fetch for a legacy public blob. Returns
   null when nothing is published or the store isn't configured. */
async function readData(token) {
  if (!token) return null;
  // Private path: presign a short-lived GET URL.
  try {
    const signed = await issueSignedToken({ pathname: PATH, operations: ["get"], token });
    const { presignedUrl } = await presignUrl(signed, { operation: "get", pathname: PATH, access: "private" });
    const r = await fetch(presignedUrl, { cache: "no-store" });
    if (r.ok) return await r.json();
  } catch (e) { /* fall through to the public fallback */ }
  // Public fallback: a blob written by the old code is fetchable by its URL.
  try {
    const { blobs } = await list({ prefix: PATH, token });
    const hit = blobs.find(b => b.pathname === PATH);
    if (!hit) return null;
    const r = await fetch(hit.url, { cache: "no-store" });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { return null; }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(204).end();

  const token = blobToken();

  if (req.method === "GET") {
    try {
      const data = await readData(token);
      if (!data) return res.status(200).json({});
      res.setHeader("Cache-Control", "no-store, max-age=0");
      return res.status(200).json(data);
    } catch (e) {
      // Store not configured yet, or transient read error — behave as "no shared data".
      return res.status(200).json({});
    }
  }

  if (req.method === "POST") {
    const auth = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (!process.env.ADMIN_TOKEN) return res.status(503).json({ error: "publishing is not configured on the server" });
    if (auth !== process.env.ADMIN_TOKEN) return res.status(401).json({ error: "invalid publish key" });
    if (!token) return res.status(503).json({ error: "the shared store isn't connected on the server yet" });
    try {
      let body = req.body;
      if (typeof body === "string") body = JSON.parse(body || "{}");
      if (!body || !body.measures) return res.status(400).json({ error: "no measures in the uploaded data" });
      const payload = JSON.stringify({ ...body, publishedAt: new Date().toISOString() });
      await put(PATH, payload, {
        access: "private",
        addRandomSuffix: false, // always overwrite the single current.json blob
        allowOverwrite: true,
        contentType: "application/json",
        token,
      });
      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: String((e && e.message) || e) });
    }
  }

  return res.status(405).json({ error: "method not allowed" });
}
