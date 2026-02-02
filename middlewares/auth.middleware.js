import jwt from "jsonwebtoken"

export const authorizeTokens = (req, res, next) => {
	try {
		const token = req.header("Authorization")?.split(" ")?.[1]
		if (!token) throw Error("Authorization token is required")
		const JSON = jwt.verify(token, process.env.JWT_SECRET)
		if (!JSON) throw Error("Invalid authorization token")
		req.user = {
			_id: JSON.userId,
			vendorCode: JSON.vendorCode,
			permissions: JSON.permissions
		}
		next()
	} catch (error) {
		return res.status(401).send(error.message)
	}
}

export function authorizePermissions(...allowedpermissions) {
	return (req, res, next) => {
		const isPermitted = allowedpermissions.some((i) => req.user.permissions.includes(i))
		const isValueRoute =
			req.path
				.trim()
				.split("/")
				.filter((i) => i)
				.at(-1) === "values"

		const isAuthRoute = req.path.includes("/reset-password")

		if (!isPermitted && !isValueRoute && !isAuthRoute) {
			return res.status(403).json({ message: "Access denied" })
		}

		next()
	}
}
