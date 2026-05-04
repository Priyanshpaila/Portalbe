import express from "express";
import { Types } from "mongoose";
import rfqModel from "../models/rfq.model.js";
import quotationModel from "../models/quotation.model.js";
import indentModel from "../models/indent.model.js";
import poModel from "../models/po.model.js";
import userModel from "../models/user.model.js";

const appRouter = express.Router();

const authorizedPOQuery = {
  $expr: {
    $eq: [
      { $size: "$authorize" },
      {
        $size: {
          $filter: {
            input: "$authorize",
            as: "auth",
            cond: { $eq: ["$$auth.approvalStatus", 1] },
          },
        },
      },
    ],
  },
};

const normalizeText = (value) =>
  String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");

const isSuperAdminUser = (user) => {
  const role = user?.role || {};
  const roleName =
    role?.name ||
    role?.roleName ||
    role?.label ||
    role?.code ||
    user?.roleName ||
    user?.userType ||
    "";

  const normalizedRole = normalizeText(roleName);
  const normalizedUsername = normalizeText(user?.username);

  return (
    user?.isSuperAdmin === true ||
    ["superadmin", "superadministrator"].includes(normalizedRole) ||
    ["superadmin", "superadministrator"].includes(normalizedUsername)
  );
};

const getRequestUserScope = async (req) => {
  const userId = req.user?._id || req.user?.id;

  const dbUser =
    userId && Types.ObjectId.isValid(userId)
      ? await userModel.findById(userId).populate("role").lean()
      : null;

  const user = dbUser || req.user || {};

  const vendorCode = user?.vendorCode || req.user?.vendorCode || null;
  const companyName = String(user?.company?.name || req.user?.company?.name || "").trim();
  const isSuperAdmin = isSuperAdminUser(user);

  const companyFilter =
    !vendorCode && !isSuperAdmin
      ? { company: companyName || "__NO_COMPANY__" }
      : {};

  return {
    userId,
    vendorCode,
    companyName,
    isSuperAdmin,
    companyFilter,
  };
};

const hasCompanyFilter = (companyFilter = {}) => Object.keys(companyFilter || {}).length > 0;

const getStats = async (userId, companyFilter = {}) => {
  const expiringIndents = 0;

  const userObjectId = Types.ObjectId.isValid(userId)
    ? new Types.ObjectId(userId)
    : null;

  const getUnapprovedPOsForUser = async () => {
    if (!userObjectId) return 0;

    const result = await poModel.aggregate([
      {
        $match: {
          ...companyFilter,
          readyForAuthorization: true,
          status: { $ne: 1 },
          authorize: {
            $elemMatch: {
              user: userObjectId,
              approvalStatus: 0,
            },
          },
        },
      },
      {
        $addFields: {
          currentPendingIndex: {
            $indexOfArray: ["$authorize.approvalStatus", 0],
          },
        },
      },
      {
        $match: {
          currentPendingIndex: { $gte: 0 },
        },
      },
      {
        $addFields: {
          currentPendingApprover: {
            $arrayElemAt: ["$authorize", "$currentPendingIndex"],
          },
        },
      },
      {
        $match: {
          "currentPendingApprover.user": userObjectId,
          "currentPendingApprover.approvalStatus": 0,
        },
      },
      {
        $count: "count",
      },
    ]);

    return result?.[0]?.count || 0;
  };

  const [
    pendingIndents,
    pendingRFQs,
    initialRFQs,
    submittedQuotations,
    outstandingQuotations,
    unapprovedPOs,
    totalPOs,
  ] = await Promise.all([
    indentModel.countDocuments({
      ...companyFilter,
      $expr: { $eq: ["$balanceQty", "$indentQty"] },
    }),

    rfqModel.countDocuments({
      ...companyFilter,
      status: 1,
    }),

    rfqModel.countDocuments({
      ...companyFilter,
      status: 0,
    }),

    quotationModel.countDocuments({
      ...companyFilter,
      status: { $gte: 1 },
    }),

    (async () => {
      return (
        await rfqModel.find(
          {
            ...companyFilter,
            status: 1,
          },
          { vendors: 1 },
        )
      )?.reduce(
        (sum, i) => sum + (i.vendors || []).filter((v) => v.status === 0).length,
        0,
      );
    })(),

    getUnapprovedPOsForUser(),

    poModel.countDocuments({
      ...companyFilter,
    }),
  ]);

  return {
    expiringIndents,
    pendingIndents,
    pendingRFQs,
    initialRFQs,
    submittedQuotations,
    outstandingQuotations,
    unapprovedPOs,
    totalPOs,
  };
};

const getVendorStats = async (vendorCode) => {
  const [pendingRFQs, totalRFQs, totalQuotations, initialQuotations, totalPOs] =
    await Promise.all([
      rfqModel.countDocuments({
        status: 1,
        vendors: {
          $elemMatch: {
            vendorCode,
            status: 0,
          },
        },
      }),
      rfqModel.countDocuments({
        vendors: {
          $elemMatch: {
            vendorCode,
            status: 0,
          },
        },
      }),
      quotationModel.countDocuments({ vendorCode, status: { $gte: 1 } }),
      quotationModel.countDocuments({ status: 0, vendorCode }),
      poModel.countDocuments({ vendorCode, ...authorizedPOQuery }),
    ]);

  return {
    pendingRFQs,
    totalRFQs,
    totalQuotations,
    initialQuotations,
    totalPOs,
  };
};

const getMonthyTrend = async (vendorCode, companyFilter = {}) => {
  const monthsCount = 6;

  const getPipeline = (matchQuery = [], vendorField) => [
    {
      $match: {
        ...(vendorCode ? { [vendorField || "vendorCode"]: vendorCode } : companyFilter),
        $expr: {
          $gte: [
            "$createdAt",
            {
              $dateSubtract: {
                startDate: "$$NOW",
                unit: "month",
                amount: monthsCount,
              },
            },
          ],
        },
      },
    },
    ...matchQuery,
    {
      $group: {
        _id: {
          $dateTrunc: {
            date: "$createdAt",
            unit: "month",
          },
        },
        count: { $sum: 1 },
      },
    },
    {
      $sort: { _id: 1 },
    },
  ];

  const [rfqTrend, quotationTrend, poTrend] = await Promise.all([
    rfqModel.aggregate(getPipeline([], "vendors.vendorCode")),
    quotationModel.aggregate(getPipeline()),
    poModel.aggregate(getPipeline([{ $match: authorizedPOQuery }])),
  ]);

  const months = getMonths(monthsCount);
  const rfqMap = toMap(rfqTrend);
  const quotationMap = toMap(quotationTrend);
  const poMap = toMap(poTrend);

  return {
    labels: months.map((m) => m.label),
    data: [
      { name: "RFQ", data: months.map((m) => rfqMap[m.key] || 0) },
      { name: "Quotation", data: months.map((m) => quotationMap[m.key] || 0) },
      { name: "PO", data: months.map((m) => poMap[m.key] || 0) },
    ],
  };
};

const getTodayVs30Days = async (vendorCode, companyFilter = {}) => {
  const getPipeline = (isSum = false, matchPipeline = [], vendorKey) => [
    {
      $match: {
        ...(vendorCode ? {} : companyFilter),
      },
    },
    ...matchPipeline,
    ...(vendorCode
      ? [{ $match: { [vendorKey || "vendorCode"]: vendorCode } }]
      : []),
    {
      $facet: {
        today: [
          {
            $match: {
              $expr: {
                $gte: [
                  "$createdAt",
                  { $dateTrunc: { date: "$$NOW", unit: "day" } },
                ],
              },
            },
          },
          isSum
            ? {
                $group: {
                  _id: null,
                  count: { $sum: "$amount.total" },
                },
              }
            : { $count: "count" },
        ],
        last30Days: [
          {
            $match: {
              $expr: {
                $gte: [
                  "$createdAt",
                  {
                    $dateSubtract: {
                      startDate: "$$NOW",
                      unit: "day",
                      amount: 30,
                    },
                  },
                ],
              },
            },
          },
          isSum
            ? {
                $group: {
                  _id: null,
                  count: { $sum: "$amount.total" },
                },
              }
            : { $count: "count" },
        ],
      },
    },
    {
      $project: {
        today: { $ifNull: [{ $arrayElemAt: ["$today.count", 0] }, 0] },
        last30Days: {
          $ifNull: [{ $arrayElemAt: ["$last30Days.count", 0] }, 0],
        },
      },
    },
  ];

  const [[rfq], [quotation], [po], [poTotal]] = await Promise.all([
    rfqModel.aggregate(getPipeline(false, [], "vendors.vendorCode")),
    quotationModel.aggregate(getPipeline()),
    poModel.aggregate(getPipeline(false, [{ $match: authorizedPOQuery }])),
    poModel.aggregate(getPipeline(true, [{ $match: authorizedPOQuery }])),
  ]);

  return {
    rfq,
    quotation,
    po,
    poTotal,
  };
};

const getAmountTrend = async (companyFilter = {}) => {
  return (
    await poModel.aggregate([
      {
        $match: {
          ...companyFilter,
          $expr: {
            $gte: [
              "$createdAt",
              {
                $dateSubtract: {
                  startDate: "$$NOW",
                  unit: "month",
                  amount: 2,
                },
              },
            ],
          },
        },
      },
      {
        $group: {
          _id: {
            $dateTrunc: {
              date: "$createdAt",
              unit: "week",
            },
          },
          total: { $sum: "$amount.total" },
        },
      },
      { $sort: { _id: 1 } },
    ])
  )?.reduce(
    (obj, i) => {
      const d = new Date(i._id);
      const label =
        d.getDate() + " " + d.toLocaleString("en-US", { month: "short" });
      return {
        labels: obj.labels.concat(label),
        data: obj.data.concat(i.total),
      };
    },
    { labels: [], data: [] },
  );
};

const getVendorTablesData = async (vendorCode) => {
  const [enquiriesReceived, enquiriesExpiring, quotations, po] =
    await Promise.all([
      rfqModel.aggregate([
        {
          $match: {
            "vendors.vendorCode": vendorCode,
          },
        },
        {
          $sort: { _id: -1 },
        },
        {
          $limit: 5,
        },
        {
          $set: {
            vendors: {
              $filter: {
                input: "$vendors",
                as: "vendor",
                cond: { $eq: ["$$vendor.vendorCode", vendorCode] },
              },
            },
          },
        },
        {
          $project: {
            rfqNumber: 1,
            rfqDate: 1,
            dueDate: 1,
            vendor: {
              $first: "$vendors.status",
            },
          },
        },
      ]),
      rfqModel.aggregate([
        {
          $match: {
            $expr: {
              $gte: [
                "$validityDate",
                {
                  $dateSubtract: {
                    startDate: "$$NOW",
                    unit: "day",
                    amount: 7,
                  },
                },
              ],
            },
            vendors: {
              $elemMatch: {
                vendorCode,
                status: 0,
              },
            },
          },
        },
        {
          $sort: { validityDate: 1 },
        },
        {
          $limit: 5,
        },
        {
          $project: {
            rfqNumber: 1,
            rfqDate: 1,
            dueDate: 1,
          },
        },
      ]),
      quotationModel.aggregate([
        {
          $match: {
            vendorCode,
            status: { $gt: 0 },
          },
        },
        {
          $sort: { _id: -1 },
        },
        {
          $limit: 5,
        },
        {
          $project: {
            quotationNumber: 1,
            rfqNumber: 1,
            quotationDate: 1,
            itemDescription: "$items.itemDescription",
            totalAmount: "$amount.total",
          },
        },
      ]),
      poModel.aggregate([
        {
          $match: {
            vendorCode,
            ...authorizedPOQuery,
          },
        },
        {
          $sort: { _id: -1 },
        },
        {
          $limit: 5,
        },
        {
          $project: {
            poNumber: 1,
            poDate: 1,
            refDocumentNumber: 1,
            company: 1,
            itemDescription: "$items.itemDescription",
            amount: "$amount.total",
          },
        },
      ]),
    ]);

  return {
    enquiriesReceived,
    enquiriesExpiring,
    quotations,
    po,
  };
};

const getFirmTablesData = async (companyFilter = {}) => {
  const companyMatch = hasCompanyFilter(companyFilter) ? [{ $match: companyFilter }] : [];

  const [indents, rfq, quotations, po] = await Promise.all([
    indentModel.aggregate([
      ...companyMatch,
      {
        $sort: { _id: -1 },
      },
      {
        $limit: 5,
      },
      {
        $project: {
          company: 1,
          indentNumber: 1,
          documentDate: 1,
          itemDescription: 1,
          techSpec: 1,
          indentQty: 1,
          costCenter: 1,
          balanceQty: 1,
        },
      },
    ]),
    rfqModel.aggregate([
      ...companyMatch,
      {
        $sort: { _id: -1 },
      },
      {
        $limit: 5,
      },
      {
        $project: {
          rfqNumber: 1,
          rfqDate: 1,
          itemDescription: "$items.itemDescription",
        },
      },
    ]),
    quotationModel.aggregate([
      ...companyMatch,
      {
        $sort: { _id: -1 },
      },
      {
        $limit: 5,
      },
      {
        $project: {
          quotationNumber: 1,
          rfqNumber: 1,
          quotationDate: 1,
          vendorCode: 1,
        },
      },
    ]),
    poModel.aggregate([
      ...companyMatch,
      {
        $sort: { _id: -1 },
      },
      {
        $limit: 5,
      },
      {
        $project: {
          poNumber: 1,
          poDate: 1,
          company: 1,
          vendorName: 1,
          amount: "$amount.total",
        },
      },
    ]),
  ]);

  return { indents, rfq, quotations, po };
};

appRouter.get("/stats", async (req, res, next) => {
  try {
    const scope = await getRequestUserScope(req);

    const [stats, monthlyTrend, todayVs30Days, amountTrend] = await Promise.all(
      [
        scope.vendorCode
          ? getVendorStats(scope.vendorCode)
          : getStats(scope.userId, scope.companyFilter),

        getMonthyTrend(scope.vendorCode, scope.companyFilter),

        getTodayVs30Days(scope.vendorCode, scope.companyFilter),

        scope.vendorCode ? null : getAmountTrend(scope.companyFilter),
      ],
    );

    res.json({
      stats,
      monthlyTrend,
      todayVs30Days,
      amountTrend,
      scope: {
        isSuperAdmin: scope.isSuperAdmin,
        company: scope.isSuperAdmin ? "ALL" : scope.companyName,
      },
    });
  } catch (error) {
    next(error);
  }
});

appRouter.get("/table-data", async (req, res, next) => {
  try {
    const scope = await getRequestUserScope(req);

    if (scope.vendorCode) {
      return res.json(await getVendorTablesData(scope.vendorCode));
    }

    return res.json(await getFirmTablesData(scope.companyFilter));
  } catch (error) {
    next(error);
  }
});

export default appRouter;

function getMonths(n) {
  const now = new Date();

  const months = Array.from({ length: n }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - (n - 1 - i), 1);
    const label =
      d.toLocaleString("en-US", { month: "short" }) +
      "'" +
      String(d.getFullYear()).slice(-2);
    return { key: d.toISOString().slice(0, 7), label };
  });

  return months;
}

const toMap = (trendArr) =>
  trendArr.reduce((acc, { _id, count }) => {
    const key = _id.toISOString().slice(0, 7);
    acc[key] = count;
    return acc;
  }, {});