/* Shared data store for the VM Operations SLA Monitor.
 *
 * GET  /api/data  -> returns the latest published workbook JSON (or {} if none).
 *                   Public; every visitor reads the same figures.
 * POST /api/data  -> publishes a workbook JSON so everyone sees it.
 *                   Open (no key) — uploading is gated to admins in the app.
 *
 * Storage is a single Vercel Blob at sla-data/current.json.
 *
 * The blob is written with access: "public" — the SLA figures are not sensitive
 * and every visitor reads the same data. POST find-or-overwrites the single
 * current.json blob; GET locates it with list() and fetches its public URL.
 *
 * Required environment variables (set in the Vercel project):
 *   BLOB_READ_WRITE_TOKEN  - added automatically when a Blob store is connected.
 *                            (A non-default store may expose it under another name;
 *                            we also detect any value starting with vercel_blob_rw_.)
 *
 * Until the store is connected the endpoint stays inert: GET returns {} and POST
 * returns an error, so the app simply falls back to its on-device behaviour.
 */
import { put, list } from "@vercel/blob";

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

/* Read the stored JSON. The blob is written with public access, so we find it
   with list() and fetch its public URL. Returns null when nothing is published
   or the store isn't configured. */
async function readData(token) {
  if (!token) return null;
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
    // Publishing is open — no key. Uploading is gated in the app (admin only).
    if (!token) return res.status(503).json({ error: "the shared store isn't connected on the server yet" });
    try {
      let body = req.body;
      if (typeof body === "string") body = JSON.parse(body || "{}");
      if (!body || !body.measures) return res.status(400).json({ error: "no measures in the uploaded data" });
      const payload = JSON.stringify({ ...body, publishedAt: new Date().toISOString() });
      await put(PATH, payload, {
        access: "public", // figures are public — every visitor reads the same data
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
