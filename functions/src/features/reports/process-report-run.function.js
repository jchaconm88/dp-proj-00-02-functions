const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { logger } = require("firebase-functions");
const { defineSecret } = require("firebase-functions/params");
const { FieldValue } = require("firebase-admin/firestore");

/** Mismos nombres que en Secret Manager / `firebase functions:secrets:set` → `process.env.*` en runtime. */
const REPORT_SMTP_HOST = defineSecret("REPORT_SMTP_HOST");
const REPORT_SMTP_USER = defineSecret("REPORT_SMTP_USER");
const REPORT_SMTP_PASS = defineSecret("REPORT_SMTP_PASS");
const { admin, db } = require("../../lib/firebase");
const { buildReportBuffer } = require("../../lib/report-run-processor.service");
const { resolveGranularityWithParams } = require("../../lib/report-data-source-execute.service");
const { resolveExportTitle, periodLabelFromRange, seqFromRunId } = require("../../lib/report-export-templates.service");
const {
  buildNotifyEmailPayload,
  isSmtpConfigured,
  normalizeRecipients,
  sendReportRunCompletedEmail,
  smtpEnvDiagnostics,
  summarizeRecipientsForRun,
} = require("../../lib/report-run-email.service");

const processReportRun = onDocumentCreated(
  {
    document: "reportRuns/{runId}",
    timeoutSeconds: 360,
    memory: "512MiB",
    secrets: [REPORT_SMTP_HOST, REPORT_SMTP_USER, REPORT_SMTP_PASS],
  },
  async (event) => {
    const runId = event.params.runId;
    const snap = event.data;
    if (!snap) {
      logger.warn("processReportRun: sin snapshot", { runId });
      return;
    }

    const run = snap.data();
    if (!run || String(run.status ?? "") !== "pending") {
      logger.info("processReportRun: omitido (no pending o run vacío)", {
        runId,
        status: run ? String(run.status ?? "") : null,
      });
      return;
    }

    const runRef = db.collection("reportRuns").doc(runId);
    logger.info("processReportRun: inicio", { runId, reportDefinitionId: run.reportDefinitionId });

    try {
      await runRef.update({
        status: "processing",
        startedAt: FieldValue.serverTimestamp(),
      });

      const defId = String(run.reportDefinitionId ?? "").trim();
      if (!defId) {
        throw new Error("reportDefinitionId vacío.");
      }

      const defSnap = await db.collection("reportDefinitions").doc(defId).get();
      if (!defSnap.exists) {
        throw new Error("Definición de reporte no encontrada.");
      }

      const definition = defSnap.data() ?? {};
      const params = {
        ...(typeof definition.defaultParams === "object" && definition.defaultParams
          ? definition.defaultParams
          : {}),
        ...(typeof run.params === "object" && run.params ? run.params : {}),
      };

      const outputFormat = String(run.outputFormat ?? params.outputFormat ?? "xlsx").toLowerCase();
      if (outputFormat !== "xlsx" && outputFormat !== "pdf") {
        throw new Error(`Formato no soportado: ${outputFormat}`);
      }

      logger.info("processReportRun: generando archivo", { runId, defId, outputFormat });

      const seq = seqFromRunId(runId);
      const { buffer, fileName, mimeType } = await buildReportBuffer(
        db,
        definition,
        params,
        runId,
        seq,
        outputFormat
      );

      const bucket = admin.storage().bucket();
      const storagePath = `report-runs/${runId}/${fileName}`;
      const file = bucket.file(storagePath);
      await file.save(buffer, {
        contentType: mimeType,
        resumable: false,
        metadata: {
          metadata: {
            reportRunId: runId,
            reportDefinitionId: defId,
          },
        },
      });

      logger.info("processReportRun: guardado en Storage", {
        runId,
        storagePath,
        byteLength: buffer.length,
      });

      await runRef.update({
        status: "completed",
        completedAt: FieldValue.serverTimestamp(),
        result: {
          storagePath,
          fileName,
          mimeType,
          byteLength: buffer.length,
        },
        errorMessage: FieldValue.delete(),
      });

      const notifyEnabled = params.notifyEnabled !== false;
      const recipients = notifyEnabled ? normalizeRecipients(definition, params) : [];
      const smtpOk = isSmtpConfigured();
      const dateFrom = String(params.dateFrom ?? "").trim();
      const dateTo = String(params.dateTo ?? "").trim();
      const periodLabel = periodLabelFromRange(dateFrom, dateTo);
      const granularity = resolveGranularityWithParams(definition, params);
      const definitionId = String(definition.id ?? "").trim();
      const definitionName = String(definition.name ?? "Reporte");
      const exportTag = String(definition.exportTag ?? "").trim();
      const titleTpl = String(definition.exportTitleTemplate ?? "").trim();
      if (!titleTpl) {
        throw new Error("Falta exportTitleTemplate en la definición del reporte.");
      }
      const resolvedTitle = resolveExportTitle(titleTpl, {
        dateFrom,
        dateTo,
        seq,
        granularity,
        definitionId,
        definitionName,
        exportTag,
      });
      const subjectTpl =
        String(params.notifyEmailSubjectTemplate ?? "").trim() ||
        String(definition.notifyEmailSubjectTemplate ?? "").trim() ||
        null;
      const bodyHtmlTpl =
        String(params.notifyEmailBodyHtml ?? "").trim() ||
        String(definition.notifyEmailBodyHtml ?? "").trim() ||
        null;
      const notifyBase = {
        definitionName,
        resolvedTitle,
        dateFrom,
        dateTo,
        fileName,
        buffer,
        mimeType,
        subjectTemplate: subjectTpl,
        bodyHtmlTemplate: bodyHtmlTpl,
      };

      const subjPersist = (s) => String(s ?? "").slice(0, 500);

      if (!notifyEnabled) {
        logger.info("processReportRun: notificación por correo omitida (deshabilitada por usuario)", {
          runId,
          defId,
        });
        const payload = buildNotifyEmailPayload({ ...notifyBase, downloadUrl: "" });
        await runRef.update({
          notifyStatus: "skipped",
          notifySkippedReason: "disabled_by_user",
          notifyAttemptedAt: FieldValue.serverTimestamp(),
          notifyEmailSubject: subjPersist(payload.subject),
          notifyRecipientsSummary: "",
          notifyBodyWasHtml: payload.bodyWasHtml,
          notifyError: FieldValue.delete(),
        });
      } else if (recipients.length === 0) {
        logger.warn("processReportRun: notificación por correo omitida (sin destinatarios)", {
          runId,
          defId,
          hasDefNotifyEmails: Array.isArray(definition.notifyEmails) && definition.notifyEmails.length > 0,
          hasParamsNotifyEmails: Array.isArray(params.notifyEmails) && params.notifyEmails.length > 0,
        });
        const payload = buildNotifyEmailPayload({ ...notifyBase, downloadUrl: "" });
        await runRef.update({
          notifyStatus: "skipped",
          notifySkippedReason: "no_recipients",
          notifyAttemptedAt: FieldValue.serverTimestamp(),
          notifyEmailSubject: subjPersist(payload.subject),
          notifyRecipientsSummary: "",
          notifyBodyWasHtml: payload.bodyWasHtml,
          notifyError: FieldValue.delete(),
        });
      } else if (!smtpOk) {
        logger.warn(
          "processReportRun: notificación omitida (REPORT_SMTP_HOST vacío en el runtime de la función)",
          { runId, defId, recipientCount: recipients.length, smtp: smtpEnvDiagnostics() }
        );
        const payload = buildNotifyEmailPayload({ ...notifyBase, downloadUrl: "" });
        await runRef.update({
          notifyStatus: "skipped",
          notifySkippedReason: "smtp_not_configured",
          notifyAttemptedAt: FieldValue.serverTimestamp(),
          notifyEmailSubject: subjPersist(payload.subject),
          notifyRecipientsSummary: summarizeRecipientsForRun(recipients),
          notifyBodyWasHtml: payload.bodyWasHtml,
          notifyError: FieldValue.delete(),
        });
      } else {
        let signedUrlForNotify = "";
        try {
          logger.info("processReportRun: firmando URL y enviando correo", {
            runId,
            recipientCount: recipients.length,
          });
          const [signedUrl] = await file.getSignedUrl({
            action: "read",
            expires: Date.now() + 48 * 60 * 60 * 1000,
            responseDisposition: `attachment; filename="${encodeURIComponent(fileName)}"`,
          });
          signedUrlForNotify = signedUrl;
          const sendResult = await sendReportRunCompletedEmail({
            to: recipients,
            ...notifyBase,
            downloadUrl: signedUrl,
          });
          await runRef.update({
            notifyStatus: "sent",
            notifyAttemptedAt: FieldValue.serverTimestamp(),
            notifyEmailSubject: subjPersist(sendResult.subject),
            notifyRecipientsSummary: summarizeRecipientsForRun(recipients),
            notifyBodyWasHtml: Boolean(sendResult.bodyWasHtml),
            notifyError: FieldValue.delete(),
            notifySkippedReason: FieldValue.delete(),
          });
          logger.info("processReportRun: correo notificado OK", { runId });
        } catch (notifyErr) {
          const notifyMsg =
            notifyErr instanceof Error ? notifyErr.message : String(notifyErr);
          logger.error("processReportRun: fallo al notificar por correo", {
            runId,
            message: notifyMsg.slice(0, 500),
            stack: notifyErr instanceof Error ? String(notifyErr.stack).slice(0, 1500) : undefined,
            smtp: smtpEnvDiagnostics(),
          });
          const failPayload = buildNotifyEmailPayload({
            ...notifyBase,
            downloadUrl: signedUrlForNotify || "",
          });
          await runRef.update({
            notifyStatus: "failed",
            notifyError: notifyMsg.slice(0, 500),
            notifyAttemptedAt: FieldValue.serverTimestamp(),
            notifyEmailSubject: subjPersist(failPayload.subject),
            notifyRecipientsSummary: summarizeRecipientsForRun(recipients),
            notifyBodyWasHtml: failPayload.bodyWasHtml,
            notifySkippedReason: FieldValue.delete(),
          });
        }
      }

      logger.info("processReportRun: fin OK", { runId, status: "completed" });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.error("processReportRun: error en procesamiento", {
        runId,
        message: msg.slice(0, 2000),
        stack: e instanceof Error ? String(e.stack).slice(0, 2000) : undefined,
      });
      await runRef.update({
        status: "error",
        completedAt: FieldValue.serverTimestamp(),
        errorMessage: msg.slice(0, 2000),
      });
    }
  }
);

module.exports = {
  processReportRun,
};
