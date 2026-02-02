import express from "express"
import quotationModel from "../models/quotation.model.js"
import { createError } from "../lib/customError.js"
import { dataTable } from "../helpers/dataTable.js"
import userModel from "../models/user.model.js"
import { Types } from "mongoose"
import upload from "../middlewares/upload.middleware.js"
import { authorizePermissions, authorizeTokens } from "../middlewares/auth.middleware.js"
import { PERMISSIONS } from "../lib/permissions.js"
import csModel from "../models/cs.model.js"
import poModel from "../models/po.model.js"
import fs from "fs/promises"
import negotiationModel from "../models/negotiation.model.js"
import rfqModel from "../models/rfq.model.js"

const isPoGenerated = async (params) => {
	const quotation = typeof params === "string" ? await quotationModel.findById(params) : params
	if (!quotation) throw createError("Quotation not found", 404)

	const cs = await csModel.findOne(
		{
			$and: [{ rfqNumber: quotation.rfqNumber }, { "selection.quotationNumber": quotation.quotationNumber }]
		},
		{ csNumber: 1 }
	)

	const po = await poModel.findOne(
		cs?.csNumber
			? {
					$or: [{ refDocumentNumber: quotation.quotationNumber }, { "items.csNumber": cs?.csNumber }]
			  }
			: { refDocumentNumber: quotation.quotationNumber },
		{ poNumber: 1 }
	)

	return po?.poNumber
}

const quotationRouter = express.Router()

quotationRouter.post(
	"/",
	authorizePermissions(PERMISSIONS.VENDOR_ACCESS),
	(req, res, next) => {
		req.params.id = new Types.ObjectId().toString()
		next()
	},
	upload.array("file"),
	async (req, res, next) => {
		try {
			const data = JSON.parse(req.body.data)
			if (await quotationModel.findOne({ quotationNumber: data.quotationNumber }))
				throw createError("Quotation number already used.", 400)

			await quotationModel.create({
				...data,
				_id: req.params.id,
				createdBy: req.user?._id
			})

			if (data.status === 1)
				await rfqModel.findOneAndUpdate(
					{ rfqNumber: data.rfqNumber },
					{ $set: { "vendors.$[vendor].status": data.status } },
					{ arrayFilters: [{ "vendor.vendorCode": data.vendorCode }] }
				)

			res.status(201).json({ success: true })
		} catch (error) {
			next(error)
		}
	}
)

quotationRouter.put(
	"/:id",
	authorizePermissions(PERMISSIONS.VENDOR_ACCESS),
	upload.array("file"),
	async (req, res, next) => {
		try {
			const poNumber = await isPoGenerated(req.params.id)
			if (poNumber)
				throw createError(`Cannot delete! Order '${poNumber}' has been generated from this quotation.`, 400)

			const updatedData = JSON.parse(req.body.data)

			if (
				await quotationModel.findOne({
					quotationNumber: updatedData.quotationNumber,
					_id: { $ne: req.params.id }
				})
			)
				throw createError("Quotation number already used.", 400)

			// if (files && files.length > 0) {
			// 	updatedData.attachments = [...(updatedData.attachments || []), ...files]
			// }

			const updatedQuotation = await quotationModel.findByIdAndUpdate(
				req.params.id,
				{ $set: updatedData },
				{ new: true, runValidators: true }
			)

			if (!updatedQuotation) {
				return res.status(404).json({ success: false, message: "Quotation not found" })
			}

			if (updatedQuotation.status === 1)
				await rfqModel.findOneAndUpdate(
					{ rfqNumber: updatedQuotation.rfqNumber },
					{ $set: { "vendors.$[vendor].status": updatedQuotation.status } },
					{ arrayFilters: [{ "vendor.vendorCode": updatedQuotation.vendorCode }] }
				)

			res.status(200).json({ success: true, data: updatedQuotation })
		} catch (error) {
			next(error)
		}
	}
)

quotationRouter.post("/list", async (req, res, next) => {
	try {
		const { query, filters, ...params } = req.body
		const matchQuery = []

		let pipeline = [
			{
				$lookup: {
					from: "vendors",
					localField: "vendorCode",
					foreignField: "vendorCode",
					as: "vendorName"
				}
			},
			{
				$set: {
					vendorName: {
						$first: "$vendorName.name"
					}
				}
			}
		]

		if (req.user.vendorCode)
			matchQuery.push({
				$match: {
					vendorCode: req.user.vendorCode
				}
			})
		else
			matchQuery.push({
				$match: {
					status: {
						$gt: 0
					}
				}
			})

		if (filters) {
			const filter = {}
			if (req.user.vendorCode) {
				if (filters.status === "initial") filter.status = 0
				if (filters.status === "authorized") filter.status = 1
			} else if (filters.vendorCode) filter.vendorCode = filters.vendorCode

			if (filters.quotationNumber) filter.quotationNumber = filters.quotationNumber
			if (filters.quotationDate?.[0]) {
				filter.quotationDate = {}
				if (filters.quotationDate[0])
					filter.quotationDate["$gte"] = new Date(new Date(filters.quotationDate[0]).setHours(0, 0, 0, 0))
				if (filters.quotationDate[1])
					filter.quotationDate["$lte"] = new Date(
						new Date(filters.quotationDate[1]).setHours(24, 0, 0, 0) - 1
					)
			}
			if (filters.rfqNumber) filter.rfqNumber = filters.rfqNumber
			if (filters.rfqDate?.[0]) {
				filter.rfqDate = {}
				if (filters.rfqDate[0])
					filter.rfqDate["$gte"] = new Date(new Date(filters.rfqDate[0]).setHours(0, 0, 0, 0))
				if (filters.rfqDate[1])
					filter.rfqDate["$lte"] = new Date(new Date(filters.rfqDate[1]).setHours(24, 0, 0, 0) - 1)
			}
			if (filters.indentNumber) filter["items.indentNumber"] = filters.indentNumber.trim()
			if (filters.itemCode) filter["items.itemCode"] = filters.itemCode.trim()
			if (filters.itemDescription) filter["items.itemDescription"] = filters.itemDescription.trim()

			if (Object.keys(filter).length) matchQuery.push({ $match: filter })
		}

		const response = await dataTable({ ...params, matchQuery }, quotationModel, pipeline)
		res.status(200).send(response)
	} catch (error) {
		next(error)
	}
})

quotationRouter.get("/values", async (req, res, next) => {
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

quotationRouter.get("/items/:id", async (req, res, next) => {
	try {
		const quotation = req.query.appendRFQDetails
			? (
					await quotationModel.aggregate([
						{
							$match: {
								_id: new Types.ObjectId(req.params.id)
							}
						},
						{
							$unwind: "$items"
						},
						{
							$lookup: {
								from: "indents",
								let: { itemCodeVar: "$items.itemCode", indentNumberVar: "$items.indentNumber" },
								pipeline: [
									{
										$match: {
											$expr: {
												$and: [
													{ $eq: ["$itemCode", "$$itemCodeVar"] },
													{ $eq: ["$indentNumber", "$$indentNumberVar"] }
												]
											}
										}
									},
									{
										$project: {
											itemDescription: 1,
											unitOfMeasure: 1
										}
									}
								],
								as: "indent"
							}
						},
						{
							$set: {
								"items.itemDescription": {
									$first: "$indent.itemDescription"
								},
								"items.unit": {
									$first: "$indent.unitOfMeasure"
								}
							}
						},
						{
							$group: {
								_id: "$_id",
								items: { $push: "$items" }
							}
						}
					])
			  )?.[0]
			: await quotationModel.findById(req.params.id, { items: 1 })
		if (!quotation) throw createError("Quotation not found", 404)

		res.status(200).json(quotation.items)
	} catch (error) {
		next(error)
	}
})

quotationRouter.get("/attachments/:id", async (req, res, next) => {
	try {
		const rfq = await quotationModel.findById(req.params.id, { attachments: 1 })
		if (!rfq) throw createError("Quotation not found", 404)
		res.status(200).json(rfq.attachments)
	} catch (error) {
		next(error)
	}
})

quotationRouter.get("/rfq/:rfqNumber", async (req, res, next) => {
	try {
		const { rfqNumber } = req.params
		const rfqs = await quotationModel.findById(rfqNumber)
		if (!rfqs) throw createError("No quotation found", 404)
		res.status(200).json(rfqs)
	} catch (error) {
		next(error)
	}
})

quotationRouter.get("/", async (req, res, next) => {
	try {
		const { quotationNumber, fetchNegotiation } = req.query
		const quotation = (await quotationModel.findOne({ quotationNumber }))?.toJSON()
		const negotiation = fetchNegotiation ? await negotiationModel.findOne({ quotationNumber }) : null
		if (!quotation) throw createError("Quotation not found", 404)

		const poNumber = await isPoGenerated(quotation)

		res.status(200).json({ ...quotation, poNumber, negotiation })
	} catch (error) {
		next(error)
	}
})

quotationRouter.delete(
	"/:id",
	authorizeTokens,
	authorizePermissions(PERMISSIONS.VENDOR_ACCESS),
	async (req, res, next) => {
		try {
			const quotationVendor = await quotationModel.findById(req.params.id, {
				vendorCode: 1,
				status: 1,
				rfqNumber: 1,
				vendorCode: 1
			})
			if (!quotationVendor) throw createError(`Quotation not found, invalid quotation id.`, 404)
			if (quotationVendor.vendorCode !== req.user.vendorCode)
				throw createError("User is not authorized for this action.", 400)

			const poNumber = await isPoGenerated(req.params.id)
			if (poNumber)
				throw createError(`Cannot delete! Order '${poNumber}' has been generated from this quotation.`, 400)

			await quotationModel.findByIdAndDelete(req.params.id)

			if (quotationVendor.status === 1)
				await rfqModel.findOneAndUpdate(
					{ rfqNumber: quotationVendor.rfqNumber },
					{ $set: { "vendors.$[vendor].status": 0 } },
					{ arrayFilters: [{ "vendor.vendorCode": quotationVendor.vendorCode }] }
				)

			await fs.rm("uploads/" + req.params.id, { recursive: true, force: true })
			res.status(200).send({ success: true })
		} catch (error) {
			next(error)
		}
	}
)

export default quotationRouter
