import express from "express";
import rfqModel from "../models/rfq.model.js";
import { createError } from "../lib/customError.js";
import { dataTable } from "../helpers/dataTable.js";
import userModel from "../models/user.model.js";
import { Types } from "mongoose";
import upload from "../middlewares/upload.middleware.js";
import generateEmailBody from "../helpers/generateEmailBody.js";
import { sendMail } from "../lib/nodemailer.js";
import {
  authorizePermissions,
  authorizeTokens,
} from "../middlewares/auth.middleware.js";
import { PERMISSIONS } from "../lib/permissions.js";
import csModel from "../models/cs.model.js";
import indentModel from "../models/indent.model.js";
import roleModel from "../models/role.model.js";
import quotationModel from "../models/quotation.model.js";
import { hashAsync } from "../helpers/hash.js";
import { syncIndentQuantity } from "../helpers/syncIndentQuantity.js";
// import { dateAsId } from "../helpers/formatDate.js"
import fs from "fs/promises";

const rfqRouter = express.Router();

const mailRFQ = async (data, user) => {
  const emailRecipients = [];

  for (const vendor of data.vendors) {
    let vendorUser = await userModel.findOne(
      { vendorCode: vendor.vendorCode },
      { _id: 1, email: 1 },
    );

    if (!vendorUser) {
      const vendorRole = await roleModel.findOne(
        { permissions: { $in: [PERMISSIONS.VENDOR_ACCESS] } },
        { _id: 1 },
      );
      const hashedPassword = await hashAsync(vendor.vendorCode, 10);
      vendorUser = await userModel.create({
        username: vendor.vendorCode,
        vendorCode: vendor.vendorCode,
        password: hashedPassword,
        passwordStatus: "temporary",
        createdBy: user,
        name: vendor.name,
        email: vendor.contactPerson.email,
        role: vendorRole._id,
      });
    }

    emailRecipients.push({
      to: vendorUser.email,
      subject: "Request for Quotation",
      text: generateEmailBody.rfq(data.dueDate, vendorUser._id.toString()),
    });
  }
  console.log("Email Recipients:", emailRecipients);
  const result = await sendMail(emailRecipients);

  if (!result.ok) {
    console.log("Email results:", result.results);
    throw new Error("Some vendor emails failed. Check SMTP logs for details.");
  }
};

rfqRouter.post(
  "/",
  authorizeTokens,
  authorizePermissions(PERMISSIONS.MANAGE_RFQ),
  (req, res, next) => {
    req.params.id = new Types.ObjectId().toString();
    next();
  },
  upload.array("file"),
  async (req, res, next) => {
    try {
      const data = JSON.parse(req.body.data);

      if (data?.attachments?.length)
        for (const i of data.attachments) i.status = 1;

      if (data.status === 1) {
        if (data.vendors?.length === 0)
          throw createError("At least one vendor is required", 400);
        if (data.items?.length === 0)
          throw createError("At least one item is required", 400);
        data.submittedBy = req.user?._id;
        data.submittedAt = new Date();
      }

      await rfqModel.create({
        ...data,
        _id: req.params.id,
        createdBy: req.user?._id,
      });

      if (data.items?.length)
        await syncIndentQuantity({
          indents: data.items.map((i) => ({
            indentNumber: i.indentNumber,
            itemCode: i.itemCode,
          })),
          shouldUpdate: true,
        });

      let errorMessage;
      if (data.status === 1 && data.vendors?.length) {
        try {
          await mailRFQ(data, req.user._id);
        } catch (error) {
          errorMessage = "RFQ created but failed to send email to vendors";
        }
      }

      res.status(201).json({ success: true, errorMessage });
    } catch (error) {
      next(error);
    }
  },
);

rfqRouter.post("/list", async (req, res, next) => {
  try {
    const { query, filters, ...params } = req.body;
    const matchQuery = [];
    let pipeline = [];

    if (req.user.vendorCode) {
      matchQuery.push({
        $match: {
          status: 1,
          vendors: {
            $elemMatch: {
              vendorCode: req.user.vendorCode,
              status: 0,
            },
          },
        },
      });
      pipeline = [
        {
          $lookup: {
            from: "quotations",
            foreignField: "rfqNumber",
            localField: "rfqNumber",
            pipeline: [
              {
                $match: {
                  vendorCode: req.user.vendorCode,
                },
              },
              {
                $project: {
                  _id: 1,
                },
              },
            ],
            as: "quotations",
          },
        },
        {
          $match: {
            quotations: { $size: 0 },
          },
        },
        {
          $project: {
            vendors: 0,
            quotations: 0,
          },
        },
      ];
    } else {
      const filter = {};
      if (filters.rfqNumber) filter.rfqNumber = filters.rfqNumber;
      if (filters.rfqDate?.[0]) {
        filter.rfqDate = {};
        if (filters.rfqDate[0])
          filter.rfqDate["$gte"] = new Date(
            new Date(filters.rfqDate[0]).setHours(0, 0, 0, 0),
          );
        if (filters.rfqDate[1])
          filter.rfqDate["$lte"] = new Date(
            new Date(filters.rfqDate[1]).setHours(24, 0, 0, 0) - 1,
          );
      }
      if (filters.indentNumber)
        filter["items.indentNumber"] = filters.indentNumber.trim();
      if (filters.itemCode) filter["items.itemCode"] = filters.itemCode.trim();
      if (filters.itemDescription)
        filter["items.itemDescription"] = filters.itemDescription.trim();
      if (filters.status === "initial") filter.status = 0;
      if (filters.status === "authorized") filter.status = 1;
      if (filters.status === "completed")
        filter.vendors = {
          $not: {
            $elemMatch: { status: { $nin: [1, 2] } },
          },
        };
      if (filters.status === "inProgress")
        filter["$expr"] = {
          $ne: [
            {
              $size: {
                $filter: {
                  input: "$vendors",
                  as: "vendor",
                  cond: { $gt: ["$$vendor.status", 0] },
                },
              },
            },
            {
              $size: "$vendors",
            },
          ],
        };
      if (filters.status === "expired") filter.dueDate = { $lte: new Date() };
      if (Object.keys(filter).length) matchQuery.push({ $match: filter });
      pipeline = [
        {
          $lookup: {
            from: "quotations",
            localField: "rfqNumber",
            foreignField: "rfqNumber",
            pipeline: [
              {
                $match: {
                  status: {
                    $gte: 1,
                  },
                },
              },
              {
                $sort: {
                  createdAt: -1,
                },
              },
              {
                $project: {
                  _id: 1,
                },
              },
            ],
            as: "quotations",
          },
        },
        ...(filters.status === "completed"
          ? [
              {
                $match: {},
              },
            ]
          : []),
        {
          $lookup: {
            from: "users",
            localField: "createdBy",
            foreignField: "_id",
            as: "createdBy",
          },
        },
        {
          $lookup: {
            from: "users",
            localField: "submittedBy",
            foreignField: "_id",
            as: "submittedBy",
          },
        },
        {
          $set: {
            quotations: { $size: "$quotations" },
            regretVendors: {
              $size: {
                $filter: {
                  input: "$vendors",
                  as: "vendor",
                  cond: { $eq: ["$$vendor.status", 2] },
                },
              },
            },
            totalVendors: { $size: "$vendors" },
            createdBy: { $first: "$createdBy.name" },
            submittedBy: { $first: "$submittedBy.name" },
          },
        },
        {
          $unset: ["vendors", "items"],
        },
      ];
    }

    const response = await dataTable(
      { ...params, matchQuery },
      rfqModel,
      pipeline,
    );

    res.status(200).send(response);
  } catch (error) {
    next(error);
  }
});

rfqRouter.get("/values", async (req, res, next) => {
  try {
    const { all } = req.query;
    let matchQuery = { status: 1 };
    if (!all) {
      const userClinics = (
        await userModel.findById(req.user._id, { clinics: 1 })
      )?.clinics;
      matchQuery._id = { $in: userClinics };
    }

    const clinics = await rfqModel.aggregate([
      {
        $match: matchQuery,
      },
      {
        $project: {
          value: "$_id",
          label: "$name",
        },
      },
    ]);
    res.status(200).json(clinics);
  } catch (error) {
    next(error);
  }
});

rfqRouter.put(
  "/dueDate",
  authorizePermissions(PERMISSIONS.MANAGE_RFQ),
  async (req, res, next) => {
    try {
      const { rfqNumber, dueDate, dueDateRemarks } = req.body;
      const rfq = await rfqModel.findOne(
        { rfqNumber },
        { dueDate: 1, dueDateRemarks: 1 },
      );
      if (!rfq) throw createError("RFQ not found", 404);

      const result = await rfqModel.findByIdAndUpdate(
        rfq._id,
        {
          $set: {
            dueDate,
            dueDateRemarks,
          },
          $push: {
            prevDueDates: {
              dueDate: rfq.dueDate,
              dueDateRemarks: rfq.dueDateRemarks,
            },
          },
        },
        { new: true },
      );

      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  },
);

rfqRouter.get("/rfqNumber", async (req, res, next) => {
  try {
    // const dateId = dateAsId()
    // const randomCombo =
    // 	String.fromCharCode(65 + Math.floor(Math.random() * 26))?.toUpperCase() + Math.floor(Math.random() * 10)
    // const rfqNumber = ["R", dateId, randomCombo].join("/")
    const count = await rfqModel.countDocuments();
    res.status(200).json({ rfqNumber: count + 1 });
  } catch (error) {
    next(error);
  }
});

rfqRouter.get("/items/:id", async (req, res, next) => {
  try {
    const rfq = await rfqModel.findById(req.params.id, { items: 1 });
    if (!rfq) throw createError("RFQ not found", 404);
    res.status(200).json(rfq.items);
  } catch (error) {
    next(error);
  }
});

rfqRouter.get(
  "/resend-email",
  authorizeTokens,
  authorizePermissions(PERMISSIONS.MANAGE_RFQ),
  async (req, res, next) => {
    try {
      const { rfqId, vendorCode } = req.query;

      const rfq = await rfqModel.findById(rfqId, {
        rfqNumber: 1,
        dueDate: 1,
        vendors: 1,
      });
      if (!rfq) throw createError("RFQ not found", 404);

      const filtered = rfq.vendors?.filter((i) => i.vendorCode === vendorCode);
      if (!filtered?.length) throw createError("Vendor not found in RFQ", 404);

      await mailRFQ({ ...rfq.toObject(), vendors: filtered }, req.user?._id);

      res.status(200).json({ success: true });
    } catch (error) {
      next(error);
    }
  },
);

rfqRouter.get("/vendors/:id", async (req, res, next) => {
  try {
    // if (req.user.vendorCode) {
    const vendors = await rfqModel.aggregate([
      {
        $match: { _id: new Types.ObjectId(req.params.id) },
      },
      {
        $set: {
          "vendors.rfqNumber": "$rfqNumber",
          "vendors.rfqDate": "$rfqDate",
          "vendors.items": "$items",
        },
      },
      {
        $unwind: {
          path: "$vendors",
          preserveNullAndEmptyArrays: false,
        },
      },
      {
        $replaceRoot: {
          newRoot: "$vendors",
        },
      },
      ...(req.user.vendorCode
        ? [
            {
              $match: {
                vendorCode: req.user.vendorCode,
              },
            },
          ]
        : []),
      {
        $lookup: {
          from: "quotations",
          let: {
            vendorId: "$vendorCode",
            rfqNumber: "$rfqNumber",
          },
          pipeline: [
            {
              $match: {
                status: {
                  $gte: 1,
                },
                $expr: {
                  $and: [
                    {
                      $eq: ["$vendorCode", "$$vendorId"],
                    },
                    {
                      $eq: ["$rfqNumber", "$$rfqNumber"],
                    },
                  ],
                },
              },
            },
          ],
          as: "quotation",
        },
      },
      {
        $set: {
          quotation: {
            $first: "$quotation",
          },
        },
      },
    ]);

    if (!vendors?.length)
      throw createError("No vendors found for this RFQ", 404);

    for (const vendor of vendors) {
      if (!vendor.quotation) continue;
      vendor.quotation.rfqDate = vendor.rfqDate;

      if (!vendor.quotation.items?.length) continue;
      for (const item of vendor.quotation.items) {
        const rfqItem = vendor.items.find(
          (i) =>
            i.itemCode === item.itemCode &&
            i.indentNumber === item.indentNumber,
        );
        if (!rfqItem) continue;
        item.itemDescription = rfqItem.itemDescription;
        item.unit = rfqItem.unit;
      }
    }

    const cs = await csModel.aggregate([
      {
        $match: { rfqNumber: vendors[0].rfqNumber },
      },
      {
        $project: {
          _id: 1,
          csNumber: 1,
          status: 1,
        },
      },
      {
        $lookup: {
          from: "purchase_orders",
          localField: "csNumber",
          foreignField: "refCSNumber",
          as: "poNumber",
        },
      },
      {
        $set: {
          poNumber: {
            $first: "$poNumber.poNumber",
          },
        },
      },
    ]);

    res.status(200).json({ vendors, cs: cs?.[0] });
  } catch (error) {
    next(error);
  }
});

rfqRouter.post("/vendor/list/:id", async (req, res, next) => {
  try {
    const vendors = await rfqModel.aggregate([
      {
        $match: {
          "vendors.vendorCode": req.params.id,
        },
      },
      {
        $sort: {
          dueDate: -1,
        },
      },
      {
        $project: {
          rfqNumber: 1,
          rfqDate: 1,
          indentNumber: 1,
          "items.indentNumber": 1,
          "items.itemDescription": 1,
          "items.itemCode": 1,
        },
      },
    ]);

    res.status(200).json({ data: vendors });
  } catch (error) {
    next(error);
  }
});

rfqRouter.get("/attachments/:id", async (req, res, next) => {
  try {
    const rfq = await rfqModel.findById(req.params.id, { attachments: 1 });
    if (!rfq) throw createError("RFQ not found", 404);
    res.status(200).json(rfq.attachments);
  } catch (error) {
    next(error);
  }
});

rfqRouter.get("/", async (req, res, next) => {
  try {
    const { rfqNumber } = req.query;
    const rfq = await rfqModel.findOne({ rfqNumber });
    if (!rfq) throw createError("RFQ not found", 404);
    res.status(200).json(rfq);
  } catch (error) {
    next(error);
  }
});

rfqRouter.get("/negotiation", async (req, res, next) => {
  try {
    const { rfqNumber } = req.query;
    const rfq = await rfqModel.findOne(
      { rfqNumber },
      {
        rfqNumber: 1,
        "items.indentNumber": 1,
        "items.itemCode": 1,
        "items.rfqMake": 1,
        termsConditions: 1,
      },
    );
    if (!rfq) throw createError("RFQ not found", 404);
    res.status(200).json(rfq);
  } catch (error) {
    next(error);
  }
});

rfqRouter.get("/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    const { indents } = req.query;

    const data = {};

    data.rfq = await rfqModel.findOne(
      id.length === 24
        ? { $or: [{ _id: new Types.ObjectId(id) }, { rfqNumber: id }] }
        : { rfqNumber: id },
    );

    if (!data.rfq) throw createError("RFQ not found", 404);

    if (
      req.user.vendorCode &&
      req.user?.permissions?.includes(PERMISSIONS.VENDOR_ACCESS)
    )
      data.rfq.vendors = data.rfq.vendors.filter(
        (i) => i.vendorCode === req.user.vendorCode,
      );

    if (indents) {
      data.indents = await indentModel.find({
        $or: data.rfq.items.map((i) => ({
          indentNumber: i.indentNumber,
          itemCode: i.itemCode,
        })),
      });
    }

    res.status(200).json(data);
  } catch (error) {
    next(error);
  }
});

rfqRouter.put(
  "/:id",
  authorizeTokens,
  authorizePermissions(PERMISSIONS.MANAGE_RFQ),
  upload.array("file"),
  async (req, res, next) => {
    try {
      const data = JSON.parse(req.body.data);
      if (data.status === 1) {
        if (data.vendors?.length === 0)
          throw createError("At least one vendor is required", 400);
        if (data.items?.length === 0)
          throw createError("At least one item is required", 400);
        data.submittedBy = req.user?._id;
        data.submittedAt = new Date();
      }

      const updatedRFQ = await rfqModel.findByIdAndUpdate(
        req.params.id,
        { $set: data },
        { new: true },
      );
      if (!updatedRFQ) throw createError("RFQ not found", 404);

      if (updatedRFQ.items?.length)
        await syncIndentQuantity({
          indents: updatedRFQ.items.map((i) => ({
            indentNumber: i.indentNumber,
            itemCode: i.itemCode,
          })),
          shouldUpdate: true,
        });

      let errorMessage;
      if (updatedRFQ.status === 1 && data.vendors?.length) {
        try {
          await mailRFQ(updatedRFQ, req.user._id);
        } catch (error) {
          errorMessage = "RFQ updated but failed to send email to vendors";
        }
      }

      res.status(200).json({ ...updatedRFQ, errorMessage });
    } catch (error) {
      next(error);
    }
  },
);

rfqRouter.patch(
  "/add-vendor/:id",
  authorizeTokens,
  authorizePermissions(PERMISSIONS.MANAGE_RFQ),
  async (req, res, next) => {
    try {
      const { vendor } = req.body;
      const rfq = await rfqModel.findById(req.params.id);
      if (!rfq) throw createError("RFQ not found", 404);

      if (rfq.vendors.some((v) => v.vendorCode === vendor.vendorCode)) {
        throw createError("Vendor already added to RFQ", 400);
      }

      rfq.vendors.push(vendor);
      await rfq.save();

      let errorMessage;
      try {
        await mailRFQ(
          { ...rfq.toObject(), vendors: [vendor], dueDate: rfq.dueDate },
          req.user._id,
        );
      } catch (error) {
        errorMessage = "Vendor added but failed to send rfq email.";
      }

      res.status(200).json({ success: true, errorMessage });
    } catch (error) {
      next(error);
    }
  },
);

rfqRouter.patch(
  "/regret",
  authorizeTokens,
  authorizePermissions(PERMISSIONS.VENDOR_ACCESS),
  async (req, res, next) => {
    try {
      const { rfqNumber } = req.query;
      const rfq = await rfqModel.findOne({ rfqNumber });
      if (!rfq) throw createError("RFQ not found", 404);

      if (
        !req.user.vendorCode ||
        !rfq.vendors?.some((i) => i.vendorCode === req.user.vendorCode)
      )
        throw createError("Invalid vendor", 405);

      rfq.vendors = rfq.vendors.map((vendor) => {
        if (vendor.vendorCode === req.user.vendorCode) {
          vendor.status = 2;
          vendor.regretTimestamp = new Date();
        }
        return vendor;
      });

      await rfq.save();

      res.status(200).json({ success: true });
    } catch (error) {
      next(error);
    }
  },
);

rfqRouter.delete(
  "/:id",
  authorizeTokens,
  authorizePermissions(PERMISSIONS.MANAGE_RFQ),
  async (req, res, next) => {
    try {
      const rfq = await rfqModel.findById(req.params.id, {
        rfqNumber: 1,
        items: 1,
      });
      if (!rfq) throw createError("Invalid Id, RFQ not found.", 400);

      const recordsExists = await quotationModel.countDocuments({
        rfqNumber: rfq?.rfqNumber,
      });
      if (recordsExists)
        throw createError(
          recordsExists + " quotations have been submitted for this RFQ.",
          400,
        );
      else {
        await rfqModel.findByIdAndDelete(req.params.id);
        await syncIndentQuantity({
          indents: rfq.items.map((i) => ({
            indentNumber: i.indentNumber,
            itemCode: i.itemCode,
          })),
          shouldUpdate: true,
        });
        await fs.rm("uploads/" + req.params.id, {
          recursive: true,
          force: true,
        });
      }

      res.status(200).send({ success: true });
    } catch (error) {
      next(error);
    }
  },
);

export default rfqRouter;
