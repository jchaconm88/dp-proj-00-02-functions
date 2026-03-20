/**
 * Secuencias correlativas (Firestore). Alinear con `sequences` / `sequence-code` en la web.
 */

const COLLECTION_SEQUENCES = "sequences";
const COLLECTION_COUNTERS = "counters";

function makeCounterId(sequenceId, period) {
  const safe = String(period ?? "").replace(/\//g, "-").trim() || "all";
  return `${sequenceId}_${safe}`;
}

function getCurrentPeriod(resetPeriod) {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  switch (resetPeriod) {
    case "yearly":
      return String(y);
    case "monthly":
      return `${y}-${m}`;
    case "daily":
      return `${y}-${m}-${d}`;
    default:
      return "all";
  }
}

function formatSequenceCode(sequence, nextNumber, referenceDate = new Date()) {
  const year = String(referenceDate.getFullYear());
  const month = String(referenceDate.getMonth() + 1).padStart(2, "0");
  const day = String(referenceDate.getDate()).padStart(2, "0");
  const digits = Math.max(0, Number(sequence.digits) || 6);
  const numberStr = String(nextNumber).padStart(digits, "0");
  return String(sequence.format ?? "{prefix}-{number}")
    .replace(/\{prefix\}/gi, sequence.prefix ?? "")
    .replace(/\{year\}/gi, year)
    .replace(/\{month\}/gi, month)
    .replace(/\{day\}/gi, day)
    .replace(/\{number\}/gi, numberStr);
}

function toSequenceRecord(id, data) {
  const rp = data.resetPeriod;
  const resetPeriod =
    rp === "yearly" || rp === "monthly" || rp === "daily" ? rp : "never";
  return {
    id,
    entity: String(data.entity ?? ""),
    prefix: String(data.prefix ?? ""),
    digits: Number(data.digits) || 6,
    format: String(data.format ?? "{prefix}-{number}"),
    resetPeriod,
    allowManualOverride: data.allowManualOverride === true,
    preventGaps: data.preventGaps === true,
    active: data.active !== false,
  };
}

async function getActiveSequenceByEntity(db, entity) {
  const snap = await db
    .collection(COLLECTION_SEQUENCES)
    .where("entity", "==", entity)
    .limit(1)
    .get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  const rec = toSequenceRecord(doc.id, doc.data());
  return rec.active !== false ? rec : null;
}

async function generateSequenceNumber(db, entity) {
  const sequence = await getActiveSequenceByEntity(db, entity);
  if (!sequence) {
    throw new Error(`No existe una secuencia activa para la entidad "${entity}".`);
  }

  const period = getCurrentPeriod(sequence.resetPeriod);
  const counterId = makeCounterId(sequence.id, period);

  const nextNumber = await db.runTransaction(async (tx) => {
    const ref = db.collection(COLLECTION_COUNTERS).doc(counterId);
    const s = await tx.get(ref);
    let next;
    if (!s.exists) {
      next = 1;
      tx.set(ref, {
        sequenceId: sequence.id,
        sequence: `${sequence.entity} (${sequence.prefix})`.trim(),
        period,
        lastNumber: 1,
        active: true,
      });
    } else {
      const last = Number(s.data()?.lastNumber ?? 0) || 0;
      next = last + 1;
      tx.update(ref, { lastNumber: next });
    }
    return next;
  });

  return formatSequenceCode(sequence, nextNumber);
}

/**
 * Trim no vacío → tal cual; vacío → correlativo.
 */
async function resolveDraftCodeWithGenerator(db, draftCode, entity) {
  const trimmed = String(draftCode ?? "").trim();
  if (trimmed) return trimmed;
  return generateSequenceNumber(db, entity);
}

module.exports = {
  resolveDraftCodeWithGenerator,
  generateSequenceNumber,
  getActiveSequenceByEntity,
};
