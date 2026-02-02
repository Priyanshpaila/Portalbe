import counterModel from "../models/counter.model.js";
import vendorModel from "../models/vendor.model.js";

const COUNTER_ID = "vendorCode";
const PREFIX = "VND";
const PAD_LEN = 4;

let initPromise = null;

function parseSeq(code) {
  const m = String(code || "").trim().match(/^VND(\d+)$/i);
  if (!m?.[1]) return 0;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : 0;
}

function pad(n) {
  return String(n).padStart(PAD_LEN, "0");
}

/**
 * Ensure counter exists and seq >= max vendorCode already in vendor collection.
 * IMPORTANT: Do NOT update seq using multiple operators in one update.
 */
export async function ensureVendorCounterInitialized() {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    // Find max vendorCode (string sort works because VND + padded digits)
    const maxDoc = await vendorModel
      .findOne({ vendorCode: new RegExp(`^${PREFIX}\\d+$`, "i") })
      .sort({ vendorCode: -1 })
      .select({ vendorCode: 1 })
      .lean();

    const maxSeq = maxDoc ? parseSeq(maxDoc.vendorCode) : 0;

    // 1) Ensure counter document exists (ONLY set _id on insert)
    await counterModel.updateOne(
      { _id: COUNTER_ID },
      { $setOnInsert: { _id: COUNTER_ID } },
      { upsert: true }
    );

    // 2) Make sure seq is at least maxSeq (separate update → no conflict)
    if (maxSeq > 0) {
      await counterModel.updateOne(
        { _id: COUNTER_ID },
        { $max: { seq: maxSeq } }
      );
    }
  })();

  return initPromise;
}

/**
 * Atomically generate next vendorCode: VND0001, VND0002, ...
 */
export async function generateNextVendorCode() {
  await ensureVendorCounterInitialized();

  // IMPORTANT: do NOT use setDefaultsOnInsert here.
  // $inc works even if seq doesn't exist (it creates it).
  const counter = await counterModel.findOneAndUpdate(
    { _id: COUNTER_ID },
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );

  const seq = counter?.seq || 1;
  return `${PREFIX}${pad(seq)}`;
}
