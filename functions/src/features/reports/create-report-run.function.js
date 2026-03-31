const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { logger } = require("firebase-functions");
const { FieldValue } = require("firebase-admin/firestore");
const { db } = require("../../lib/firebase");
const { NOTIFY_TEMPLATE_MAX_LEN } = require("../../lib/report-run-email.service");

/**
 * @param {unknown} v
 * @returns {string | undefined}
 */
function clampNotifyTemplateField(v) {
  const t = String(v ?? "").trim();
  if (!t) return undefined;
  return t.length > NOTIFY_TEMPLATE_MAX_LEN ? t.slice(0, NOTIFY_TEMPLATE_MAX_LEN) : t;
}

const createReportRun = onCall(
  {
    cors: true,
    timeoutSeconds: 60,
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Debes iniciar sesión para generar reportes.");
    }

    const reportDefinitionId = String(request.data?.reportDefinitionId ?? "").trim();
    if (!reportDefinitionId) {
      throw new HttpsError("invalid-argument", "reportDefinitionId es obligatorio.");
    }

    const rawParams = request.data?.params;
    const params = rawParams && typeof rawParams === "object" ? { ...rawParams } : {};

    const fmtRaw = String(params.outputFormat ?? "xlsx").toLowerCase();
    if (fmtRaw !== "xlsx" && fmtRaw !== "pdf") {
      throw new HttpsError("invalid-argument", 'outputFormat debe ser "xlsx" o "pdf".');
    }
    params.outputFormat = fmtRaw;

    if (Array.isArray(params.notifyEmails)) {
      params.notifyEmails = params.notifyEmails
        .map((e) => String(e ?? "").trim())
        .filter((e) => e.includes("@"))
        .slice(0, 30);
      if (params.notifyEmails.length === 0) {
        delete params.notifyEmails;
      }
    } else if (typeof params.notifyEmails === "string" && params.notifyEmails.trim()) {
      params.notifyEmails = params.notifyEmails
        .split(/[\s,;]+/)
        .map((s) => s.trim())
        .filter((e) => e.includes("@"))
        .slice(0, 30);
      if (params.notifyEmails.length === 0) {
        delete params.notifyEmails;
      }
    } else {
      delete params.notifyEmails;
    }

    const subjT = clampNotifyTemplateField(params.notifyEmailSubjectTemplate);
    const bodyT = clampNotifyTemplateField(params.notifyEmailBodyHtml);
    if (subjT) params.notifyEmailSubjectTemplate = subjT;
    else delete params.notifyEmailSubjectTemplate;
    if (bodyT) params.notifyEmailBodyHtml = bodyT;
    else delete params.notifyEmailBodyHtml;

    const defSnap = await db.collection("reportDefinitions").doc(reportDefinitionId).get();
    if (!defSnap.exists) {
      throw new HttpsError("not-found", "La definición de reporte no existe.");
    }

    const email = request.auth.token?.email ? String(request.auth.token.email) : request.auth.uid;

    const ref = await db.collection("reportRuns").add({
      reportDefinitionId,
      params,
      status: "pending",
      trigger: String(params.trigger ?? "manual"),
      outputFormat: params.outputFormat,
      requestedBy: email,
      createdAt: FieldValue.serverTimestamp(),
    });

    const notifyCount = Array.isArray(params.notifyEmails) ? params.notifyEmails.length : 0;
    logger.info("createReportRun: corrida creada (pending)", {
      reportRunId: ref.id,
      reportDefinitionId,
      outputFormat: params.outputFormat,
      notifyEmailsCount: notifyCount,
    });

    return { reportRunId: ref.id };
  }
);

module.exports = {
  createReportRun,
};
