/**
 * Calcula monto/moneda y tipo de costo según datos de tripAssignment (employee | resource).
 *
 * @param {Record<string, unknown>} assignment
 * @param {FirebaseFirestore.Firestore} db
 * @param {{ allowPartial?: boolean, companyId?: string }} [options] - Si false (callable), falla con Error y .code
 * @returns {Promise<{ amount: number; currency: string; costType: "employee_payment" | "resource_payment" }>}
 */
async function getTripCostFromAssignment(assignment, db, options = {}) {
  const allowPartial = options.allowPartial !== false;
  const companyId = String(options.companyId ?? "").trim();

  const entityType = String(assignment.entityType ?? "");
  const entityId = String(assignment.entityId ?? "").trim();

  if (!entityId) {
    if (!allowPartial) {
      const err = new Error("MISSING_ENTITY_ID");
      err.code = "MISSING_ENTITY_ID";
      throw err;
    }
    return { amount: 0, currency: "PEN", costType: "employee_payment", resourceCostId: "" };
  }

  if (entityType === "resource") {
    const resourceSnap = await db.collection("resources").doc(entityId).get();
    if (!resourceSnap.exists) {
      if (!allowPartial) {
        const err = new Error("RESOURCE_NOT_FOUND");
        err.code = "RESOURCE_NOT_FOUND";
        throw err;
      }
      return { amount: 0, currency: "PEN", costType: "resource_payment", resourceCostId: "" };
    }
    const resource = resourceSnap.data() || {};
    if (companyId && String(resource.companyId ?? "") !== companyId) {
      if (!allowPartial) {
        const err = new Error("TENANT_MISMATCH");
        err.code = "TENANT_MISMATCH";
        throw err;
      }
      return { amount: 0, currency: "PEN", costType: "resource_payment", resourceCostId: "" };
    }

    const costsSnap = await db
      .collection("resources")
      .doc(entityId)
      .collection("resourceCosts")
      .where("type", "==", "per_trip")
      .get();

    const candidates = costsSnap.docs
      .map((d) => ({ id: d.id, ...(d.data() || {}) }))
      .filter((c) => c.active !== false);

    if (!candidates.length) {
      if (!allowPartial) {
        const err = new Error("NO_PER_TRIP_COST");
        err.code = "NO_PER_TRIP_COST";
        throw err;
      }
      return { amount: 0, currency: "PEN", costType: "resource_payment", resourceCostId: "" };
    }

    candidates.sort((a, b) => {
      const ea = String(a.effectiveFrom ?? "");
      const eb = String(b.effectiveFrom ?? "");
      return eb.localeCompare(ea);
    });

    const selected = candidates[0];
    const amount = Number(selected.amount);
    const currency = String(selected.currency ?? "PEN").trim() || "PEN";

    if (!Number.isFinite(amount)) {
      if (!allowPartial) {
        const err = new Error("INVALID_AMOUNT");
        err.code = "INVALID_AMOUNT";
        throw err;
      }
      return { amount: 0, currency: "PEN", costType: "resource_payment", resourceCostId: String(selected.id) };
    }

    return {
      amount,
      currency,
      costType: "resource_payment",
      resourceCostId: String(selected.id),
    };
  }

  if (entityType === "employee") {
    const employeeSnap = await db.collection("employees").doc(entityId).get();
    if (!employeeSnap.exists) {
      if (!allowPartial) {
        const err = new Error("EMPLOYEE_NOT_FOUND");
        err.code = "EMPLOYEE_NOT_FOUND";
        throw err;
      }
      return { amount: 0, currency: "PEN", costType: "employee_payment", resourceCostId: "" };
    }

    const employee = employeeSnap.data() || {};
    if (companyId && String(employee.companyId ?? "") !== companyId) {
      if (!allowPartial) {
        const err = new Error("TENANT_MISMATCH");
        err.code = "TENANT_MISMATCH";
        throw err;
      }
      return { amount: 0, currency: "PEN", costType: "employee_payment", resourceCostId: "" };
    }
    const payroll =
      employee.payroll && typeof employee.payroll === "object" && !Array.isArray(employee.payroll)
        ? employee.payroll
        : {};

    const baseSalary = Number(payroll.baseSalary);
    const workingDays = Math.max(1, Number(payroll.workingDays) || 26);
    const currency = String(payroll.currency ?? "PEN").trim() || "PEN";

    if (!Number.isFinite(baseSalary) || baseSalary < 0) {
      if (!allowPartial) {
        const err = new Error("INVALID_SALARY");
        err.code = "INVALID_SALARY";
        throw err;
      }
      return { amount: 0, currency, costType: "employee_payment", resourceCostId: "" };
    }

    const amount = baseSalary / workingDays;
    if (!Number.isFinite(amount)) {
      if (!allowPartial) {
        const err = new Error("INVALID_AMOUNT");
        err.code = "INVALID_AMOUNT";
        throw err;
      }
      return { amount: 0, currency, costType: "employee_payment", resourceCostId: "" };
    }

    return { amount, currency, costType: "employee_payment", resourceCostId: "" };
  }

  if (!allowPartial) {
    const err = new Error("INVALID_ENTITY_TYPE");
    err.code = "INVALID_ENTITY_TYPE";
    throw err;
  }
  return { amount: 0, currency: "PEN", costType: "employee_payment", resourceCostId: "" };
}

module.exports = {
  computeTripCostFromAssignment: getTripCostFromAssignment,
};
