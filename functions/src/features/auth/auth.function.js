const { logger } = require("firebase-functions");
const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const express = require("express");
const axios = require("axios");

const APP_FIREBASE_API_KEY = defineSecret("APP_FIREBASE_API_KEY");

const app = express();
app.use(express.json());

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

const authApiOptions = {
  cors: true,
  secrets: [APP_FIREBASE_API_KEY],
  timeoutSeconds: 60,
};

const authFunction = onRequest(authApiOptions, app);

module.exports = {
  authFunction,
};

