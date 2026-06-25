/* Shared data store for the VM Operations SLA Monitor.
 *
 * GET  /api/data  -> returns the latest published workbook JSON (or {} if none).
 *                   Public; every visitor reads the same figures.
 * POST /api/data  -> publishes a workbook JSON so everyone sees it.
 *                   Requires header  Authorization: Bearer <ADMIN_TOKEN>.
 *
 * Storage is a single Vercel Blob at sla-data/current.json.
 *
 * Required environment variables (set in the Vercel project):
 *   BLOB_READ_WRITE_TOKEN  - added automatically when a Blob store is connected.
 *   ADMIN_TOKEN            - a secret you choose; admins enter it to publish.
 *
 * Until those are set the endpoint stays inert: GET returns {} and POST returns
 * an error, so the app simply falls back to its on-device behaviour.
 */
import { put, list } from "@vercel/blob";

const PATH = "sla-data/current.json";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(204).end();

  if (req.method === "GET") {
    try {
      const { blobs } = await list({ prefix: PATH });
      const hit = blobs.find(b => b.pathname === PATH);
      if (!hit) return res.status(200).json({});
      const r = await fetch(hit.url, { cache: "no-store" });
      if (!r.ok) return res.status(200).json({});
      const data = await r.json();
      res.setHeader("Cache-Control", "no-store, max-age=0");
      return res.status(200).json(data);
    } catch (e) {
      // Store not configured yet, or transient read error — behave as "no shared data".
      return res.status(200).json({});
    }
  }

  if (req.method === "POST") {
    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (!process.env.ADMIN_TOKEN) return res.status(503).json({ error: "publishing is not configured on the server" });
    if (token !== process.env.ADMIN_TOKEN) return res.status(401).json({ error: "invalid publish key" });
    try {
      let body = req.body;
      if (typeof body === "string") body = JSON.parse(body || "{}");
      if (!body || !body.measures) return res.status(400).json({ error: "no measures in the uploaded data" });
      const payload = JSON.stringify({ ...body, publishedAt: new Date().toISOString() });
      await put(PATH, payload, { access: "public", contentType: "application/json", allowOverwrite: true });
      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: String((e && e.message) || e) });
    }
  }

  return res.status(405).json({ error: "method not allowed" });
}
