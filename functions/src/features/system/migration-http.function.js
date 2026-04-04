const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const express = require("express");
const { runMigrationOp } = require("../../lib/migrate-collections.service");

/** Secreto temporal: configurar con `firebase functions:secrets:set MIGRATION_HTTP_KEY` y BORRAR esta función tras migrar. */
const MIGRATION_HTTP_KEY = defineSecret("MIGRATION_HTTP_KEY");

const app = express();
app.use(express.json({ limit: "256kb" }));

app.get("/", (_req, res) => {
  res.status(200).json({
    service: "migrationHttp",
    hint: "POST con header X-Migration-Key y JSON { op, ... }. Eliminar este endpoint en producción estable.",
  });
});

app.post("/", async (req, res) => {
  try {
    const sent = String(req.get("x-migration-key") ?? req.query.key ?? "").trim();
    const expected = MIGRATION_HTTP_KEY.value();
    if (!expected || sent !== expected) {
      res.status(403).json({ ok: false, error: "forbidden" });
      return;
    }
    const op = String(req.body?.op ?? "").trim();
    if (!op) {
      res.status(400).json({ ok: false, error: "missing_op" });
      return;
    }
    const result = await runMigrationOp(op, req.body && typeof req.body === "object" ? req.body : {});
    res.status(200).json({ ok: true, op, result });
  } catch (e) {
    res.status(500).json({
      ok: false,
      message: e instanceof Error ? e.message : String(e),
    });
  }
});

const migrationHttp = onRequest(
  {
    cors: true,
    secrets: [MIGRATION_HTTP_KEY],
    timeoutSeconds: 540,
    memory: "512MiB",
  },
  app
);

module.exports = { migrationHttp };
