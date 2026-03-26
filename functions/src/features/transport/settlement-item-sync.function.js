const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const { db } = require("../../lib/firebase");
const { runSettlementItemsWriteDispatch } = require("../../lib/settlement-item.lib");

const onSettlementItemsWrite = onDocumentWritten(
  {
    document: "settlements/{settlementId}/items/{itemId}",
    timeoutSeconds: 60,
  },
  async (event) => {
    await runSettlementItemsWriteDispatch(db, event);
  }
);

module.exports = {
  onSettlementItemsWrite,
};
