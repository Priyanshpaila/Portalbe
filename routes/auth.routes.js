import express from "express"
import jwt from "jsonwebtoken"
import userModel from "../models/user.model.js"
import { createError } from "../lib/customError.js"
import roleModel from "../models/role.model.js"
import { compareAsync } from "../helpers/hash.js"

const authRouter = express.Router()

authRouter.post("/login", async (req, res, next) => {
	const { username, password, id } = req.body

	try {
		const user = id ? (await userModel.findById(id))?.toJSON() : (await userModel.findOne({ username }))?.toJSON()
		if (!user || (!id && !password)) throw createError("Invalid username or password", 401)

		if (password) {
			const isMatch = await compareAsync(password, user.password)
			if (!isMatch) throw createError("Invalid username or password", 401)
		}

		const role = await roleModel.findById(user.role, { permissions: 1, name: 1 })
		if (!role) throw createError("User assigned invalid role", 401)

		const token = jwt.sign(
			{
				userId: user._id,
				vendorCode: user.vendorCode,
				permissions: role.permissions
			},
			process.env.JWT_SECRET,
			{ expiresIn: "12h" }
		)

		delete user._id
		delete user.password

		res.json({
			token,
			user: {
				...user,
				permissions: role.permissions
			},
			role: role.name,
		})
	} catch (error) {
		next(error)
	}
})

export default authRouter
