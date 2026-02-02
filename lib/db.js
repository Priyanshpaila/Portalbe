import mongoose from "mongoose"
import seedInitialData from "./seedInitialData.js"

export default async function connect() {
	try {
		await mongoose.connect(process.env.MONGO_URI)
		seedInitialData()
		console.log("Connected to database successfully.")
	} catch (error) {
		console.error("Failed to connect DB", error)
	}
}
