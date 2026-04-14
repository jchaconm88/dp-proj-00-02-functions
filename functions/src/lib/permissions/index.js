const { normalizeCode } = require("./normalize");
const { collectRolePermissionCodes, collectMembershipPermissionCodes } = require("./permission-codes");
const { hasPermission, isGrantedFromAuthToken } = require("./grants");

module.exports = {
  normalizeCode,
  collectRolePermissionCodes,
  collectMembershipPermissionCodes,
  hasPermission,
  isGrantedFromAuthToken,
};
