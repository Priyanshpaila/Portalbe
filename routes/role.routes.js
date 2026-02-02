import express from "express"
import Role from "../models/role.model.js"
import User from "../models/user.model.js"
import { createError } from "../lib/customError.js"
import { PERMISSIONS } from "../lib/permissions.js"
import { authorizeTokens as auth } from "../middlewares/auth.middleware.js"

const roleRouter = express.Router()

// GET all roles + permissions list
roleRouter.get("/", auth, async (req, res, next) => {
	try {
		const roles = await Role.find({ status: 1, hidden: { $ne: true } }).populate("createdBy", "name")
		res.status(200).json({
			roles,
			data: {
				permissions: Object.keys(PERMISSIONS)
			}
		})
	} catch (error) {
		next(error)
	}
})

// GET single role by id
roleRouter.get("/:id", auth, async (req, res, next) => {
	try {
		const role = await Role.findById(req.params.id).populate("createdBy", "name")
		if (!role) throw createError("Role not found", 404)
		res.status(200).json(role)
	} catch (error) {
		next(error)
	}
})

// DELETE role by id (only if no users attached)
roleRouter.delete("/:id", auth, async (req, res, next) => {
	try {
		const usersCount = await User.countDocuments({ role: req.params.id })
		if (usersCount > 0)
			throw createError(
				`Delete action prevented. ${usersCount} user${usersCount > 1 ? "s are" : " is"} assigned this role.`,
				405
			)
		const deleted = await Role.findByIdAndDelete(req.params.id)
		if (!deleted) throw createError("Role not found", 404)
		res.status(200).json({ success: true })
	} catch (error) {
		next(error)
	}
})

// CREATE or UPDATE role
roleRouter.post("/", auth, async (req, res, next) => {
	try {
		const { id, name, permissions: _permissions } = req.body
		const permissions = _permissions.filter((i) => i !== PERMISSIONS.VENDOR_ACCESS)

		let message = null
		let role

		if (id) {
			role = await Role.findByIdAndUpdate(id, { name, permissions }, { new: true })
			if (!role) throw createError("Role not found", 404)
			message = "Role Updated Successfully."
		} else {
			const exists = await Role.findOne({ name })
			if (exists) throw createError("Role with name " + name + " already exists.", 400)
			role = new Role({
				name,
				permissions
				// createdBy: req?.user?._id
			})
			await role.save()
			message = "Role Created Successfully."
		}

		res.json({ message, data: role })
	} catch (error) {
		next(error)
	}
})

roleRouter.put("/:id", async (req, res, next) => {
	try {
		const data = req.body
		const role = await Role.findByIdAndUpdate(req.params.id, data, { new: true })
		if (!role) throw createError("Role not found", 404)
		res.status(200).json(role)
	} catch (error) {
		next(error)
	}
})

export default roleRouter
