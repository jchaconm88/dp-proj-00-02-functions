function normalizeCode(value) {
  return String(value || "").trim().toLowerCase();
}

module.exports = {
  normalizeCode,
};
