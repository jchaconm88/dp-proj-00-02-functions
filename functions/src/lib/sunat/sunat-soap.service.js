/**
 * sunat-soap.service.js
 * Comunicación con los webservices SOAP de SUNAT.
 * Cubre: sendBill, sendPack, sendSummary, getStatus, getStatusCdr, pollTicket, readCdr.
 */

"use strict";

const soap = require("soap");
const JSZip = require("jszip");

// ---------------------------------------------------------------------------
// Helpers internos
// ---------------------------------------------------------------------------

/**
 * Crea un cliente SOAP con autenticación básica y timeout configurado.
 * @param {string} url        - URL base del servicio (sin ?wsdl)
 * @param {string} user
 * @param {string} password
 * @param {number} [timeoutMs=30000]
 * @returns {Promise<import("soap").Client>}
 */
async function _createClient(url, user, password, timeoutMs = 30000) {
  const client = await soap.createClientAsync(url + "?wsdl", {
    wsdl_options: { timeout: timeoutMs },
  });
  client.setSecurity(new soap.BasicAuthSecurity(user, password));
  // Configurar timeout en las llamadas HTTP del cliente
  if (client.httpClient && typeof client.httpClient.request === "function") {
    const origRequest = client.httpClient.request.bind(client.httpClient);
    client.httpClient.request = (rurl, data, callback, exheaders, exoptions) =>
      origRequest(rurl, data, callback, exheaders, { ...exoptions, timeout: timeoutMs });
  }
  return client;
}

// ---------------------------------------------------------------------------
// sendBill — billService → sendBill (síncrono, retorna CDR directo)
// ---------------------------------------------------------------------------

/**
 * Envía un ZIP al webservice SOAP de SUNAT (método sendBill).
 *
 * @param {string} url        - URL del billService (sin ?wsdl)
 * @param {Buffer} zipBuffer  - Contenido del ZIP en memoria
 * @param {string} zipName    - Nombre del archivo ZIP
 * @param {string} user       - Usuario SOL completo: "{ruc}{usuarioSunat}"
 * @param {string} password   - Contraseña SOL
 * @param {number} [timeoutMs=30000]
 * @returns {Promise<Buffer>} CDR ZIP de respuesta
 */
async function sendBill(url, zipBuffer, zipName, user, password, timeoutMs = 30000) {
  const client = await _createClient(url, user, password, timeoutMs);

  const [result] = await client.sendBillAsync({
    fileName: zipName,
    contentFile: zipBuffer.toString("base64"),
  });

  // La respuesta tiene la forma: { applicationResponse: "<base64>" }
  const base64Cdr =
    result?.applicationResponse ??
    result?.return?.applicationResponse ??
    result?.return;

  if (!base64Cdr) {
    throw new Error("sendBill: respuesta vacía o inesperada de SUNAT");
  }

  return Buffer.from(base64Cdr, "base64");
}

/**
 * Alias de sendBill para compatibilidad con código existente.
 * @deprecated Usar sendBill directamente.
 */
async function sendDocument(url, zipBuffer, zipName, user, password, timeoutMs = 30000) {
  return sendBill(url, zipBuffer, zipName, user, password, timeoutMs);
}

// ---------------------------------------------------------------------------
// sendPack — billService → sendPack (asíncrono, retorna ticket)
// ---------------------------------------------------------------------------

/**
 * Envía múltiples comprobantes en un ZIP (método sendPack).
 *
 * @param {string} url        - URL del billService (sin ?wsdl)
 * @param {Buffer} zipBuffer  - Contenido del ZIP en memoria
 * @param {string} zipName    - Nombre del archivo ZIP
 * @param {string} user       - Usuario SOL completo: "{ruc}{usuarioSunat}"
 * @param {string} password   - Contraseña SOL
 * @param {number} [timeoutMs=30000]
 * @returns {Promise<string>} Ticket de seguimiento
 */
async function sendPack(url, zipBuffer, zipName, user, password, timeoutMs = 30000) {
  const client = await _createClient(url, user, password, timeoutMs);

  const [result] = await client.sendPackAsync({
    fileName: zipName,
    contentFile: zipBuffer.toString("base64"),
  });

  const ticket =
    result?.ticket ??
    result?.return?.ticket ??
    result?.return;

  if (!ticket) {
    throw new Error("sendPack: respuesta vacía o inesperada de SUNAT");
  }

  return String(ticket);
}

// ---------------------------------------------------------------------------
// sendSummary — billService → sendSummary (asíncrono, retorna ticket)
// ---------------------------------------------------------------------------

/**
 * Envía un resumen diario de boletas/anulaciones (método sendSummary).
 *
 * @param {string} url        - URL del billService (sin ?wsdl)
 * @param {Buffer} zipBuffer  - Contenido del ZIP en memoria
 * @param {string} zipName    - Nombre del archivo ZIP
 * @param {string} user       - Usuario SOL completo: "{ruc}{usuarioSunat}"
 * @param {string} password   - Contraseña SOL
 * @param {number} [timeoutMs=30000]
 * @returns {Promise<string>} Ticket de seguimiento
 */
async function sendSummary(url, zipBuffer, zipName, user, password, timeoutMs = 30000) {
  const client = await _createClient(url, user, password, timeoutMs);

  const [result] = await client.sendSummaryAsync({
    fileName: zipName,
    contentFile: zipBuffer.toString("base64"),
  });

  const ticket =
    result?.ticket ??
    result?.return?.ticket ??
    result?.return;

  if (!ticket) {
    throw new Error("sendSummary: respuesta vacía o inesperada de SUNAT");
  }

  return String(ticket);
}

// ---------------------------------------------------------------------------
// getStatus — billService → getStatus (consulta por ticket)
// ---------------------------------------------------------------------------

/**
 * Consulta el estado de un envío asíncrono por ticket.
 * statusCode "0" = aún procesando; otro valor = CDR disponible en content.
 *
 * @param {string} url      - URL del billService (sin ?wsdl)
 * @param {string} ticket   - Ticket retornado por sendPack o sendSummary
 * @param {string} user     - Usuario SOL completo
 * @param {string} password - Contraseña SOL
 * @returns {Promise<{ statusCode: string, content: Buffer | null }>}
 */
async function getStatus(url, ticket, user, password) {
  const client = await _createClient(url, user, password);

  const [result] = await client.getStatusAsync({ ticket });

  const statusResult =
    result?.status ??
    result?.return?.status ??
    result?.return;

  if (!statusResult) {
    throw new Error("getStatus: respuesta vacía o inesperada de SUNAT");
  }

  const statusCode = String(
    statusResult.statusCode ?? statusResult.code ?? statusResult
  );

  const base64Content = statusResult.content ?? statusResult.applicationResponse;
  const content = base64Content ? Buffer.from(base64Content, "base64") : null;

  return { statusCode, content };
}

// ---------------------------------------------------------------------------
// getStatusCdr — billConsultService → getStatusCdr
// ---------------------------------------------------------------------------

/**
 * Consulta el CDR de un comprobante ya enviado (billConsultService).
 *
 * @param {string} url            - URL del billConsultService (sin ?wsdl)
 * @param {string} ruc            - RUC del emisor (11 dígitos)
 * @param {string} docTypeCode    - Código de tipo de comprobante (ej. "01")
 * @param {string} series         - Serie del comprobante (ej. "F001")
 * @param {string|number} number  - Número del comprobante (ej. 3)
 * @param {string} user           - Usuario SOL completo: "{ruc}{usuarioSunat}"
 * @param {string} password       - Contraseña SOL
 * @returns {Promise<{ statusCode: string, statusMessage: string, content: Buffer | null }>}
 */
async function getStatusCdr(url, ruc, docTypeCode, series, number, user, password) {
  const client = await _createClient(url, user, password);

  const [result] = await client.getStatusCdrAsync({
    rucComprobante: ruc,
    tipoComprobante: docTypeCode,
    serieComprobante: series,
    numeroComprobante: parseInt(number, 10),
  });

  // La respuesta tiene la forma: { statusCdr: { content: "<base64>", statusCode, statusMessage } }
  const statusCdr =
    result?.statusCdr ??
    result?.return?.statusCdr ??
    result?.return;

  if (!statusCdr) {
    throw new Error("getStatusCdr: respuesta vacía o inesperada de SUNAT");
  }

  const statusCode = String(statusCdr.statusCode ?? "");
  const statusMessage = String(statusCdr.statusMessage ?? "");
  const base64Content = statusCdr.content;
  const content = base64Content ? Buffer.from(base64Content, "base64") : null;

  return { statusCode, statusMessage, content };
}

// ---------------------------------------------------------------------------
// pollTicket — polling de getStatus hasta que statusCode != "0"
// ---------------------------------------------------------------------------

/**
 * Hace polling de getStatus hasta que el CDR esté disponible o se agoten los intentos.
 *
 * @param {string} url              - URL del billService (sin ?wsdl)
 * @param {string} ticket           - Ticket retornado por sendPack o sendSummary
 * @param {string} user             - Usuario SOL completo
 * @param {string} password         - Contraseña SOL
 * @param {number} [maxAttempts=10] - Máximo de intentos
 * @param {number} [backoffMs=30000] - Espera entre intentos en ms
 * @returns {Promise<{ statusCode: string, content: Buffer | null }>}
 */
async function pollTicket(url, ticket, user, password, maxAttempts = 10, backoffMs = 30000) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await getStatus(url, ticket, user, password);

    if (result.statusCode !== "0") {
      return result;
    }

    if (attempt < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }

  // Agotados los intentos — retornar el último resultado con statusCode "0"
  return await getStatus(url, ticket, user, password);
}

// ---------------------------------------------------------------------------
// readCdr — descomprime y parsea el CDR ZIP
// ---------------------------------------------------------------------------

/**
 * Extrae los mensajes de descripción del XML de respuesta CDR.
 *
 * El XML de respuesta SUNAT tiene la forma:
 *   <ar:ApplicationResponse>
 *     <cac:DocumentResponse>
 *       <cac:Response>
 *         <cbc:ResponseCode>0</cbc:ResponseCode>
 *         <cbc:Description>La Factura numero F001-1, ha sido aceptado</cbc:Description>
 *       </cac:Response>
 *     </cac:DocumentResponse>
 *   </ar:ApplicationResponse>
 *
 * @param {string} xmlContent
 * @returns {string[]}
 */
function _extractCdrMessages(xmlContent) {
  const messages = [];

  // Extraer todos los nodos <cbc:Description>
  const descRegex = /<cbc:Description[^>]*>([\s\S]*?)<\/cbc:Description>/gi;
  let match;
  while ((match = descRegex.exec(xmlContent)) !== null) {
    const text = match[1].trim();
    if (text) messages.push(text);
  }

  // También capturar <cbc:Note> que a veces contiene el mensaje principal
  const noteRegex = /<cbc:Note[^>]*>([\s\S]*?)<\/cbc:Note>/gi;
  while ((match = noteRegex.exec(xmlContent)) !== null) {
    const text = match[1].trim();
    if (text && !messages.includes(text)) messages.push(text);
  }

  return messages;
}

/**
 * Descomprime el CDR ZIP y extrae los mensajes de respuesta de SUNAT.
 *
 * @param {Buffer} cdrBuffer - CDR ZIP recibido de SUNAT
 * @returns {Promise<{ success: boolean, status: "S"|"R"|"E", messages: string[] }>}
 */
async function readCdr(cdrBuffer) {
  try {
    const zip = await JSZip.loadAsync(cdrBuffer);

    const xmlFileName = Object.keys(zip.files).find((name) =>
      name.toLowerCase().endsWith(".xml")
    );

    if (!xmlFileName) {
      return { success: false, status: "E", messages: ["CDR no contiene archivo XML"] };
    }

    const xmlContent = await zip.files[xmlFileName].async("string");
    const messages = _extractCdrMessages(xmlContent);
    const success = messages.some((m) =>
      m.toLowerCase().includes("ha sido aceptado")
    );

    const status = success ? "S" : messages.length > 0 ? "R" : "E";

    return { success, status, messages };
  } catch (err) {
    return {
      success: false,
      status: "E",
      messages: [`Error al leer CDR: ${err.message}`],
    };
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  sendBill,
  sendDocument,
  sendPack,
  sendSummary,
  getStatus,
  getStatusCdr,
  readCdr,
  pollTicket,
};
