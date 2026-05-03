/**
 * Catálogo default de roles Web (empresa). Mantener alineado con
 * `dp-proj-00-02-backend/src/data/web-roles.ts`.
 */
const WEB_ROLES_CATALOG = [
  {
    id: "web-default__admin",
    name: "admin",
    description: "Administrador de empresa (catálogo default)",
    permissions: { "*": ["*"] },
    permission: [],
  },
];

function normName(value) {
  return String(value ?? "").trim().toLowerCase();
}

function cloneCatalogRow(row) {
  return {
    ...row,
    permissions: { ...row.permissions },
    permission: [...row.permission],
  };
}

function toMergedFromCatalog(row, accountId, companyId) {
  return {
    id: row.id,
    companyId,
    accountId,
    name: row.name,
    description: row.description,
    permissions: { ...row.permissions },
    permission: [...row.permission],
    source: "default",
    readonly: true,
  };
}

function toMergedFromDoc(id, data, accountId) {
  return {
    id,
    companyId: String(data.companyId ?? "").trim() || undefined,
    accountId: String(data.accountId ?? "").trim() || accountId,
    name: String(data.name ?? ""),
    description: String(data.description ?? ""),
    permissions: data.permissions && typeof data.permissions === "object" ? data.permissions : {},
    permission: Array.isArray(data.permission) ? data.permission : [],
    source: "custom",
    readonly: false,
    createBy: data.createBy,
    createAt: data.createAt,
    updateBy: data.updateBy,
    updateAt: data.updateAt,
  };
}

/**
 * @param {FirebaseFirestore.Firestore} db
 * @param {string} accountId
 * @param {string} companyId
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
async function listMergedWebRolesForCompany(db, accountId, companyId) {
  const aid = String(accountId ?? "").trim();
  const cid = String(companyId ?? "").trim();
  const snap = await db.collection("roles").where("companyId", "==", cid).where("accountId", "==", aid).get();
  const custom = snap.docs.map((d) => toMergedFromDoc(d.id, d.data() || {}, aid));
  const byName = new Map(custom.map((r) => [normName(r.name), r]));
  const defaultNames = new Set(WEB_ROLES_CATALOG.map((r) => normName(r.name)));
  const merged = WEB_ROLES_CATALOG.map((row) => {
    const key = normName(row.name);
    const hit = byName.get(key);
    return hit ?? toMergedFromCatalog(cloneCatalogRow(row), aid, cid);
  });
  for (const row of custom) {
    const key = normName(row.name);
    if (!defaultNames.has(key)) merged.push(row);
  }
  return merged.sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

module.exports = {
  listMergedWebRolesForCompany,
};
