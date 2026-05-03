const { logger } = require("firebase-functions");
const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const express = require("express");
const axios = require("axios");
const { admin } = require("../../lib/firebase");
const { runMigrateMultiempresa } = require("../../lib/migrate-multiempresa.service");

const APP_FIREBASE_API_KEY = defineSecret("APP_FIREBASE_API_KEY");

const app = express();
app.use(express.json());

/**
 * Bearer Firebase ID token (mismo usuario que en la app web tras login).
 * @returns {Promise<{ uid: string; email: string | undefined } | null>}
 */
async function getAuthFromBearer(req) {
  const h = req.headers.authorization || req.headers.Authorization;
  const raw = Array.isArray(h) ? h[0] : h;
  const m = typeof raw === "string" ? raw.match(/^Bearer\s+(.+)$/i) : null;
  if (!m) return null;
  const token = m[1].trim();
  if (!token) return null;
  const decoded = await admin.auth().verifyIdToken(token);
  return { uid: decoded.uid, email: decoded.email };
}

app.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      res.status(400).json({
        error: "Bad Request",
        message: "Se requieren email y password en el body.",
      });
      return;
    }

    const url = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${APP_FIREBASE_API_KEY.value()}`;

    const response = await axios.post(
      url,
      {
        email,
        password,
        returnSecureToken: true,
      },
      {
        headers: { "Content-Type": "application/json" },
        timeout: 10000,
      }
    );

    res.status(200).json(response.data);
  } catch (error) {
    if (axios.isAxiosError(error) && error.response) {
      const status = error.response.status;
      const data = error.response.data || {};
      logger.warn("Identity Toolkit error", { status, error: data });
      res.status(status).json({
        error: data.error?.message || "Error de autenticación",
        ...data,
      });
      return;
    }
    logger.error("Login error", error);
    res.status(500).json({
      error: "Internal Server Error",
      message: "Error al procesar el login.",
    });
  }
});

app.get("/", (req, res) => {
  res.status(200).json({ status: "ok", service: "authFunction" });
});

/**
 * Migración multiempresa (HTTP). Requiere Authorization: Bearer <idToken>
 * y un perfil admin en Firestore con users.email igual al email enviado (body.email o email del token).
 * Body: { email?, companyId, companyName, seedCompanyUsers (alias: seedMemberships), limitPerCollection, collections }
 * Si envías body.email debe coincidir con el email del token (misma cuenta).
 */
app.post("/migrate-multiempresa", async (req, res) => {
  try {
    const authCtx = await getAuthFromBearer(req);
    if (!authCtx) {
      res.status(401).json({
        error: "Unauthorized",
        message: "Se requiere header Authorization: Bearer <idToken de Firebase>.",
      });
      return;
    }
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const tokenEmail = authCtx.email ? String(authCtx.email).trim() : "";
    const sent =
      typeof body.email === "string" && String(body.email).trim()
        ? String(body.email).trim()
        : "";
    const lookupEmail = sent || tokenEmail;
    if (!lookupEmail) {
      res.status(400).json({
        error: "Bad Request",
        message: "Se requiere email en el body o un token que incluya email.",
      });
      return;
    }
    if (sent && tokenEmail && sent.toLowerCase() !== tokenEmail.toLowerCase()) {
      res.status(403).json({
        error: "Forbidden",
        message: "El email del body no coincide con la cuenta autenticada.",
      });
      return;
    }
    const result = await runMigrateMultiempresa(body, lookupEmail);
    res.status(200).json(result);
  } catch (error) {
    if (error && error.code === "invalid-argument") {
      res.status(400).json({
        error: "Bad Request",
        message: error.message || "Solicitud inválida.",
      });
      return;
    }
    if (error && error.code === "permission-denied") {
      res.status(403).json({
        error: "Forbidden",
        message: error.message || "Solo admin puede ejecutar migraciones.",
      });
      return;
    }
    if (error && error.code === "auth/id-token-expired") {
      res.status(401).json({ error: "Unauthorized", message: "Token expirado." });
      return;
    }
    if (error && error.code === "auth/argument-error") {
      res.status(401).json({ error: "Unauthorized", message: "Token inválido." });
      return;
    }
    if (error && String(error.code || "").startsWith("auth/")) {
      res.status(401).json({
        error: "Unauthorized",
        message: error.message || "Token de Firebase inválido o rechazado.",
      });
      return;
    }
    logger.error("migrate-multiempresa HTTP error", error);
    res.status(500).json({
      error: "Internal Server Error",
      message: error instanceof Error ? error.message : "Error al migrar.",
    });
  }
});

const authApiOptions = {
  cors: true,
  secrets: [APP_FIREBASE_API_KEY],
  /** Migración puede tardar; login sigue siendo rápido. */
  timeoutSeconds: 540,
};

const authFunction = onRequest(authApiOptions, app);

module.exports = {
  authFunction,
};

