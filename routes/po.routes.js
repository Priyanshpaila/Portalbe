import express from "express"
import { Types } from "mongoose"
import fs from "fs/promises"

import poModel from "../models/po.model.js"
import upload from "../middlewares/upload.middleware.js"
import { dataTable } from "../helpers/dataTable.js"
import { authorizePermissions, authorizeTokens } from "../middlewares/auth.middleware.js"
import userModel from "../models/user.model.js"
import { PERMISSIONS } from "../lib/permissions.js"
import { createError } from "../lib/customError.js"
import generateEmailBody from "../helpers/generateEmailBody.js"
import { sendMail } from "../lib/nodemailer.js"
import { syncIndentQuantity } from "../helpers/syncIndentQuantity.js"
import { syncCSQuantity } from "../helpers/syncCSQuantity.js"

const poRouter = express.Router()

const mailPO = async (po) => {
	if (!po.readyForAuthorization) return
	const nextLevel = po.authorize.find((i) => i.approvalStatus === 0)
	if (!nextLevel) return

	const user = await userModel.findById(nextLevel.user, { _id: 1, email: 1 })

	await sendMail([
		{
			to: user?.email,
			subject: "PO Authorization Request",
			text: generateEmailBody.po(po.poNumber, po.poDate, nextLevel.user)
		}
	])
}

const syncCSQtyHandler = (po) => syncCSQuantity([po.refCSNumber, ...po.items.map((i) => i.csNumber)].filter(Boolean))

poRouter.post(
	"/",
	(req, res, next) => {
		req.params.id = new Types.ObjectId().toString()
		next()
	},
	upload.array("file"),
	async (req, res, next) => {
		try {
			const data = JSON.parse(req.body.data)

			if (data?.readyForAuthorization) {
				if (!data.authorize?.length) throw createError("At least one authorization level is required.", 400)
				else if (!data.items?.length) throw createError("At least one item is required.", 400)
			}

			await poModel.create({
				...data,
				_id: req.params.id,
				createdBy: req.user?._id
			})

			await syncIndentQuantity({
				indents: data.items.map((i) => ({ indentNumber: i.indentNumber, itemCode: i.itemCode })),
				shouldUpdate: true
			})

			await syncCSQtyHandler(data)

			let errorMessage

			try {
				await mailPO(data)
			} catch (err) {
				errorMessage = "PO created but failed to send email to user"
			}

			res.status(201).json({ success: true, errorMessage })
		} catch (error) {
			next(error)
		}
	}
)

poRouter.put("/:id", upload.array("file"), async (req, res, next) => {
	try {
		const { id } = req.params
		const data = JSON.parse(req.body.data)

		if (data?.readyForAuthorization)
			if (!data.authorize?.length) throw createError("At least one authorization level is required.", 400)
			else if (!data.items?.length) throw createError("At least one item is required.", 400)

		if (data?.readyForAuthorization && data?.authorize?.find((i) => i.approvalStatus === 2)) {
			for (const level of data.authorize) {
				level.approvalStatus = 0
				level.changedOn = undefined
				level.comment = undefined
			}
		} else if (!data?.authorize?.some((i) => i.approvalStatus !== 1)) {
			const po = await poModel.findById(id, { amendNumber: 1 })
			data.amendNumber = (po?.amendNumber || 0) + 1
			data.amendHistory = [
				{
					amendedBy: req.user._id,
					amendedAt: Date.now()
				}
			].concat(data.amendHistory || [])

			for (const level of data.authorize) {
				level.approvalStatus = 0
				level.changedOn = undefined
				level.comment = undefined
			}
		}

		const updated = await poModel.findByIdAndUpdate(id, { ...data, updatedBy: req.user?._id }, { new: true })
		await syncIndentQuantity({
			indents: updated.items.map((i) => ({ indentNumber: i.indentNumber, itemCode: i.itemCode })),
			shouldUpdate: true
		})

		await syncCSQtyHandler(data)

		let errorMessage
		try {
			await mailPO(updated)
		} catch (error) {
			errorMessage = "PO updated but failed to send email to user"
		}
		res.status(200).json({ ...updated, errorMessage })
	} catch (error) {
		next(error)
	}
})

poRouter.get("/poNumber", async (req, res, next) => {
	try {
		const count = await poModel.countDocuments()
		// const dateId = dateAsId()
		// const randomCombo =
		// 	String.fromCharCode(65 + Math.floor(Math.random() * 26))?.toUpperCase() + Math.floor(Math.random() * 10)
		// const poNumber = ["P", dateId, randomCombo].join("/")
		res.status(200).json({ poNumber: count + 1 })
	} catch (error) {
		next(error)
	}
})

poRouter.patch("/authorize", authorizePermissions(PERMISSIONS.AUTHORIZE_PO), async (req, res, next) => {
	try {
		const { id, comment, approvalStatus } = req.body
		
		const po = await poModel.findById(id)

		if (!po) throw createError("Purchase order not found.", 404)
		if (!po.readyForAuthorization) throw createError("Purchase is not ready for authorization.", 400)
		if (!po.authorize?.find((i) => i.user?.toString() === req.user?._id?.toString()))
			throw createError("User is not permitted to authorize this purchase order.", 400)

		if (approvalStatus === 2) po.readyForAuthorization = false
		for (const level of po.authorize) {
			if (level.user?.toString() === req.user?._id?.toString()) {
				level.approvalStatus = approvalStatus
				level.changedOn = new Date()
				level.comment = comment
			}
		}

		const newPo = await poModel.findByIdAndUpdate(id, po, { new: true })
		let errorMessage

		try {
			await mailPO(newPo.toObject())
		} catch (error) {
			errorMessage = "PO authorized but failed to send email to next user."
		}

		res.status(200).json({
			success: true,
			authorize: newPo?.authorize?.find((i) => i.user?.toString() === req.user?._id?.toString()),
			errorMessage: errorMessage
		})
	} catch (error) {
		next(error)
	}
})

poRouter.post("/list", async (req, res, next) => {
	try {
		const { query, filters, ...params } = req.body
		const matchQuery = []
		let pipeline = []

		const onlyAuthorized = {
			$and: [
				{
					$gt: [{ $size: "$authorize" }, 0]
				},
				{
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
			]
		}

		if (req.user.vendorCode) {
			matchQuery.push({
				$match: {
					vendorCode: req.user.vendorCode,
					$expr: onlyAuthorized
				}
			})
		} else {
			pipeline = [
				{ $unwind: { path: "$authorize", preserveNullAndEmptyArrays: true } },
				{
					$lookup: {
						from: "users",
						localField: "authorize.user",
						foreignField: "_id",
						as: "userDetails"
					}
				},
				{
					$set: {
						"authorize.name": { $first: "$userDetails.name" },
						"authorize.digitalSignature": { $first: "$userDetails.digitalSignature" }
					}
				},
				{ $unset: "userDetails" },
				{
					$group: {
						_id: "$_id",
						doc: { $first: "$$ROOT" },
						authorize: { $push: "$authorize" }
					}
				},
				{
					$replaceRoot: {
						newRoot: {
							$mergeObjects: ["$doc", { authorize: "$authorize" }]
						}
					}
				},

				{
					$set: {
						lastAuthorize: {
							$last: {
								$sortArray: {
									input: "$authorize",
									sortBy: { changedOn: 1 }
								}
							}
						}
					}
				},
				{
					$set: {
						authorizedBy: "$lastAuthorize.name",
						authorizedAt: "$lastAuthorize.changedOn",
						status: "$lastAuthorize.approvalStatus"
					}
				},
				{
					$unset: "lastAuthorize"
				}
			]
		}

		if (filters) {
			const filter = {}
			if (!req.user.vendorCode) {
				if (filters.vendorCode) filter.vendorCode = filters.vendorCode
				if (filters.status === "initial")
					filter.authorize = {
						$elemMatch: {
							$or: [{ approvalStatus: 0 }, { approvalStatus: 2 }]
						}
					}
				if (filters.status === "authorized") filter["$expr"] = onlyAuthorized
			}

			if (filters.poNumber) filter.poNumber = filters.poNumber.trim()
			if (filters.sapPONumber) filter.sapPONumber = filters.sapPONumber.trim()
			if (filters.poDate?.[0]) {
				filter.poDate = {}
				if (filters.poDate[0])
					filter.poDate["$gte"] = new Date(new Date(filters.poDate[0]).setHours(0, 0, 0, 0))
				if (filters.poDate[1])
					filter.poDate["$lte"] = new Date(new Date(filters.poDate[1]).setHours(24, 0, 0, 0) - 1)
			}
			if (filters.refDocumentType) filter.refDocumentType = filters.refDocumentType
			if (filters.poAmountFrom || filters.poAmountTo) {
				filter["amount.total"] = {}
				if (filters.poAmountFrom) filter["amount.total"]["$gte"] = +filters.poAmountFrom.trim()
				if (filters.poAmountTo) filter["amount.total"]["$lte"] = +filters.poAmountTo.trim()
			}
			if (filters.indentNumber) filter["items.indentNumber"] = filters.indentNumber.trim()
			if (filters.itemCode) filter["items.itemCode"] = filters.itemCode.trim()
			if (filters.itemDescription) filter["items.itemDescription"] = filters.itemDescription.trim()

			if (Object.keys(filter).length) matchQuery.push({ $match: filter })
		}

		pipeline.push({
			$sort: {
				_id: -1
			}
		})

		const response = await dataTable({ ...params, matchQuery }, poModel, pipeline)
		res.status(200).send(response)
	} catch (error) {
		next(error)
	}
})

poRouter.get("/", async (req, res, next) => {
	try {
		const { id, poNumber, attachAuthUsers } = req.query
		const po = (id?.length === 22 ? await poModel.findById(id) : await poModel.findOne({ poNumber }))?.toJSON()

		if (attachAuthUsers) {
			const users = await userModel.find(
				{ _id: { $in: po.authorize?.map((i) => i.user) } },
				{ name: 1, username: 1 }
			)

			for (const level of po.authorize) {
				level.name = users?.find((i) => i._id?.toString() === level.user?.toString())?.name
				if (req.user._id.toString() === level.user.toString())
					level.username = users?.find((i) => i._id?.toString() === level.user?.toString())?.username
			}
		}

		res.status(200).send(po)
	} catch (error) {
		next(error)
	}
})

poRouter.get("/pending-po-approvals", async (req, res, next) => {
	try {
		const loggedInUserId = new Types.ObjectId(req.user._id?.toString())
		const po = await poModel.aggregate([
			{
				$match: {
					authorize: {
						$elemMatch: {
							user: loggedInUserId,
							approvalStatus: 0
						}
					}
				}
			},
			{
				$addFields: {
					nextApprover: {
						$first: {
							$filter: {
								input: "$authorize",
								as: "auth",
								cond: { $eq: ["$$auth.approvalStatus", 0] }
							}
						}
					}
				}
			},
			{
				$match: {
					"nextApprover.user": loggedInUserId
				}
			},
			{
				$project: {
					poNumber: 1,
					poDate: 1,
					sapPONumber: 1,
					company: 1,
					itemDescription: "$items.itemDescription",
					amount: "$amount.total",
					vendorCode: 1,
					vendorName: 1
				}
			}
		])

		res.status(200).send(po)
	} catch (error) {
		next(error)
	}
})

poRouter.get("/attachments/:id", async (req, res, next) => {
	try {
		const po = await poModel.findById(req.params.id, { attachments: 1 })
		if (!po) throw createError("PO not found", 404)
		res.status(200).json(po.attachments)
	} catch (error) {
		next(error)
	}
})

poRouter.delete("/:id", authorizePermissions(PERMISSIONS.MANAGE_PO), async (req, res, next) => {
	try {
		const { id } = req.params
		const po = await poModel.findById(id)
		if (!po) throw createError("PO not found, invalid PO id.", 404)
		// if (po?.authorize?.length && !po?.authorize?.some((i) => i.approvalStatus !== 1))
		// 	throw createError("Approved PO can not be deleted.", 400)

		await poModel.findByIdAndDelete(id)
		await syncIndentQuantity({
			indents: po.items.map((i) => ({ indentNumber: i.indentNumber, itemCode: i.itemCode })),
			shouldUpdate: true
		})

		await syncCSQtyHandler(po.toObject())

		await fs.rm("uploads/" + id, { recursive: true, force: true })
		res.status(200).send({ success: true })
	} catch (error) {
		next(error)
	}
})

export default poRouter
