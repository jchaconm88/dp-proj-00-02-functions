const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { admin, db } = require("../../lib/firebase");
const { assertCompanyUser } = require("../../lib/tenant-auth");

const getReportRunDownloadUrl = onCall(
  {
    cors: true,
    timeoutSeconds: 30,
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Debes iniciar sesión para descargar el reporte.");
    }

    const reportRunId = String(request.data?.reportRunId ?? "").trim();
    if (!reportRunId) {
      throw new HttpsError("invalid-argument", "reportRunId es obligatorio.");
    }

    const snap = await db.collection("report-runs").doc(reportRunId).get();
    if (!snap.exists) {
      throw new HttpsError("not-found", "La ejecución del reporte no existe.");
    }

    const run = snap.data() ?? {};
    const companyId = String(run.companyId ?? "").trim();
    await assertCompanyUser(db, companyId, request.auth.uid);

    if (String(run.status ?? "") !== "completed") {
      throw new HttpsError("failed-precondition", "El reporte aún no está listo o falló.");
    }

    const result = /** @type {Record<string, unknown>} */ (run.result ?? {});
    const storagePath = String(result.storagePath ?? "").trim();
    if (!storagePath) {
      throw new HttpsError("failed-precondition", "No hay archivo generado.");
    }

    const bucket = admin.storage().bucket();
    const file = bucket.file(storagePath);
    const [exists] = await file.exists();
    if (!exists) {
      throw new HttpsError("not-found", "El archivo ya no está disponible.");
    }

    const mime = String(result.mimeType ?? "");
    const fallbackName = mime.includes("pdf") ? "reporte.pdf" : "reporte.xlsx";
    const fileName = String(result.fileName ?? "").trim() || fallbackName;
    const [url] = await file.getSignedUrl({
      action: "read",
      expires: Date.now() + 15 * 60 * 1000,
      responseDisposition: `attachment; filename="${encodeURIComponent(fileName)}"`,
    });

    return { url, fileName };
  }
);

module.exports = {
  getReportRunDownloadUrl,
};
