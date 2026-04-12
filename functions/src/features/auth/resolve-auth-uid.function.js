const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { admin } = require("../../lib/firebase");

function normalizeCode(value) {
  return String(value || "").trim().toLowerCase();
}

function assertCanResolveUsersByEmail(auth) {
  if (auth?.token?.platformAdmin === true) return;

  const codes = Array.isArray(auth?.token?.permissionCodes) ? auth.token.permissionCodes : [];
  const set = new Set(codes.map((x) => normalizeCode(x)).filter(Boolean));
  const canReadUsers =
    set.has("*") ||
    set.has("user") ||
    set.has("user:view") ||
    set.has("*:user");

  if (canReadUsers) return;
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
