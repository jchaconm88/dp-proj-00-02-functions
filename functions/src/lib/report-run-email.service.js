/**
 * Notificación por correo al completar un reporte (SMTP vía Nodemailer, opcional).
 *
 * Variables de entorno (si falta REPORT_SMTP_HOST no se envía nada):
 * - REPORT_SMTP_HOST, REPORT_SMTP_PORT (default 587)
 * - REPORT_SMTP_USER, REPORT_SMTP_PASS (opcionales si el relay no exige auth)
 * - REPORT_SMTP_FROM (remitente; por defecto REPORT_SMTP_USER)
 */

const nodemailer = require("nodemailer");
const { logger } = require("firebase-functions");

const ATTACH_MAX_BYTES = 5 * 1024 * 1024;
const NOTIFY_TEMPLATE_MAX_LEN = 64 * 1024;
const NOTIFY_RECIPIENTS_SUMMARY_MAX = 300;

/**
 * Sustituye `{{clave}}` por valores del contexto (orden no importa).
 * @param {string | null | undefined} template
 * @param {Record<string, string>} context
 * @returns {string}
 */
function applyNotifyTemplate(template, context) {
  let s = String(template ?? "");
  for (const [key, value] of Object.entries(context)) {
    const token = `{{${key}}}`;
    s = s.split(token).join(String(value ?? ""));
  }
  return s;
}

/**
 * @param {string | null | undefined} html
 * @returns {string}
 */
function htmlToPlainText(html) {
  return String(html ?? "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isSmtpConfigured() {
  return Boolean(String(process.env.REPORT_SMTP_HOST ?? "").trim());
}

/**
 * Diagnóstico seguro para logs (no incluye host completo ni contraseñas).
 * Útil si los secretos están en GCP pero no enlazados a la función (env vacío).
 */
function smtpEnvDiagnostics() {
  const host = String(process.env.REPORT_SMTP_HOST ?? "").trim();
  const user = String(process.env.REPORT_SMTP_USER ?? "").trim();
  const pass = String(process.env.REPORT_SMTP_PASS ?? "").trim();
  const fromAddr = String(process.env.REPORT_SMTP_FROM ?? "").trim();
  return {
    hostConfigured: Boolean(host),
    hostLength: host.length,
    port: Number(process.env.REPORT_SMTP_PORT ?? 587),
    hasSmtpUser: Boolean(user),
    hasSmtpPass: Boolean(pass),
    hasFromOverride: Boolean(fromAddr),
  };
}

function createTransporter() {
  const host = String(process.env.REPORT_SMTP_HOST ?? "").trim();
  const port = Number(process.env.REPORT_SMTP_PORT ?? 587);
  const user = String(process.env.REPORT_SMTP_USER ?? "").trim();
  const pass = String(process.env.REPORT_SMTP_PASS ?? "").trim();
  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: user && pass ? { user, pass } : undefined,
  });
}

/**
 * @param {Record<string, unknown>} definition
 * @param {Record<string, unknown>} params
 * @returns {string[]}
 */
function normalizeRecipients(definition, params) {
  const fromDef = Array.isArray(definition.notifyEmails) ? definition.notifyEmails : [];
  const fromParams = Array.isArray(params.notifyEmails) ? params.notifyEmails : [];
  const seen = new Set();
  const out = [];
  for (const raw of [...fromDef, ...fromParams]) {
    const e = String(raw ?? "").trim();
    if (!e.includes("@")) continue;
    const key = e.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

/**
 * @param {string[]} recipients
 * @returns {string}
 */
function summarizeRecipientsForRun(recipients) {
  if (!Array.isArray(recipients) || recipients.length === 0) return "";
  const joined = recipients.join(", ");
  if (joined.length <= NOTIFY_RECIPIENTS_SUMMARY_MAX) return joined;
  return `${recipients.length} destinatarios`;
}

/**
 * Arma asunto, cuerpo y adjuntos (misma lógica que el envío real).
 * @param {{
 *   definitionName: string;
 *   resolvedTitle: string;
 *   dateFrom: string;
 *   dateTo: string;
 *   downloadUrl: string;
 *   fileName: string;
 *   buffer?: Buffer;
 *   mimeType?: string;
 *   subjectTemplate?: string | null;
 *   bodyHtmlTemplate?: string | null;
 * }} args
 * @returns {{ subject: string; bodyWasHtml: boolean; text: string; html: string; attachments: Array<Record<string, unknown>> }}
 */
function buildNotifyEmailPayload(args) {
  const {
    definitionName,
    resolvedTitle,
    dateFrom,
    dateTo,
    downloadUrl,
    fileName,
    buffer,
    mimeType,
    subjectTemplate,
    bodyHtmlTemplate,
  } = args;

  const canAttach =
    Buffer.isBuffer(buffer) && buffer.length > 0 && buffer.length <= ATTACH_MAX_BYTES;
  const attachments = canAttach
    ? [
        {
          filename: fileName,
          content: buffer,
          contentType: mimeType || "application/octet-stream",
        },
      ]
    : [];

  const periodLine =
    dateFrom && dateTo
      ? `Período: ${dateFrom} — ${dateTo}`
      : dateFrom || dateTo
        ? `Período: ${[dateFrom, dateTo].filter(Boolean).join(" — ")}`
        : "";

  const tplContext = {
    resolvedTitle: String(resolvedTitle ?? "").trim() || definitionName,
    definitionName,
    dateFrom: String(dateFrom ?? ""),
    dateTo: String(dateTo ?? ""),
    downloadUrl: String(downloadUrl ?? ""),
    fileName: String(fileName ?? ""),
  };

  const defaultSubject = `Reporte listo: ${definitionName}`;
  const subjectRaw = String(subjectTemplate ?? "").trim();
  const subject = subjectRaw
    ? applyNotifyTemplate(subjectRaw, tplContext).trim() || defaultSubject
    : defaultSubject;

  const defaultLines = [
    `El reporte «${definitionName}» ha finalizado.`,
    periodLine,
    "",
    `Descargar: ${tplContext.downloadUrl}`,
    "",
    canAttach
      ? "También se adjunta el archivo a este mensaje."
      : "El archivo no se adjunta (tamaño o configuración); usá el enlace para descargarlo.",
  ].filter(Boolean);
  const defaultText = defaultLines.join("\n");

  const bodyHtmlRaw = String(bodyHtmlTemplate ?? "").trim();
  let html = "";
  let text = defaultText;
  if (bodyHtmlRaw) {
    html = applyNotifyTemplate(bodyHtmlRaw, tplContext);
    const plainFromHtml = htmlToPlainText(html);
    text = plainFromHtml || defaultText;
  }

  return {
    subject,
    bodyWasHtml: Boolean(html),
    text,
    html,
    attachments,
  };
}

/**
 * @param {{
 *   to: string[];
 *   definitionName: string;
 *   resolvedTitle: string;
 *   dateFrom: string;
 *   dateTo: string;
 *   downloadUrl: string;
 *   fileName: string;
 *   buffer?: Buffer;
 *   mimeType?: string;
 *   subjectTemplate?: string | null;
 *   bodyHtmlTemplate?: string | null;
 * }} args
 * @returns {Promise<{ skipped?: boolean; sent?: boolean; subject?: string; bodyWasHtml?: boolean }>}
 */
async function sendReportRunCompletedEmail(args) {
  const { to, definitionName, fileName } = args;
  if (!to.length || !isSmtpConfigured()) {
    logger.warn("reportRunEmail: send omitido (sin destinatarios o SMTP no configurado en env)", {
      recipientCount: to.length,
      smtp: smtpEnvDiagnostics(),
    });
    return { skipped: true };
  }

  const fromAddr = String(
    process.env.REPORT_SMTP_FROM ?? process.env.REPORT_SMTP_USER ?? "noreply@localhost"
  ).trim();

  logger.info("reportRunEmail: enviando correo vía SMTP", {
    recipientCount: to.length,
    definitionName,
    fileName,
    fromConfigured: Boolean(fromAddr && fromAddr !== "noreply@localhost"),
    smtp: smtpEnvDiagnostics(),
  });

  const transporter = createTransporter();
  const payload = buildNotifyEmailPayload(args);

  try {
    await transporter.sendMail({
      from: fromAddr,
      to: to.join(", "),
      subject: payload.subject,
      text: payload.text,
      ...(payload.html ? { html: payload.html } : {}),
      attachments: payload.attachments,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const code = err && typeof err === "object" && "code" in err ? String(err.code) : undefined;
    logger.error("reportRunEmail: sendMail falló", {
      message: msg.slice(0, 500),
      code,
      recipientCount: to.length,
      smtp: smtpEnvDiagnostics(),
    });
    throw err;
  }

  logger.info("reportRunEmail: sendMail OK", { recipientCount: to.length, fileName });
  return { sent: true, subject: payload.subject, bodyWasHtml: payload.bodyWasHtml };
}

module.exports = {
  ATTACH_MAX_BYTES,
  NOTIFY_RECIPIENTS_SUMMARY_MAX,
  NOTIFY_TEMPLATE_MAX_LEN,
  applyNotifyTemplate,
  buildNotifyEmailPayload,
  createTransporter,
  htmlToPlainText,
  isSmtpConfigured,
  normalizeRecipients,
  sendReportRunCompletedEmail,
  smtpEnvDiagnostics,
  summarizeRecipientsForRun,
};
