import axios from "axios"
import { URLS } from "./constants.js"
import { mapIndent } from "../helpers/mapIndent.js"
import indentModel from "../models/indent.model.js"
import { syncIndentQuantity } from "../helpers/syncIndentQuantity.js"

const fetchIndents = async () => {
	const response = await axios.get(URLS.SAP_INDENTS_URL, {
		auth: {
			username: process.env.SAP_USERNAME,
			password: process.env.SAP_PASSWORD
		},
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json"
		},
		params: {
			"sap-client": "700",
			$filter: `Creationdate ge datetime'${new Date("2025-01-01").toISOString().split(".")[0]}'`
		}
	})

	return mapIndent(response.data?.d?.results)
}

// const IMPORT_INTERVAL_GAP = 60 * 60 * 1000
export const  importIndents = async () => {
	const now = new Date()
	const nowString = now.toUTCString().slice(5)
	// const nextImport = new Date(now.getTime() + IMPORT_INTERVAL_GAP).toUTCString().slice(5)

	try {
		const data = await fetchIndents()
		console.log(`[${nowString}] Importing indents...`)

		const result = await syncIndentQuantity({ data })
		if (result?.error) throw new Error(result.error)

		const existingIds = []
		await indentModel.deleteMany({})

		for (const indent of result.data) {
			if (existingIds.includes(indent.id)) {
				await indentModel.updateOne({ id: indent.id }, indent)
			} else {
				await indentModel.create(indent)
			}
			existingIds.push(indent.id)
		}

		console.log(`[${nowString}] Indents import completed.`)
		// console.log(`[${nowString}] Indents import completed. Next import scheduled at: ${nextImport}`)
	} catch (error) {
		console.error(`[${nowString}] Error importing indents:`, error)
		// console.log(`[${nowString}] Next import scheduled at: ${nextImport}`)
	}
}

// setInterval(importIndents, IMPORT_INTERVAL_GAP)

// importIndents()
