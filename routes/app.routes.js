import express from "express"
import rfqModel from "../models/rfq.model.js"
import quotationModel from "../models/quotation.model.js"
import indentModel from "../models/indent.model.js"
import poModel from "../models/po.model.js"

const appRouter = express.Router()

const authorizedPOQuery = {
	$expr: {
		$eq: [
			{ $size: "$authorize" },
			{
				$size: {
					$filter: {
						input: "$authorize",
						as: "auth",
						cond: { $eq: ["$$auth.approvalStatus", 1] }
					}
				}
			}
		]
	}
}

const getStats = async () => {
	const expiringIndents = 0

	const [
		pendingIndents,
		pendingRFQs,
		initialRFQs,
		submittedQuotations,
		outstandingQuotations,
		unapprovedPOs,
		totalPOs
	] = await Promise.all([
		indentModel.countDocuments({ $expr: { $eq: ["$balanceQty", "$indentQty"] } }),
		rfqModel.countDocuments({ status: 1 }),
		rfqModel.countDocuments({ status: 0 }),
		quotationModel.countDocuments({ status: { $gte: 1 } }),
		(async () => {
			return (await rfqModel.find({ status: 1 }, { vendors: 1 }))?.reduce(
				(sum, i) => sum + i.vendors.filter((v) => v.status === 0).length,
				0
			)
		})(),
		poModel.countDocuments({ authorized: { $not: { $elemMatch: { status: 1 } } } }),
		poModel.countDocuments({})
	])

	return {
		expiringIndents,
		pendingIndents,
		pendingRFQs,
		initialRFQs,
		submittedQuotations,
		outstandingQuotations,
		unapprovedPOs,
		totalPOs
	}
}

const getVendorStats = async (vendorCode) => {
	const [pendingRFQs, totalRFQs, totalQuotations, initialQuotations, totalPOs] = await Promise.all([
		rfqModel.countDocuments({
			status: 1,
			vendors: {
				$elemMatch: {
					vendorCode,
					status: 0
				}
			}
		}),
		rfqModel.countDocuments({
			vendors: {
				$elemMatch: {
					vendorCode,
					status: 0
				}
			}
		}),
		quotationModel.countDocuments({ vendorCode, status: { $gte: 1 } }),
		quotationModel.countDocuments({ status: 0, vendorCode }),
		poModel.countDocuments({ vendorCode, ...authorizedPOQuery })
	])

	return {
		pendingRFQs,
		totalRFQs,
		totalQuotations,
		initialQuotations,
		totalPOs
	}
}

const getMonthyTrend = async (vendorCode) => {
	const monthsCount = 6

	const getPipeline = (matchQuery = [], vendorField) => [
		{
			$match: {
				...(vendorCode ? { [vendorField || "vendorCode"]: vendorCode } : {}),
				$expr: {
					$gte: [
						"$createdAt",
						{
							$dateSubtract: {
								startDate: "$$NOW",
								unit: "month",
								amount: monthsCount
							}
						}
					]
				}
			}
		},
		...matchQuery,
		{
			$group: {
				_id: {
					$dateTrunc: {
						date: "$createdAt",
						unit: "month"
					}
				},
				count: { $sum: 1 }
			}
		},
		{
			$sort: { _id: 1 }
		}
	]

	const [rfqTrend, quotationTrend, poTrend] = await Promise.all([
		rfqModel.aggregate(getPipeline([], "vendors.vendorCode")),
		quotationModel.aggregate(getPipeline()),
		poModel.aggregate(getPipeline([{ $match: authorizedPOQuery }]))
	])

	const months = getMonths(monthsCount)
	const rfqMap = toMap(rfqTrend)
	const quotationMap = toMap(quotationTrend)
	const poMap = toMap(poTrend)

	return {
		labels: months.map((m) => m.label),
		data: [
			{ name: "RFQ", data: months.map((m) => rfqMap[m.key] || 0) },
			{ name: "Quotation", data: months.map((m) => quotationMap[m.key] || 0) },
			{ name: "PO", data: months.map((m) => poMap[m.key] || 0) }
		]
	}
}

const getTodayVs30Days = async (vendorCode) => {
	const getPipeline = (isSum = false, matchPipeline = [], vendorKey) => [
		...matchPipeline,
		...(vendorCode ? [{ $match: { [vendorKey || "vendorCode"]: vendorCode } }] : []),
		{
			$facet: {
				today: [
					{
						$match: {
							$expr: {
								$gte: ["$createdAt", { $dateTrunc: { date: "$$NOW", unit: "day" } }]
							}
						}
					},
					isSum
						? {
								$group: {
									_id: null,
									count: { $sum: "$amount.total" }
								}
						  }
						: { $count: "count" }
				],
				last30Days: [
					{
						$match: {
							$expr: {
								$gte: ["$createdAt", { $dateSubtract: { startDate: "$$NOW", unit: "day", amount: 30 } }]
							}
						}
					},
					isSum
						? {
								$group: {
									_id: null,
									count: { $sum: "$amount.total" }
								}
						  }
						: { $count: "count" }
				]
			}
		},
		{
			$project: {
				today: { $ifNull: [{ $arrayElemAt: ["$today.count", 0] }, 0] },
				last30Days: { $ifNull: [{ $arrayElemAt: ["$last30Days.count", 0] }, 0] }
			}
		}
	]

	const [[rfq], [quotation], [po], [poTotal]] = await Promise.all([
		rfqModel.aggregate(getPipeline(false, [], "vendors.vendorCode")),
		quotationModel.aggregate(getPipeline()),
		poModel.aggregate(getPipeline(false, [{ $match: authorizedPOQuery }])),
		poModel.aggregate(getPipeline(true, [{ $match: authorizedPOQuery }]))
	])

	return {
		rfq,
		quotation,
		po,
		poTotal
	}
}

const getAmountTrend = async () => {
	return (
		await poModel.aggregate([
			{
				$match: {
					$expr: {
						$gte: [
							"$createdAt",
							{
								$dateSubtract: {
									startDate: "$$NOW",
									unit: "month",
									amount: 2
								}
							}
						]
					}
				}
			},
			{
				$group: {
					_id: {
						$dateTrunc: {
							date: "$createdAt",
							unit: "week"
						}
					},
					total: { $sum: "$amount.total" }
				}
			},
			{ $sort: { _id: 1 } }
		])
	)?.reduce(
		(obj, i) => {
			const d = new Date(i._id)
			const label = d.getDate() + " " + d.toLocaleString("en-US", { month: "short" })
			return {
				labels: obj.labels.concat(label),
				data: obj.data.concat(i.total)
			}
		},
		{ labels: [], data: [] }
	)
}

const getVendorTablesData = async (vendorCode) => {
	const [enquiriesReceived, enquiriesExpiring, quotations, po] = await Promise.all([
		rfqModel.aggregate([
			{
				$match: {
					"vendors.vendorCode": vendorCode
				}
			},
			{
				$sort: { _id: -1 }
			},
			{
				$limit: 5
			},
			{
				$set: {
					vendors: {
						$filter: {
							input: "$vendors",
							as: "vendor",
							cond: { $eq: ["$$vendor.vendorCode", vendorCode] }
						}
					}
				}
			},
			{
				$project: {
					rfqNumber: 1,
					rfqDate: 1,
					dueDate: 1,
					vendor: {
						$first: "$vendors.status"
					}
				}
			}
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
									amount: 7
								}
							}
						]
					},
					vendors: {
						$elemMatch: {
							vendorCode,
							status: 0
						}
					}
				}
			},
			{
				$sort: { validtyDate: 1 }
			},
			{
				$limit: 5
			},
			{
				$project: {
					rfqNumber: 1,
					rfqDate: 1,
					dueDate: 1
				}
			}
		]),
		quotationModel.aggregate([
			{
				$match: {
					vendorCode,
					status: { $gt: 0 }
				}
			},
			{
				$sort: { _id: -1 }
			},
			{
				$limit: 5
			},
			{
				$project: {
					quotationNumber: 1,
					rfqNumber: 1,
					quotationDate: 1,
					itemDescription: "$items.itemDescription",
					totalAmount: "$amount.total"
				}
			}
		]),
		poModel.aggregate([
			{
				$match: {
					vendorCode,
					...authorizedPOQuery
				}
			},
			{
				$sort: { _id: -1 }
			},
			{
				$limit: 5
			},
			{
				$project: {
					poNumber: 1,
					poDate: 1,
					refDocumentNumber: 1,
					company: 1,
					itemDescription: "$items.itemDescription",
					amount: "$amount.total"
				}
			}
		])
	])

	return {
		enquiriesReceived,
		enquiriesExpiring,
		quotations,
		po
	}
}

appRouter.get("/stats", async (req, res, next) => {
	try {
		const vendorCode = req.user.vendorCode
		const [stats, monthlyTrend, todayVs30Days, amountTrend] = await Promise.all([
			vendorCode ? getVendorStats(vendorCode) : getStats(),
			getMonthyTrend(vendorCode),
			getTodayVs30Days(vendorCode),
			vendorCode ? null : getAmountTrend()
		])
		res.json({
			stats,
			monthlyTrend,
			todayVs30Days,
			amountTrend
		})
	} catch (error) {
		next(error)
	}
})

appRouter.get("/table-data", async (req, res, next) => {
	try {
		const vendorCode = req.user.vendorCode
		if (vendorCode) return res.json(await getVendorTablesData(vendorCode))

		const [indents, rfq, quotations, po] = await Promise.all([
			indentModel.aggregate([
				{
					$sort: { _id: -1 }
				},
				{
					$limit: 5
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
						balanceQty: 1
					}
				}
			]),
			rfqModel.aggregate([
				{
					$sort: { _id: -1 }
				},
				{
					$limit: 5
				},
				{
					$project: {
						rfqNumber: 1,
						rfqDate: 1,
						itemDescription: "$items.itemDescription"
					}
				}
			]),
			quotationModel.aggregate([
				{
					$sort: { _id: -1 }
				},
				{
					$limit: 5
				},
				{
					$project: {
						quotationNumber: 1,
						rfqNumber: 1,
						quotationDate: 1,
						vendorCode: 1
					}
				}
			]),
			poModel.aggregate([
				{
					$sort: { _id: -1 }
				},
				{
					$limit: 5
				},
				{
					$project: {
						poNumber: 1,
						poDate: 1,
						company: 1,
						vendorName: 1,
						amount: "$amount.total"
					}
				}
			])
		])

		res.json({ indents, rfq, quotations, po })
	} catch (error) {
		next(error)
	}
})

export default appRouter

function getMonths(n) {
	const now = new Date()

	const months = Array.from({ length: n }, (_, i) => {
		const d = new Date(now.getFullYear(), now.getMonth() - (n - 1 - i), 1)
		const label = d.toLocaleString("en-US", { month: "short" }) + "'" + String(d.getFullYear()).slice(-2)
		return { key: d.toISOString().slice(0, 7), label }
	})

	return months
}

const toMap = (trendArr) =>
	trendArr.reduce((acc, { _id, count }) => {
		const key = _id.toISOString().slice(0, 7)
		acc[key] = count
		return acc
	}, {})
