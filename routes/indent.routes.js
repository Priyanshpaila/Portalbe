import express from "express";
import rfqModel from "../models/rfq.model.js";
import poModel from "../models/po.model.js";
import indentModel from "../models/indent.model.js";
import counterModel from "../models/counter.model.js";
import { importIndents } from "../lib/importIndents.js";
import { syncIndentQuantity } from "../helpers/syncIndentQuantity.js";
import { dataTable } from "../helpers/dataTable.js";
import { randomUUID } from "crypto";
import mongoose from "mongoose";

const indentRouter = express.Router();

/** =========================
 * ✅ AUTO CODE GENERATORS (Atomic counters)
 * ========================= */
function pad(num, len) {
  return String(num).padStart(len, "0");
}

const COUNTERS = {
  ITEM_CODE: { id: "itemCode", prefix: "IC", padLen: 8, field: "itemCode" },
  INDENT_NO: { id: "indentNumber", prefix: "IN", padLen: 8, field: "indentNumber" },
  LINE_NO: { id: "lineNumber", prefix: "", padLen: 5, field: "lineNumber" }, // numeric only
};

// cache init promises so init runs once per process
const initMap = new Map();

async function getMaxSeqFromCollection(cfg) {
  const prefixLen = cfg.prefix.length;

  // We compute numeric part using aggregation (more reliable than .sort() on strings).
  const pipeline = [
    {
      $addFields: {
        __val: { $toString: `$${cfg.field}` },
      },
    },
    {
      $match: cfg.prefix
        ? { __val: { $regex: new RegExp(`^${cfg.prefix}\\d+$`) } }
        : { __val: { $regex: new RegExp(`^\\d+$`) } },
    },
    {
      $project: {
        n: cfg.prefix
          ? {
              $toLong: {
                $substrBytes: [
                  "$__val",
                  prefixLen,
                  { $subtract: [{ $strLenBytes: "$__val" }, prefixLen] },
                ],
              },
            }
          : { $toLong: "$__val" },
      },
    },
    { $group: { _id: null, maxN: { $max: "$n" } } },
  ];

  const res = await indentModel.aggregate(pipeline);
  const maxN = res?.[0]?.maxN;
  return Number.isFinite(maxN) ? Number(maxN) : 0;
}

async function ensureCounterInitialized(counterKey) {
  if (initMap.has(counterKey)) return initMap.get(counterKey);

  const cfg = COUNTERS[counterKey];

  const p = (async () => {
    const maxSeq = await getMaxSeqFromCollection(cfg);

    // ✅ No conflict: only $max touches seq
    await counterModel.findOneAndUpdate(
      { _id: cfg.id },
      { $max: { seq: maxSeq } },
      { upsert: true, new: true }
    );
  })();

  initMap.set(counterKey, p);
  return p;
}

async function nextCode(counterKey) {
  await ensureCounterInitialized(counterKey);
  const cfg = COUNTERS[counterKey];

  // ✅ No conflict: only $inc touches seq
  const counter = await counterModel.findOneAndUpdate(
    { _id: cfg.id },
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );

  const seq = Number(counter?.seq || 1);

  if (cfg.prefix) return `${cfg.prefix}${pad(seq, cfg.padLen)}`;
  return pad(seq, cfg.padLen);
}

async function currentCode(counterKey) {
  await ensureCounterInitialized(counterKey);
  const cfg = COUNTERS[counterKey];

  const doc = await counterModel.findOne({ _id: cfg.id }).lean();
  const seq = Number(doc?.seq || 0);

  if (cfg.prefix) return `${cfg.prefix}${pad(seq, cfg.padLen)}`;
  return pad(seq, cfg.padLen);
}

function normalizeIndentNumber(v) {
  const raw = String(v ?? "").trim();
  if (/^IN\d{8}$/.test(raw)) return raw;
  return "";
}
function normalizeLineNumber(v) {
  const raw = String(v ?? "").replace(/\D/g, "").slice(0, 5);
  if (!raw) return "";
  return pad(parseInt(raw, 10) || 0, 5);
}

/** =========================
 *  Existing helpers
 *  ========================= */
const indentQuery = (filters) => {
  const query = {};

  if (filters?.indentNumber)
    query.indentNumber = Array.isArray(filters?.indentNumber)
      ? { $in: filters?.indentNumber }
      : filters?.indentNumber;

  if (filters?.itemCode)
    query.itemCode = Array.isArray(filters?.itemCode)
      ? { $in: filters?.itemCode }
      : filters?.itemCode;

  return query;
};

indentRouter.get("/import", async (req, res, next) => {
  try {
    await importIndents();
    res.status(200).send({ success: true });
  } catch (error) {
    next(error);
  }
});

indentRouter.get("/sync", async (req, res, next) => {
  try {
    await syncIndentQuantity({ shouldUpdate: true });
    res.status(200).send({ success: true });
  } catch (error) {
    next(error);
  }
});

indentRouter.post("/", async (req, res, next) => {
  try {
    const indents = await indentModel.find(indentQuery(req.body));
    res.status(200).send(indents);
  } catch (error) {
    next(error);
  }
});

indentRouter.post("/list", async (req, res, next) => {
  try {
    const { items, shouldFilterIndents } = req.body || {};
    const query =
      items?.length && shouldFilterIndents
        ? {
            $or: items.map((i) => ({
              indentNumber: i.indentNumber,
              itemCode: i.itemCode,
            })),
          }
        : items?.length
          ? {
              $or: [
                ...items.map((i) => ({
                  indentNumber: i.indentNumber,
                  itemCode: i.itemCode,
                })),
                { balanceQty: { $gt: 0 } },
              ],
            }
          : { balanceQty: { $gt: 0 } };

    const data = await indentModel.find(query).sort({ documentDate: -1 });
    res.status(200).send(data);
  } catch (error) {
    next(error);
  }
});

/**
 * ✅ Your existing /register endpoint (unchanged)
 * (kept exactly in structure; only depends on indentModel/rfqModel/poModel)
 */
indentRouter.post("/register", async (req, res, next) => {
  try {
    const { query, filters, ...params } = req.body;
    const matchQuery = [];
    if (filters) {
      const filter = {};
      if (filters.status === "pending")
        filter["$expr"] = { $eq: ["$balanceQty", "$indentQty"] };
      else if (filters.status === "inProgress")
        filter["$expr"] = {
          $and: [
            { $lt: ["$balanceQty", "$indentQty"] },
            { $gt: ["$balanceQty", 0] },
          ],
        };
      else if (filters.status === "completed") filter.balanceQty = 0;

      if (filters.company?.length) filter.company = { $in: filters.company };
      if (filters.indentNumber) filter.indentNumber = filters.indentNumber.trim();
      if (filters.itemCode) filter.itemCode = filters.itemCode.trim();
      if (filters.itemDescription) filter.itemDescription = filters.itemDescription.trim();
      if (filters.documentDate?.[0]) {
        filter.documentDate = {};
        if (filters.documentDate[0])
          filter.documentDate["$gte"] = new Date(new Date(filters.documentDate[0]).setHours(0, 0, 0, 0));
        if (filters.documentDate[1])
          filter.documentDate["$lte"] = new Date(new Date(filters.documentDate[1]).setHours(24, 0, 0, 0) - 1);
      }

      if (Object.keys(filter).length) matchQuery.push({ $match: filter });
    }

    let { data, ...response } =
      (await dataTable({ ...params, matchQuery }, indentModel, [])) || [];
    if (!data?.length) return res.status(200).json({ data: [] });

    if (filters.status === "pending")
      return res.status(200).json({ data, ...response });

    const getKey = (doc) => doc.indentNumber + ":" + doc.itemCode;
    data = data.reduce((obj, i) => ({ ...obj, [getKey(i)]: i }), {});

    const rfqDocs = await rfqModel.aggregate([
      {
        $match: {
          items: {
            $elemMatch: {
              $or: Object.values(data).map((i) => ({
                indentNumber: i.indentNumber,
                itemCode: i.itemCode,
              })),
            },
          },
        },
      },
      {
        $lookup: {
          from: "comparative_statements",
          localField: "rfqNumber",
          foreignField: "rfqNumber",
          as: "cs",
        },
      },
      {
        $project: {
          "items.indentNumber": 1,
          "items.itemCode": 1,
          "items.rfqQty": 1,
          rfqNumber: 1,
          rfqDate: 1,
          dueDate: 1,
          cs: 1,
        },
      },
    ]);

    const poDocs = await poModel.find(
      {
        items: {
          $elemMatch: {
            $or: Object.values(data).map((i) => ({
              indentNumber: i.indentNumber,
              itemCode: i.itemCode,
            })),
          },
        },
      },
      {
        "items.indentNumber": 1,
        "items.itemCode": 1,
        "items.csNumber": 1,
        "items.csDate": 1,
        "items.qty": 1,
        refDocumentNumber: 1,
        poNumber: 1,
        poDate: 1,
        quotation: 1,
        sapPONumber: 1,
        refCSNumber: 1,
        refCSDate: 1,
      }
    );

    const fields = {};
    const poDetails = {};

    for (const po of poDocs) {
      for (const item of po.items) {
        const key = getKey(item);
        const doc = {
          poNumber: po.poNumber,
          poDate: po.poDate,
          poQty: item.qty,
          sapPONumber: po.sapPONumber,
          quotationNumber: po.refDocumentNumber,
          csNumber: po.refCSNumber || item.csNumber,
          csDate: po.refCSDate || item.csDate,
        };

        if (!poDetails[key]) poDetails[key] = [doc];
        else poDetails[key].push(doc);
      }
    }

    for (const rfq of rfqDocs) {
      for (const item of rfq.items) {
        const key = getKey(item);

        const rfqDetails = {
          rfqNumber: rfq.rfqNumber,
          rfqDate: rfq.rfqDate,
          dueDate: rfq.dueDate,
          rfqQty: item.rfqQty,
        };

        if (!fields[key]) fields[key] = [];

        const updateFields = (cs, s) => {
          const csDetails = {
            csNumber: cs.csNumber,
            csDate: cs.csDate,
            quotationNumber: s.quotationNumber,
            quotationDate: s.quotationDate,
          };

          const pos = poDetails[key]?.filter(
            (i) =>
              i.quotationNumber === csDetails.quotationNumber ||
              i.csNumber === cs.csNumber
          );

          if (pos?.length > 0)
            for (const po of pos) {
              const doc = { ...data[key], ...rfqDetails, ...csDetails, ...po };
              fields[key].push(doc);
            }
        };

        if (rfq?.cs?.length)
          for (const cs of rfq?.cs) {
            if (cs.selection.length === 1 && !cs.selection[0].itemCode) {
              updateFields(cs, cs.selection[0]);
              continue;
            }

            for (const s of cs.selection) {
              if (
                s.itemCode === item.itemCode &&
                s.indentNumber === item.indentNumber
              ) {
                updateFields(cs, s);
              }
            }
          }

        if (poDetails[key]?.length) {
          poDetails[key] = poDetails[key]?.filter(
            (po) => !po.quotationNumber && !po.csNumber
          );
          if (!poDetails[key]?.length) delete poDetails[key];
          else {
            for (const po of poDetails[key]) {
              const doc = { ...data[key], ...po };
              fields[key].push(doc);
            }
          }
        }
      }
    }

    res.status(200).send({ data: Object.values(fields).flat(), ...response });
  } catch (error) {
    next(error);
  }
});

/**
 * ✅ Add new item (Backend ALWAYS generates itemCode, indentNumber, lineNumber)
 * Frontend should NOT send them.
 */
indentRouter.post("/add-item", async (req, res, next) => {
  try {
    const itemDescription = String(req.body?.itemDescription ?? "").trim();
    const techSpec = String(req.body?.techSpec ?? "").trim();
    const make = String(req.body?.make ?? "").trim();
    const unitOfMeasure = String(req.body?.unitOfMeasure ?? req.body?.unit ?? "").trim();

    if (!itemDescription) return res.status(400).json({ message: "itemDescription is required" });
    if (!unitOfMeasure) return res.status(400).json({ message: "unitOfMeasure is required" });

    const now = new Date();

    let created = null;

    // retry safe (handles unique collisions on any of the 3 generated fields)
    for (let attempt = 0; attempt < 10; attempt++) {
      const itemCodeToUse = await nextCode("ITEM_CODE");
      const indentNumberToUse = await nextCode("INDENT_NO");
      const lineNumberToUse = await nextCode("LINE_NO");

      if (!itemCodeToUse) {
        return res.status(500).json({ success: false, message: "Failed to generate itemCode" });
      }

      try {
        created = await indentModel.create({
          id: randomUUID(),
          documentCategory: "ITEM_MASTER",

          itemCode: itemCodeToUse,
          indentNumber: indentNumberToUse,
          lineNumber: lineNumberToUse,

          itemDescription,
          techSpec,
          make,
          unitOfMeasure,

          createdOn: now,
          lastChangedOn: now,

          indentQty: 0,
          preRFQQty: 0,
          prePOQty: 0,
          balanceQty: 0,
        });

        break;
      } catch (e) {
        if (e?.code === 11000) continue; // regenerate and retry
        throw e;
      }
    }

    if (!created) {
      return res.status(500).json({
        success: false,
        message: "Failed to create item with unique auto-generated codes",
      });
    }

    return res.status(201).json({ success: true, data: created });
  } catch (err) {
    next(err);
  }
});

indentRouter.get("/items", async (req, res, next) => {
  try {
    const q = String(req.query.q ?? "").trim();
    const page = Math.max(parseInt(String(req.query.page ?? "1"), 10) || 1, 1);
    const pageSize = Math.min(
      Math.max(parseInt(String(req.query.pageSize ?? "50"), 10) || 50, 1),
      200
    );

    const filter = { documentCategory: "ITEM_MASTER" };

    if (q) {
      filter.$or = [
        { itemCode: { $regex: q, $options: "i" } },
        { itemDescription: { $regex: q, $options: "i" } },
        { make: { $regex: q, $options: "i" } },
        { techSpec: { $regex: q, $options: "i" } },
        { unitOfMeasure: { $regex: q, $options: "i" } },
      ];
    }

    const skip = (page - 1) * pageSize;

    const [data, total] = await Promise.all([
      indentModel
        .find(filter)
        .sort({ lastChangedOn: -1, createdOn: -1 })
        .skip(skip)
        .limit(pageSize),
      indentModel.countDocuments(filter),
    ]);

    res.status(200).json({
      success: true,
      data,
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    });
  } catch (error) {
    next(error);
  }
});

function pickAllowedItemMasterUpdates(body) {
  const allowed = [
    // allow these (optional)
    "indentNumber",
    "lineNumber",

    "itemDescription",
    "documentType",
    "techSpec",
    "make",
    "unitOfMeasure",

    "company",
    "costCenter",
    "remark",
    "materialNumber",
    "storageLocation",
    "trackingNumber",
    "documentNumber",
    "documentDate",
    "requestedBy",
    "createdBy",
    "deletionIndicator",
    "creationIndicator",
    "controlIndicator",
    "orderItemNumber",
    "packageNumber",
    "utcTimestamp",
  ];

  const out = {};
  for (const k of allowed) {
    if (Object.prototype.hasOwnProperty.call(body, k)) out[k] = body[k];
  }

  if (
    Object.prototype.hasOwnProperty.call(body, "unit") &&
    !Object.prototype.hasOwnProperty.call(out, "unitOfMeasure")
  ) {
    out.unitOfMeasure = body.unit;
  }

  return out;
}

/**
 * ✅ Update ITEM_MASTER
 * - If indentNumber/lineNumber is included but blank/invalid => backend generates.
 * - If not included => keep existing.
 */
indentRouter.put("/add-item/:id", async (req, res, next) => {
  try {
    const idParam = String(req.params.id || "").trim();
    const now = new Date();

    const match = mongoose.isValidObjectId(idParam)
      ? { _id: idParam }
      : { id: idParam };

    const updates = pickAllowedItemMasterUpdates(req.body || {});
    if (!updates || typeof updates !== "object") {
      return res.status(400).json({ message: "Invalid payload" });
    }

    delete updates._id;
    delete updates.id;
    delete updates.documentCategory;
    delete updates.createdOn;

    if (updates.documentDate) updates.documentDate = new Date(updates.documentDate);
    if (updates.utcTimestamp) updates.utcTimestamp = new Date(updates.utcTimestamp);

    // if client explicitly sent indentNumber/lineNumber, normalize or auto-generate
    if (Object.prototype.hasOwnProperty.call(updates, "indentNumber")) {
      const v = normalizeIndentNumber(updates.indentNumber);
      updates.indentNumber = v || (await nextCode("INDENT_NO"));
    }
    if (Object.prototype.hasOwnProperty.call(updates, "lineNumber")) {
      const v = normalizeLineNumber(updates.lineNumber);
      updates.lineNumber = v || (await nextCode("LINE_NO"));
    }

    // qty updates
    const qtyKeys = ["indentQty", "preRFQQty", "prePOQty"];
    const qtyUpdates = {};

    for (const k of qtyKeys) {
      if (req.body?.[k] !== undefined && req.body?.[k] !== null && req.body?.[k] !== "") {
        const n = Number(req.body[k]);
        if (!Number.isFinite(n) || n < 0) {
          return res.status(400).json({ message: `${k} must be a non-negative number` });
        }
        qtyUpdates[k] = n;
      }
    }

    if (!Object.keys(updates).length && !Object.keys(qtyUpdates).length) {
      return res.status(400).json({ message: "No updatable fields provided" });
    }

    const existing = await indentModel
      .findOne({ ...match, documentCategory: "ITEM_MASTER" })
      .lean();

    if (!existing) {
      return res.status(404).json({
        message: "ITEM_MASTER item not found (or not created via /add-item)",
      });
    }

    const finalIndentQty = qtyUpdates.indentQty ?? Number(existing.indentQty || 0);
    const finalPreRFQQty = qtyUpdates.preRFQQty ?? Number(existing.preRFQQty || 0);
    const finalPrePOQty = qtyUpdates.prePOQty ?? Number(existing.prePOQty || 0);

    const computedBalanceQty = Math.max(0, finalIndentQty - finalPreRFQQty - finalPrePOQty);

    const finalSet = {
      ...updates,
      ...qtyUpdates,
      balanceQty: computedBalanceQty,
      lastChangedOn: now,
    };

    const doc = await indentModel.findOneAndUpdate(
      { ...match, documentCategory: "ITEM_MASTER" },
      { $set: finalSet },
      { new: true, runValidators: true }
    );

    return res.status(200).json({ success: true, data: doc });
  } catch (err) {
    next(err);
  }
});

/** -------------------------
 * Compatibility endpoints (optional but useful)
 * ------------------------- */
indentRouter.get("/last-item-code", async (req, res, next) => {
  try {
    const lastItemCode = await currentCode("ITEM_CODE"); // last used
    return res.status(200).json({ lastItemCode: lastItemCode || "IC00000000" });
  } catch (e) {
    next(e);
  }
});

indentRouter.get("/last-indent-number", async (req, res, next) => {
  try {
    const lastindentNumber = await currentCode("INDENT_NO");
    return res.status(200).json({ lastindentNumber: lastindentNumber || "IN00000000" });
  } catch (e) {
    next(e);
  }
});

indentRouter.get("/last-line-number", async (req, res, next) => {
  try {
    const lastlineNumber = await currentCode("LINE_NO");
    return res.status(200).json({ lastlineNumber: lastlineNumber || "00000" });
  } catch (e) {
    next(e);
  }
});

export default indentRouter;
