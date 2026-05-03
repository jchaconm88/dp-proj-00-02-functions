const { normalizeCode } = require("./normalize");

function collectRolePermissionCodes(roleData) {
  const d = roleData && typeof roleData === "object" ? roleData : {};
  const out = new Set();

  const legacy = Array.isArray(d.permission) ? d.permission : [];
  for (const item of legacy) {
    const code = normalizeCode(item);
    if (!code) continue;
    if (!code.includes(":")) {
      out.add(`*:${code}`);
      continue;
    }
    out.add(code);
  }

  const mapped = d.permissions && typeof d.permissions === "object" ? d.permissions : {};
  for (const [moduleRaw, actionsRaw] of Object.entries(mapped)) {
    const moduleName = normalizeCode(moduleRaw);
    const actions = Array.isArray(actionsRaw) ? actionsRaw : [];
    if (!moduleName || actions.length === 0) continue;
    for (const actionRaw of actions) {
      const action = normalizeCode(actionRaw);
      if (!action) continue;
      if (moduleName === "*" && action === "*") {
        out.add("*");
        continue;
      }
      if (action === "*") {
        out.add(`*:${moduleName}`);
        continue;
      }
      out.add(`${moduleName}:${action}`);
    }
  }

  return Array.from(out);
}

function collectCompanyUserPermissionCodes(companyUserData, rolesById, rolesByName) {
  const d = companyUserData && typeof companyUserData === "object" ? companyUserData : {};
  const roleIds = Array.isArray(d.roleIds) ? d.roleIds : [];
  const roleNames = Array.isArray(d.roleNames) ? d.roleNames : [];
  const out = new Set();

  for (const raw of roleIds) {
    const key = normalizeCode(raw);
    if (!key) continue;
    const role = rolesById.get(key) || rolesByName.get(key);
    if (!role) continue;
    for (const code of collectRolePermissionCodes(role)) out.add(code);
  }

  for (const raw of roleNames) {
    const key = normalizeCode(raw);
    if (!key) continue;
    const role = rolesByName.get(key);
    if (!role) continue;
    for (const code of collectRolePermissionCodes(role)) out.add(code);
  }

  return Array.from(out);
}

module.exports = {
  collectRolePermissionCodes,
  collectCompanyUserPermissionCodes,
};
