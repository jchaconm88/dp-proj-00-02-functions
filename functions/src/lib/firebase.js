/**
 * Inicialización de Firebase Admin y export de `db` / `admin`.
 * Único punto de entrada al SDK de servidor en este proyecto.
 */
const admin = require("firebase-admin");

if (!admin.apps.length) {
  admin.initializeApp();
}

const db = admin.firestore();

module.exports = {
  admin,
  db,
};
