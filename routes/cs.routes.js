import express from "express"
import { createError } from "../lib/customError.js"
import { dataTable } from "../helpers/dataTable.js"
import userModel from "../models/user.model.js"
import RFQModel from "../models/rfq.model.js"
import csModel from "../models/cs.model.js"
import { authorizePermissions } from "../middlewares/auth.middleware.js"
import { PERMISSIONS } from "../lib/permissions.js"
import rfqModel from "../models/rfq.model.js"
import quotationModel from "../models/quotation.model.js"
// import { dateAsId } from "../helpers/formatDate.js"
import poModel from "../models/po.model.js"

const csRouter = express.Router()

const updateQuotations = async (data) => {
	const selectedQuotations = data.selection.map((i) => i.quotationNumber)
	const unSelectedQuotations = data.vendors
		.map((i) => i.quotationNumber)
		.filter((i) => !selectedQuotations.includes(i))

	await Promise.all([
		quotationModel.updateMany({ quotationNumber: { $in: selectedQuotations } }, { status: 1.5 }),
		quotationModel.updateMany(
			{
				quotationNumber: {
					$in: unSelectedQuotations
				}
			},
			{ status: 3 }
		)
	])
}

csRouter.get("/generate", async (req, res, next) => {
	try {
		const { rfqNumber } = req.query

		const existingCS = await csModel.findOne({ rfqNumber })
		if (existingCS) {
			await Promise.all(
				csModel.findByIdAndDelete(existingCS._id),
				rfqModel.findOneAndUpdate({ rfqNumber }, { status: 1 }),
				existingCS.vendors.map((i) =>
					quotationModel.findOneAndUpdate({ quotationNumber: i.quotationNumber }, { status: 1 })
				)
			)
		}

		const rfq = await RFQModel.findOne({ rfqNumber }, { rfqDate: 1, items: 1, vendors: 1, dueDate: 1 })
		const quotations = await quotationModel.aggregate([
			{
				$match: {
					status: 1,
					rfqNumber: rfqNumber
				}
			},
			{
				$sort: {
					quotationDate: -1
				}
			},
			{
				$group: {
					_id: "$vendorCode",
					quotations: {
						$first: "$$ROOT"
					}
				}
			},
			{
				$replaceRoot: {
					newRoot: "$quotations"
				}
			}
		])

		if (!quotations?.length) throw createError("No quotations found for this RFQ", 405)

		// const dateId = dateAsId()
		// const randomCombo =
		// 	String.fromCharCode(65 + Math.floor(Math.random() * 26))?.toUpperCase() + Math.floor(Math.random() * 10)
		const csNumber = (await csModel.countDocuments()) + 1

		const csDoc = {
			csNumber: csNumber,
			csDate: new Date(),
			csValidity: new Date(new Date().setHours(7 * 24, 0, 0, 0) - 1),
			csType: "over_all",
			rfqNumber: rfqNumber,
			rfqDate: rfq.rfqDate,
			csRemarks: "",
			authorizedBy: "",
			approvalLevel: "",
			status: "",
			vendors: rfq?.vendors?.map((v) => {
				const q = quotations.find((q) => q.vendorCode === v.vendorCode)
				return {
					name: v.name,
					vendorCode: v.vendorCode,
					vendorLocation: v.location,
					companyCode: q?.companyCode,
					quotationNumber: q?.quotationNumber || "",
					quotationDate: q?.quotationDate || "",
					contactPersonName: v?.contactPerson?.name || "",
					contactEmail: q?.contactEmail || v?.contactPerson?.email || "",
					contactNumber: v?.contactNumber || "",
					remarks: q?.remarks,
					freightType: q?.freightType,
					termsConditions: q?.termsConditions,
					charges: q?.charges,
					total: q
						? {
								basicAfterDiscount: q.amount.basic - q.amount.discount,
								gst: +(q.amount.igst || q.amount.cgst + q.amount.sgst).toFixed(2),
								netAmount: q.amount.total
						  }
						: {}
				}
			}),
			items: rfq.items.map((i) => ({
				indentNumber: i.indentNumber,
				itemCode: i.itemCode,
				itemDescription: i.itemDescription,
				qty: i.rfqQty,
				unit: i.unit,
				vendors: rfq?.vendors?.map((rfqV) => {
					const qItem = quotations
						?.find((q) => q.vendorCode === rfqV.vendorCode)
						?.items.find((_i) => _i.itemCode === i.itemCode && _i.indentNumber === i.indentNumber)

					if (!qItem) return {}
					const disc = +(qItem.discountAmount || 0)?.toFixed(2) || 0
					const dicountedBasic = qItem.amount.basic - disc

					return {
						vendorCode: rfqV.vendorCode,
						lastPoRate: "",
						lastPoNo: "",
						lastPoDate: "",
						lastPoVendor: "",
						make: qItem.make,
						rate: qItem.rate,
						basicAmount: qItem.amount.basic,
						discount: disc,
						basicAfterDiscount: dicountedBasic,
						amount: qItem.amount,
						taxRate: qItem.taxRate,
						taxDetails: qItem.taxDetails,
						rateAfterDiscount: +(dicountedBasic / qItem.qty).toFixed(2)
					}
				})
			}))
		}

		for (const item of csDoc.items) {
			item.leastValues = {
				basicAfterDiscount: {
					value: Number.MAX_SAFE_INTEGER,
					vendorCode: null
				},
				rateAfterDiscount: {
					value: Number.MAX_SAFE_INTEGER,
					vendorCode: null
				}
			}

			for (let i = 0; i < item.vendors.length; i++) {
				const v = item.vendors[i]
				if (v.basicAfterDiscount < item.leastValues.basicAfterDiscount.value) {
					item.leastValues.basicAfterDiscount.value = v.basicAfterDiscount
					item.leastValues.basicAfterDiscount.vendorCode = i + 1
				}
				if (v.rateAfterDiscount < item.leastValues.rateAfterDiscount.value) {
					item.leastValues.rateAfterDiscount.value = v.rateAfterDiscount
					item.leastValues.rateAfterDiscount.vendorCode = i + 1
				}
			}
		}

		csDoc.leastValues = {
			basicAfterDiscount: {
				value: Number.MAX_SAFE_INTEGER,
				vendorCode: null
			},
			netAmount: {
				value: Number.MAX_SAFE_INTEGER,
				vendorCode: null
			}
		}

		for (let i = 0; i < csDoc.vendors.length; i++) {
			const total = csDoc?.vendors[i]?.total

			if (total.basicAfterDiscount < csDoc.leastValues.basicAfterDiscount.value) {
				csDoc.leastValues.basicAfterDiscount.value = total.basicAfterDiscount
				csDoc.leastValues.basicAfterDiscount.vendorCode = i + 1
			}
			if (total.netAmount < csDoc.leastValues.netAmount.value) {
				csDoc.leastValues.netAmount.value = total.netAmount
				csDoc.leastValues.netAmount.vendorCode = i + 1
			}
		}

		res.status(201).json({ ...csDoc, rfqDueDate: rfq?.dueDate })
	} catch (error) {
		next(error)
	}
})

csRouter.get("/quotations", async (req, res, next) => {
	try {
		const data = await csModel.aggregate([
			{
				$match: {
					status: 1,
					"items.poStatus": 0
				}
			},
			{
				$lookup: {
					from: "rfqs",
					localField: "rfqNumber",
					foreignField: "rfqNumber",
					as: "rfq"
				}
			},
			{
				$lookup: {
					from: "quotations",
					let: { qNumbers: { $ifNull: ["$selection.quotationNumber", []] } },
					pipeline: [
						{
							$match: {
								$expr: {
									$in: ["$quotationNumber", "$$qNumbers"]
								}
							}
						}
					],
					as: "quotations"
				}
			},
			{
				$unwind: {
					path: "$items"
				}
			},
			{
				$match: {
					"items.poStatus": 0
				}
			},
			{
				$lookup: {
					from: "indents",
					let: {
						indentNumber: "$items.indentNumber",
						itemCode: "$items.itemCode"
					},
					pipeline: [
						{
							$match: {
								$expr: {
									$and: [
										{ $eq: ["$indentNumber", "$$indentNumber"] },
										{ $eq: ["$itemCode", "$$itemCode"] }
									]
								}
							}
						},
						{
							$project: {
								company: 1
							}
						}
					],
					as: "indents"
				}
			},
			{
				$set: {
					rfq: { $first: "$rfq" },
					"items.company": { $first: "$indents.company" }
				}
			},
			{
				$group: {
					_id: "$_id",
					csNumber: { $first: "$csNumber" },
					csDate: { $first: "$csDate" },
					csValidity: { $first: "$csValidity" },
					csType: { $first: "$csType" },
					rfqNumber: { $first: "$rfqNumber" },
					rfqDate: { $first: "$rfqDate" },
					status: { $first: "$status" },
					vendors: { $first: "$vendors" },
					selection: { $first: "$selection" },
					rfq: { $first: "$rfq" },
					quotations: { $first: "$quotations" },
					items: { $push: "$items" }
				}
			}
		])

		res.status(200).send(data)
	} catch (error) {
		next(error)
	}
})

csRouter.get("/list", async (req, res, next) => {
	try {
		const { vendorCode, indentNumber, itemCode } = req.query

		const selectedMatchQuery = {
			$or: [
				{
					csType: "item_wise",
					selection: {
						$elemMatch: {
							vendorCode,
							indentNumber,
							itemCode
						}
					}
				},
				{
					csType: "over_all",
					"selection.vendorCode": vendorCode
				}
			]
		}

		const pipeline = [
			{
				$match: {
					...selectedMatchQuery,
					items: {
						$elemMatch: {
							itemCode,
							indentNumber,
							poStatus: { $ne: 1 }
						}
					}
				}
			},
			{
				$project: {
					csNumber: 1,
					csDate: 1,
					rfqNumber: 1,
					rfqDate: 1,
					vendors: {
						$filter: {
							input: "$vendors",
							as: "vendor",
							cond: { $eq: ["$$vendor.vendorCode", vendorCode] }
						}
					},
					items: {
						$filter: {
							input: "$items",
							as: "item",
							cond: {
								$and: [
									{ $ne: ["$$item.poStatus", 1] },
									{ $eq: ["$$item.indentNumber", indentNumber] },
									{ $eq: ["$$item.itemCode", itemCode] }
								]
							}
						}
					},
					selection: {
						$filter: {
							input: "$selection",
							as: "selection",
							cond: {
								$eq: ["$$selection.vendorCode", vendorCode]
							}
						}
					}
				}
			},
			{
				$set: {
					vendors: {
						$first: "$vendors"
					},
					items: {
						$first: "$items"
					}
				}
			},
			{
				$set: {
					"items.totalPOQty": {
						$sum: "$items.vendors.poQty"
					},
					"items.vendors": {
						$filter: {
							input: "$items.vendors",
							as: "vendor",
							cond: { $eq: ["$$vendor.vendorCode", vendorCode] }
						}
					}
				}
			},
			{
				$set: {
					"items.vendors": {
						$first: "$items.vendors"
					}
				}
			}
		]
		const data = await csModel.aggregate(pipeline)

		res.status(200).send(
			data?.map(({ selection, ...i }) => ({
				...i,
				items: {
					...i.items,
					qty: (selection[0].qty || i.items.qty) - i.items.totalPOQty
				}
			}))
		)
	} catch (error) {
		next(error)
	}
})

csRouter.post("/list", async (req, res, next) => {
	try {
		const { query, filters, ...params } = req.body
		const matchQuery = []
		if (filters) {
			const filter = {}
			if (filters.status === "initial") filter.status = 0
			if (filters.status === "authorized") filter.status = 1

			if (filters.csNumber) filter.csNumber = filters.csNumber.trim()
			if (filters.csDate?.[0]) {
				filter.csDate = {}
				if (filters.csDate[0])
					filter.csDate["$gte"] = new Date(new Date(filters.csDate[0]).setHours(0, 0, 0, 0))
				if (filters.csDate[1])
					filter.csDate["$lte"] = new Date(new Date(filters.csDate[1]).setHours(24, 0, 0, 0) - 1)
			}
			if (filters.rfqNumber) filter.rfqNumber = filters.rfqNumber.trim()
			if (filters.vendorCode) filter["selection.vendorCode"] = filters.vendorCode.trim()
			if (filters.indentNumber) filter["items.indentNumber"] = filters.indentNumber.trim()
			if (filters.itemCode) filter["items.itemCode"] = filters.itemCode.trim()
			if (filters.itemDescription) filter["items.itemDescription"] = filters.itemDescription.trim()

			if (Object.keys(filter).length) matchQuery.push({ $match: filter })
		}

		const response = await dataTable({ ...params, matchQuery }, csModel, [
			{
				$lookup: {
					from: "users",
					foreignField: "_id",
					localField: "authorizedBy",
					as: "authorizedBy"
				}
			},
			{
				$set: {
					authorizedBy: {
						$first: "$authorizedBy.name"
					}
				}
			}
		])

		res.status(200).send(response)
	} catch (error) {
		next(error)
	}
})

csRouter.get("/", async (req, res, next) => {
	try {
		const { csNumber } = req.query
		const cs = (await csModel.findOne({ csNumber }))?.toJSON()
		const rfq = await rfqModel.findOne({ rfqNumber: cs?.rfqNumber }, { dueDate: 1 })

		res.status(200).json({ ...cs, rfqDueDate: rfq?.dueDate })
	} catch (error) {
		next(error)
	}
})

csRouter.put("/", authorizePermissions(PERMISSIONS.MANAGE_CS), async (req, res, next) => {
	try {
		const data = req.body

		if (data.status === 1) {
			if (!req.user.permissions.includes(PERMISSIONS.AUTHORIZE_CS))
				throw createError("You are not authorized to authorize CS", 403)
			data.authorizedBy = req.user._id
			data.authorizedAt = new Date()
		} else if (!req.user.permissions.includes(PERMISSIONS.MANAGE_CS))
			throw createError("You are not authorized to manage CS", 403)

		const updatedCS = await csModel.findOneAndUpdate(
			{ csNumber: data.csNumber },
			{ $set: data },
			{ new: true, runValidators: true }
		)

		if (!updatedCS) return res.status(404).json({ success: false, message: "CS not found" })

		if (updatedCS?.status === 1) await updateQuotations(updatedCS)

		res.status(200).json({ success: true })
	} catch (error) {
		next(error)
	}
})

csRouter.post("/create", authorizePermissions(PERMISSIONS.MANAGE_CS), async (req, res, next) => {
	try {
		const data = req.body

		if (data.status === 1) {
			if (!req.user.permissions.includes(PERMISSIONS.AUTHORIZE_CS))
				throw createError("You are not authorized to authorize CS", 403)
			data.authorizedBy = req.user._id
			data.authorizedAt = new Date()
		} else if (!req.user.permissions.includes(PERMISSIONS.MANAGE_CS))
			throw createError("You are not authorized to manage CS", 403)
		else {
			delete data.authorizedBy
			delete data.authorizedAt
		}

		await csModel.findOneAndDelete({ rfqNumber: data.rfqNumber })

		if (data?.status === 1) await updateQuotations(data)

		const response = await csModel.create(data)
		res.status(200).send(response)
	} catch (error) {
		next(error)
	}
})

csRouter.post("/list", async (req, res, next) => {
	try {
		const { query, ...params } = req.body
		const response = await dataTable(params, quotationModel, [])
		res.status(200).send(response)
	} catch (error) {
		next(error)
	}
})

csRouter.get("/values", async (req, res, next) => {
	try {
		const { all } = req.query
		let matchQuery = { status: 1 }
		if (!all) {
			const userClinics = (await userModel.findById(req.user._id, { clinics: 1 }))?.clinics
			matchQuery._id = { $in: userClinics }
		}

		const clinics = await quotationModel.aggregate([
			{
				$match: matchQuery
			},
			{
				$project: {
					value: "$_id",
					label: "$name"
				}
			}
		])
		res.status(200).json(clinics)
	} catch (error) {
		next(error)
	}
})

csRouter.get("/items/:id", async (req, res, next) => {
	try {
		const rfq = await quotationModel.findById(req.params.id, { items: 1 })
		if (!rfq) throw createError("Quotation not found", 404)
		res.status(200).json(rfq.items)
	} catch (error) {
		next(error)
	}
})

csRouter.get("/attachments/:id", async (req, res, next) => {
	try {
		const rfq = await quotationModel.findById(req.params.id, { attachments: 1 })
		if (!rfq) throw createError("Quotation not found", 404)
		res.status(200).json(rfq.attachments)
	} catch (error) {
		next(error)
	}
})

csRouter.get("/:quotationId", async (req, res, next) => {
	try {
		const { quotationId } = req.params
		const rfq = await quotationModel.findById(quotationId)
		if (!rfq) throw createError("Quotation not found", 404)
		res.status(200).json(rfq)
	} catch (error) {
		next(error)
	}
})

csRouter.delete("/:csId", authorizePermissions(PERMISSIONS.MANAGE_CS), async (req, res, next) => {
	try {
		const { csId } = req.params
		const cs = await csModel.findById(csId)
		if (!cs) throw createError("CS not found", 404)

		const po = await poModel.countDocuments({
			$or: [{ refCSNumber: cs.csNumber }, { "items.csNumber": cs.csNumber }]
		})

		if (po) throw createError("CS can not be deleted as a PO has been generated for this CS.", 403)

		const data = await csModel.findByIdAndDelete(cs._id)

		await quotationModel.updateMany(
			{ quotationNumber: { $in: data.vendors.map((i) => i.quotationNumber) } },
			{ status: 1 }
		)

		res.status(200).json({ success: true })
	} catch (error) {
		next(error)
	}
})

export default csRouter
