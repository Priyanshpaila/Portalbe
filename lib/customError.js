class CustomError extends Error {
	constructor(customMessage, statusCode = 500) {
		super(customMessage);
		this.name = "CustomError";
		this.statusCode = statusCode;
		Error.captureStackTrace(this, this.constructor);
	}
}

export function createError(customMessage, statusCode) {
	return new CustomError(customMessage, statusCode);
}

export function errorHandler(error, req, res, next) {
	let status = 500;
	let message = "Something broke";

	if (error instanceof CustomError) {
		status = error.statusCode;
		message = error.message;
	}

	console.error(`[${req.method}] ${req.originalUrl}`);
	console.error(error.stack || error);

	res.status(status).json({ message });
}
