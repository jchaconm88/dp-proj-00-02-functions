/**
 * Cálculo de monto/moneda flete desde contrato + regla de tarifa + servicio.
 * Reutilizable por callable HTTPS y por triggers (p. ej. trips-sync).
 */

const CONTRACTS = "transport-contracts";
const RATE_RULES_SUB = "transport-rate-rules";
const SERVICES = "transport-services";

function pickContractForClient(docs) {
  const list = docs.map((d) => ({ id: d.id, ...d.data() }));
  const active = list.filter((c) => String(c.status ?? "").toLowerCase() === "active");
  const pool = active.length ? active : list;
  pool.sort((a, b) => String(b.validFrom ?? "").localeCompare(String(a.validFrom ?? "")));
  return pool[0] ?? null;
}

function pickRateRuleForService(docs, transportServiceId) {
  const rules = docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((r) => String(r.transportServiceId ?? "").trim() === transportServiceId)
    .filter((r) => r.active !== false);
  rules.sort((a, b) => (Number(a.priority) || 0) - (Number(b.priority) || 0));
  return rules[0] ?? null;
}

/**
 * @param {FirebaseFirestore.Firestore} db
 * @param {{ clientId: string, transportServiceId: string, companyId?: string, accountId?: string }} params
 * @returns {Promise<
 *   | { ok: true, amount: number, currency: string, serviceName: string, contractId: string, ruleId: string }
 *   | { ok: false, reason: "missing_params" | "no_contract" | "no_rule" }
 * >}
 */
async function computeFreightPricingFromContract(db, { clientId, transportServiceId, companyId, accountId }) {
  const cid = String(clientId ?? "").trim();
  const sid = String(transportServiceId ?? "").trim();
  const compId = String(companyId ?? "").trim();
  const accId = String(accountId ?? "").trim();
  if (!cid || !sid) {
    return { ok: false, reason: "missing_params" };
  }

  let contractsQuery = db.collection(CONTRACTS).where("clientId", "==", cid);
  if (compId) contractsQuery = contractsQuery.where("companyId", "==", compId);
  if (accId) contractsQuery = contractsQuery.where("accountId", "==", accId);
  const contractsSnap = await contractsQuery.get();
  if (contractsSnap.empty) {
    return { ok: false, reason: "no_contract" };
  }

  const contract = pickContractForClient(contractsSnap.docs);
  if (!contract) {
    return { ok: false, reason: "no_contract" };
  }

  const contractDocId = contract.id;
  const currency = String(contract.currency ?? "PEN").trim() || "PEN";

  const rulesSnap = await db
    .collection(CONTRACTS)
    .doc(contractDocId)
    .collection(RATE_RULES_SUB)
    .get();

  const rule = pickRateRuleForService(rulesSnap.docs, sid);
  if (!rule) {
    return { ok: false, reason: "no_rule" };
  }

  const calc = rule.calculation && typeof rule.calculation === "object" ? rule.calculation : {};
  const basePrice = Number(calc.basePrice);
  const amount = Number.isFinite(basePrice) ? basePrice : 0;

  let serviceName = "";
  const svcSnap = await db.collection(SERVICES).doc(sid).get();
  if (svcSnap.exists) {
    const s = svcSnap.data() || {};
    serviceName = String(s.name ?? "").trim();
  }

  return {
    ok: true,
    amount,
    currency,
    serviceName,
    contractId: contractDocId,
    ruleId: rule.id,
  };
}

module.exports = {
  computeFreightPricingFromContract,
  CONTRACTS,
  RATE_RULES_SUB,
  SERVICES,
};
