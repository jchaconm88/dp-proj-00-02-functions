"use strict";

const { admin } = require("../firebase");

const COLLECTION = "sunat-jobs";

/**
 * Creates a new job document in the sunat-jobs collection.
 * @param {FirebaseFirestore.Firestore} db
 * @param {object} jobData - { jobType, invoiceId?, invoiceIds?, companyId, ...denormalized fields }
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
    ...(jobData.documentNo !== undefined && { documentNo: jobData.documentNo }),
    ...(jobData.docType !== undefined && { docType: jobData.docType }),
    ...(jobData.issueDate !== undefined && { issueDate: jobData.issueDate }),
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

module.exports = { createJob, updateJob, getJobsByInvoiceId };
