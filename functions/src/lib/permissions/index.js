const { normalizeCode } = require("./normalize");
const { collectRolePermissionCodes, collectCompanyUserPermissionCodes } = require("./permission-codes");
const { hasPermission, isGrantedFromAuthToken } = require("./grants");

module.exports = {
  normalizeCode,
  collectRolePermissionCodes,
  collectCompanyUserPermissionCodes,
  hasPermission,
  isGrantedFromAuthToken,
};
