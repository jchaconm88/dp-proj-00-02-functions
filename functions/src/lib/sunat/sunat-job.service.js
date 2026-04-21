"use strict";

const { admin } = require("../firebase");

const COLLECTION = "sunat-jobs";

/**
 * Creates a new job document in the sunat-jobs collection.
 * @param {FirebaseFirestore.Firestore} db
 * @param {object} jobData - { jobType, invoiceId?, invoiceIds?, companyId }
 * @returns {Promise<string>} Generated document ID
 */
async function createJob(db, jobData) {
  const ref = db.collection(COLLECTION).doc();
  await ref.set({
    jobType: jobData.jobType,
    ...(jobData.invoiceId !== undefined && { invoiceId: jobData.invoiceId }),
    ...(jobData.invoiceIds !== undefined && { invoiceIds: jobData.invoiceIds }),
    companyId: jobData.companyId,
    status: "queued",
    retryCount: 0,
    maxRetries: 3,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return ref.id;
}

/**
 * Updates a job document, automatically setting updatedAt.
 * @param {FirebaseFirestore.Firestore} db
 * @param {string} jobId
 * @param {object} updates
 */
async function updateJob(db, jobId, updates) {
  await db.collection(COLLECTION).doc(jobId).update({
    ...updates,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

/**
 * Schedules a retry for a job using exponential backoff, or marks it failed.
 * Backoff: retryCount 0 → 1 min, 1 → 5 min, 2 → 15 min, >=3 → failed
 * @param {FirebaseFirestore.Firestore} db
 * @param {string} jobId
 * @param {number} retryCount - current retry count (before this retry)
 * @param {number} maxRetries
 */
async function scheduleRetry(db, jobId, retryCount, maxRetries) {
  if (retryCount >= maxRetries) {
    await updateJob(db, jobId, { status: "failed" });
    return;
  }

  const BACKOFF_MINUTES = [1, 5, 15];
  const delayMs = (BACKOFF_MINUTES[retryCount] ?? 15) * 60 * 1000;
  const nextRetryAt = new Date(Date.now() + delayMs);

  await updateJob(db, jobId, {
    status: "pending_retry",
    nextRetryAt: admin.firestore.Timestamp.fromDate(nextRetryAt),
    retryCount: retryCount + 1,
  });
}

/**
 * Returns all job documents for a given invoiceId.
 * @param {FirebaseFirestore.Firestore} db
 * @param {string} invoiceId
 * @returns {Promise<Array<{ id: string } & object>>}
 */
async function getJobsByInvoiceId(db, invoiceId) {
  const snapshot = await db
    .collection(COLLECTION)
    .where("invoiceId", "==", invoiceId)
    .get();
  return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}

module.exports = { createJob, updateJob, scheduleRetry, getJobsByInvoiceId };
