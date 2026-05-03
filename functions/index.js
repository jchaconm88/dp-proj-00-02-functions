const { authFunction } = require("./src/features/auth/auth.function");
const {
  getResourcePerTripCost,
  getPerTripCostByEntity,
} = require("./src/features/transport/trip-costs.function");
const { onTripAssignmentsWrite } = require("./src/features/transport/trip-assignments-sync.function");
const { onTripsWrite } = require("./src/features/transport/trips-sync.function");
const { generateSequenceCode } = require("./src/features/system/sequences.function");
const { getTripChargeFreightPricing } = require("./src/features/transport/trip-charge-freight-pricing.function");
const { syncSettlementItems } = require("./src/features/transport/settlements-sync.function");
const { onSettlementItemsWrite } = require("./src/features/transport/settlement-item-sync.function");
const { createReportRun } = require("./src/features/reports/create-report-run.function");
const { processReportRun } = require("./src/features/reports/process-report-run.function");
const { getReportRunDownloadUrl } = require("./src/features/reports/get-report-run-download-url.function");
const { previewReportPivot } = require("./src/features/reports/preview-report-pivot.function");
const { migrateMultiempresa } = require("./src/features/system/migrations/migrate-multiempresa.function");
const { resolveAuthUidByEmail } = require("./src/features/auth/resolve-auth-uid.function");
const { migrationHttp } = require("./src/features/system/migration-http.function");
const { refreshTenantClaims } = require("./src/features/auth/refresh-tenant-claims.function");
const {
  systemListUsers,
  systemListRolesByCompany,
  systemListCompanyUsers,
  systemListMyCompanyUsers,
  systemUpsertCompanyUser,
  systemUpdateCompanyUser,
  systemDeleteCompanyUser,
} = require("./src/features/system/system-store.function");
const { reconcileUsageMetrics } = require("./src/features/system/usage-metrics-reconcile.function");
const { prepareDashboardSnapshot } = require("./src/features/system/prepare-dashboard-snapshot.function");
const {
  onAnyRootDocCreatedForDashboard,
  onAnyRootDocDeletedForDashboard,
  onUsageMonthsWrittenForDashboard,
  onSubscriptionsWrittenForDashboard,
  onPlansWrittenForDashboard,
} = require("./src/features/system/dashboard-snapshot-sync.function");
const { sendInvoicesToSunat } = require('./src/features/billing/send-invoice.function');
const { queryInvoicesCdr } = require('./src/features/billing/get-status-cdr.function');
const { sendInvoicesPack } = require('./src/features/billing/send-invoice-pack.function');
const { sendDailySummary } = require('./src/features/billing/send-daily-summary.function');
const { processSunatJob, processSunatJobRetry } = require('./src/features/billing/process-sunat-job.function');
const { onInvoicesIssuedPrintPdf } = require("./src/features/billing/on-invoice-updated.function");
const { changeInvoiceStatus } = require("./src/features/billing/change-invoice-status.function");

exports.authFunction = authFunction;
exports.getResourcePerTripCost = getResourcePerTripCost;
exports.getPerTripCostByEntity = getPerTripCostByEntity;
exports.onTripAssignmentsWrite = onTripAssignmentsWrite;
exports.onTripsWrite = onTripsWrite;
exports.generateSequenceCode = generateSequenceCode;
exports.getTripChargeFreightPricing = getTripChargeFreightPricing;
exports.syncSettlementItems = syncSettlementItems;
exports.onSettlementItemsWrite = onSettlementItemsWrite;
exports.createReportRun = createReportRun;
exports.processReportRun = processReportRun;
exports.getReportRunDownloadUrl = getReportRunDownloadUrl;
exports.previewReportPivot = previewReportPivot;
exports.migrateMultiempresa = migrateMultiempresa;
exports.resolveAuthUidByEmail = resolveAuthUidByEmail;
exports.migrationHttp = migrationHttp;
exports.refreshTenantClaims = refreshTenantClaims;
exports.systemListUsers = systemListUsers;
exports.systemListRolesByCompany = systemListRolesByCompany;
exports.systemListCompanyUsers = systemListCompanyUsers;
exports.systemListMyCompanyUsers = systemListMyCompanyUsers;
exports.systemUpsertCompanyUser = systemUpsertCompanyUser;
exports.systemUpdateCompanyUser = systemUpdateCompanyUser;
exports.systemDeleteCompanyUser = systemDeleteCompanyUser;
exports.reconcileUsageMetrics = reconcileUsageMetrics;
exports.prepareDashboardSnapshot = prepareDashboardSnapshot;
exports.onAnyRootDocCreatedForDashboard = onAnyRootDocCreatedForDashboard;
exports.onAnyRootDocDeletedForDashboard = onAnyRootDocDeletedForDashboard;
exports.onUsageMonthsWrittenForDashboard = onUsageMonthsWrittenForDashboard;
exports.onSubscriptionsWrittenForDashboard = onSubscriptionsWrittenForDashboard;
exports.onPlansWrittenForDashboard = onPlansWrittenForDashboard;
exports.sendInvoicesToSunat = sendInvoicesToSunat;
exports.queryInvoicesCdr = queryInvoicesCdr;
exports.sendInvoicesPack = sendInvoicesPack;
exports.sendDailySummary = sendDailySummary;
exports.processSunatJob = processSunatJob;
exports.processSunatJobRetry = processSunatJobRetry;
exports.onInvoicesIssuedPrintPdf = onInvoicesIssuedPrintPdf;
exports.changeInvoiceStatus = changeInvoiceStatus;
