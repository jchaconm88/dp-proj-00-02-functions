const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { admin } = require("../../lib/firebase");
const { isGrantedFromAuthToken } = require("../../lib/permissions");

function assertCanResolveUsersByEmail(auth) {
  if (isGrantedFromAuthToken(auth, "user", "view")) return;
  throw new HttpsError("permission-denied", "Sin permiso para resolver usuarios por email.");
}

const resolveAuthUidByEmail = onCall({ cors: true }, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Debes iniciar sesión.");
  }
  assertCanResolveUsersByEmail(request.auth);

  const email = String(request.data?.email ?? "").trim().toLowerCase();
  if (!email) {
    throw new HttpsError("invalid-argument", "Se requiere email.");
  }

  try {
    const u = await admin.auth().getUserByEmail(email);
    return { uid: u.uid, email: u.email ?? email };
  } catch {
    throw new HttpsError("not-found", "No hay usuario en Authentication con ese email.");
  }
});

module.exports = { resolveAuthUidByEmail };
