import express from "express";
import rfqModel from "../models/rfq.model.js";
import poModel from "../models/po.model.js";
import indentModel from "../models/indent.model.js";
import { importIndents } from "../lib/importIndents.js";
import { syncIndentQuantity } from "../helpers/syncIndentQuantity.js";
import { dataTable } from "../helpers/dataTable.js";
import { randomUUID } from "crypto";
import mongoose from "mongoose";

const indentRouter = express.Router();

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

indentRouter.post("/register", async (req, res, next) => {
  try {
    const { query, filters, ...params } = req.body;
    const matchQuery = [];
    if (filters) {
      const filter = {};
      if (filters.status === "pending")
        filter["$expr"] = {
          $eq: ["$balanceQty", "$indentQty"],
        };
      else if (filters.status === "inProgress")
        filter["$expr"] = {
          $and: [
            {
              $lt: ["$balanceQty", "$indentQty"],
            },
            {
              $gt: ["$balanceQty", 0],
            },
          ],
        };
      else if (filters.status === "completed") filter.balanceQty = 0;
      // else if (filters.status === "expired") filter.status = 1

      if (filters.company?.length) filter.company = { $in: filters.company };
      if (filters.indentNumber)
        filter.indentNumber = filters.indentNumber.trim();
      if (filters.itemCode) filter.itemCode = filters.itemCode.trim();
      if (filters.itemDescription)
        filter.itemDescription = filters.itemDescription.trim();
      if (filters.documentDate?.[0]) {
        filter.documentDate = {};
        if (filters.documentDate[0])
          filter.documentDate["$gte"] = new Date(
            new Date(filters.documentDate[0]).setHours(0, 0, 0, 0),
          );
        if (filters.documentDate[1])
          filter.documentDate["$lte"] = new Date(
            new Date(filters.documentDate[1]).setHours(24, 0, 0, 0) - 1,
          );
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
      },
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
              i.csNumber === cs.csNumber,
          );

          if (pos?.length > 0)
            for (const po of pos) {
              const doc = {
                ...data[key],
                ...rfqDetails,
                ...csDetails,
                ...po,
              };
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
            (po) => !po.quotationNumber && !po.csNumber,
          );
          if (!poDetails[key]?.length) delete poDetails[key];
          else {
            for (const po of poDetails[key]) {
              const doc = {
                ...data[key],
                ...po,
              };
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

// Add new item (auto-generate item code)
indentRouter.post("/add-item", async (req, res, next) => {
  try {
    const itemCode = req.body?.itemCode?.trim();
    const itemDescription = String(req.body?.itemDescription ?? "").trim();
    const techSpec = String(req.body?.techSpec ?? "").trim();
    const make = String(req.body?.make ?? "").trim();
    const unitOfMeasure = String(
      req.body?.unitOfMeasure ?? req.body?.unit ?? "",
    ).trim();

    const itemCodeToUse = itemCode; // Use generated or provided item code

    if (!itemCodeToUse)
      return res.status(400).json({ message: "itemCode is required" });
    if (!itemDescription)
      return res.status(400).json({ message: "itemDescription is required" });
    if (!unitOfMeasure)
      return res.status(400).json({ message: "unitOfMeasure is required" });

    // Check if itemCode already exists
    const exists = await indentModel.findOne({
      documentCategory: "ITEM_MASTER",
      itemCode: itemCodeToUse,
    });

    if (exists) {
      return res.status(409).json({
        message: "Item already exists for this itemCode",
        data: exists,
      });
    }

    const now = new Date();

    const created = await indentModel.create({
      id: randomUUID(), // unique id in your schema
      itemCode: itemCodeToUse,
      itemDescription,
      techSpec,
      make,
      unitOfMeasure,
      documentCategory: "ITEM_MASTER",
      createdOn: now,
      lastChangedOn: now,
      indentQty: 0,
      preRFQQty: 0,
      prePOQty: 0,
      balanceQty: 0,
    });

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
      200,
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
    // base item fields
    "indentNumber", // Allow indentNumber to be updated
    "itemDescription",
    "techSpec",
    "make",
    "unitOfMeasure",
    // "other fields" from your indent schema (safe metadata)
    "company",
    "costCenter",
    "remark",
    "unitOfMeasure",
    "materialNumber",
    "storageLocation",
    "trackingNumber",
    "documentNumber",
    "documentDate",
    "lineNumber",
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

  // normalize "unit" -> unitOfMeasure
  if (
    Object.prototype.hasOwnProperty.call(body, "unit") &&
    !Object.prototype.hasOwnProperty.call(out, "unitOfMeasure")
  ) {
    out.unitOfMeasure = body.unit;
  }

  return out;
}

indentRouter.put("/add-item/:id", async (req, res, next) => {
  try {
    const idParam = String(req.params.id || "").trim();
    const now = new Date();

    const updates = pickAllowedItemMasterUpdates(req.body || {});
    if (!Object.keys(updates).length) {
      return res.status(400).json({ message: "No updatable fields provided" });
    }

    // ✅ protect critical fields (cannot be changed)
    delete updates._id;
    delete updates.id;
    delete updates.documentCategory;
    delete updates.createdOn;

    // ✅ keep qty fields untouched for ITEM_MASTER docs
    delete updates.indentQty;
    delete updates.preRFQQty;
    delete updates.prePOQty;
    delete updates.balanceQty;

    // cast date fields if sent as strings
    if (updates.documentDate)
      updates.documentDate = new Date(updates.documentDate);
    if (updates.utcTimestamp)
      updates.utcTimestamp = new Date(updates.utcTimestamp);

    // ✅ allow :id to be either Mongo _id or your custom uuid "id"
    const match = mongoose.isValidObjectId(idParam)
      ? { _id: idParam }
      : { id: idParam };

    const doc = await indentModel.findOneAndUpdate(
      { ...match, documentCategory: "ITEM_MASTER" }, // ✅ ONLY item-master docs
      { $set: { ...updates, lastChangedOn: now } },
      { new: true, runValidators: true },
    );

    if (!doc) {
      return res.status(404).json({
        message: "ITEM_MASTER item not found (or not created via /add-item)",
      });
    }

    return res.status(200).json({ success: true, data: doc });
  } catch (err) {
    next(err);
  }
});

// Endpoint to fetch the last used item code
indentRouter.get("/last-item-code", async (req, res, next) => {
  try {
    // Find the latest item code (sort by itemCode in descending order)
    const lastItem = await indentModel
      .findOne({ documentCategory: "ITEM_MASTER" })
      .sort({ itemCode: -1 })
      .select("itemCode"); // Only return itemCode

    if (!lastItem) {
      // If no item is found, start from the initial code
      return res.status(200).json({ lastItemCode: "IC00000000" });
    }

    const lastCode = lastItem.itemCode;

    return res.status(200).json({ lastItemCode: lastCode });
  } catch (error) {
    next(error);
  }
});

// Endpoint to fetch the last used indent number
indentRouter.get("/last-indent-number", async (req, res, next) => {
  try {
    // Find the latest indent number (sort by itemCode in descending order)
    const lastItem = await indentModel
      .findOne({ documentCategory: "ITEM_MASTER" })
      .sort({ indentNumber: -1 })
      .select("indentNumber"); // Only return indentNumber

    if (!lastItem) {
      // If no item is found, start from the initial code
      return res.status(200).json({ lastindentNumber: "IN00000000" });
    }

    const lastCode = lastItem.indentNumber;

    return res.status(200).json({ lastindentNumber: lastCode });
  } catch (error) {
    next(error);
  }
});

// Endpoint to fetch the last used line number
indentRouter.get("/last-line-number", async (req, res, next) => {
  try {
    // Find the latest line number (sort by itemCode in descending order)
    const lastItem = await indentModel
      .findOne({ documentCategory: "ITEM_MASTER" })
      .sort({ lineNumber: -1 })
      .select("lineNumber"); // Only return lineNumber

    if (!lastItem) {
      // If no item is found, start from the initial code
      return res.status(200).json({ lastlineNumber: "00000" });
    }

    const lastCode = lastItem.lineNumber;

    return res.status(200).json({ lastlineNumber: lastCode });
  } catch (error) {
    next(error);
  }
});

export default indentRouter;
