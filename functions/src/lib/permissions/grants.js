const { normalizeCode } = require("./normalize");

function hasPermission(codes, moduleName, action) {
  const moduleCode = normalizeCode(moduleName);
  const actionCode = normalizeCode(action);
  const set = new Set((Array.isArray(codes) ? codes : []).map((x) => normalizeCode(x)).filter(Boolean));
  return (
    set.has("*")
    || set.has(moduleCode)
    || set.has(`${moduleCode}:${actionCode}`)
    || set.has(`*:${moduleCode}`)
  );
}

function isGrantedFromAuthToken(auth, moduleName, action) {
  if (auth?.token?.platformAdmin === true) return true;
  const permissionCodes = Array.isArray(auth?.token?.permissionCodes) ? auth.token.permissionCodes : [];
  return hasPermission(permissionCodes, moduleName, action);
}

module.exports = {
  hasPermission,
  isGrantedFromAuthToken,
};
