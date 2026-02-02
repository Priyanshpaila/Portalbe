import express from "express"
import negotiationModel from "../models/negotiation.model.js"
import { createError } from "../lib/customError.js"
import { sendMail } from "../lib/nodemailer.js"
import generateEmailBody from "../helpers/generateEmailBody.js"
import userModel from "../models/user.model.js"

const negotiationRouter = express.Router()

const mailNegotiation = async (negotiation) => {
	const vendorUser = await userModel.findOne({ vendorCode: negotiation.vendorCode })
	await sendMail([
		{
			to: vendorUser.email,
			subject: `Negotiation Request For Quotation - ${negotiation.quotationNumber}`,
			text: generateEmailBody.negotiation(negotiation.quotationNumber, vendorUser._id.toString())
		}
	])
}

negotiationRouter.post("/", async (req, res, next) => {
	try {
		const data = { ...req.body }
		if (data.status === 1) {
			data.submittedBy = req.user._id
			data.submittedAt = Date.now()
			await mailNegotiation(data)
		} else if (data.status === 0) {
			data.savedBy = req.user._id
			data.savedAt = Date.now()
		}

		const doc = await negotiationModel.create(data)
		const user = await userModel.findById(req.user._id, { name: 1 })
		res.status(201).json({
			success: true,
			doc: { ...(doc?._doc || doc), [data.status ? "submittedByUser" : "savedByUser"]: user.name }
		})
	} catch (error) {
		next(error)
	}
})

negotiationRouter.put("/", async (req, res, next) => {
	try {
		const { _id, ...data } = req.body
		const currStatus = await negotiationModel.findById(_id, { status: 1 })
		if (!currStatus) throw createError("Negotiation not found.", 404)

		if (data.status === 1 && currStatus.status !== 1) {
			data.submittedBy = data.createdBy
			data.submittedAt = Date.now()
			await mailNegotiation(data)
		} else if (data.status === 0) {
			data.savedBy = req.user._id
			data.savedAt = Date.now()
		}

		const doc = await negotiationModel.findByIdAndUpdate(_id, data, { new: true })
		const user = await userModel.findById(req.user._id, { name: 1 })

		res.status(201).json({
			success: true,
			doc: { ...(doc?._doc || doc), [data.status ? "submittedByUser" : "savedByUser"]: user.name }
		})
	} catch (error) {
		next(error)
	}
})

negotiationRouter.get("/send", async (req, res, next) => {
	try {
		const { id } = req.query
		if (!id) throw createError("Invalid negotiation", 400)
		const user = await userModel.findById(req.user._id, { name: 1 })
		const negotiation = await negotiationModel.findByIdAndUpdate(
			id,
			{
				status: 1,
				submittedBy: req.user._id,
				submittedAt: Date.now()
			},
			{ new: 1 }
		)
		await mailNegotiation(negotiation)

		res.status(201).json({
			success: true,
			doc: {
				...(negotiation?._doc || negotiation),
				submittedByUser: user.name
			}
		})
	} catch (error) {
		next(error)
	}
})

negotiationRouter.get("/", async (req, res, next) => {
	try {
		const { rfqNumber } = req.query
		const negotiations = await negotiationModel.aggregate([
			{
				$match: {
					rfqNumber
				}
			},
			{
				$lookup: {
					from: "users",
					foreignField: "_id",
					localField: "createdBy",
					as: "createdByUser"
				}
			},
			{
				$lookup: {
					from: "users",
					foreignField: "_id",
					localField: "submittedBy",
					as: "submittedByUser"
				}
			},
			{
				$set: {
					createdByUser: { $first: "$createdByUser.name" },
					submittedByUser: { $first: "$submittedByUser.name" }
				}
			}
		])
		res.status(201).json(negotiations.reduce((obj, i) => ({ ...obj, [i.vendorCode]: i }), {}))
	} catch (error) {
		next(error)
	}
})

export default negotiationRouter
