import axios from "axios"
import { URLS } from "./constants.js"
import { mapVendor } from "../helpers/mapVendor.js"
import vendorModel from "../models/vendor.model.js"

const fetchVendors = async () => {
	const response = await axios.get(URLS.SAP_VENDORS_URL, {
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
			$filter: `Erdat ge datetime'${new Date("2025-01-01").toISOString().split(".")[0]}'`
		}
	})

	return mapVendor(response.data?.d?.results)
}

// const IMPORT_INTERVAL_GAP = 60 * 60 * 1000
export const importVendors = async () => {
	const now = new Date()
	const nowString = now.toUTCString().slice(5)
	// const nextImport = new Date(now.getTime() + IMPORT_INTERVAL_GAP).toUTCString().slice(5)

	try {
		const data = await fetchVendors()
		const existingVendors = []

		console.log(`[${nowString}] Importing vendors...`)
		await vendorModel.deleteMany({})

		for (const vendor of data) {
			if (existingVendors.includes(vendor.vendorCode)) {
				await vendorModel.updateOne({ vendorCode: vendor.vendorCode }, vendor)
			} else {
				await vendorModel.create(vendor)
			}
			existingVendors.push(vendor.vendorCode)
		}

		console.log(`[${nowString}] Vendors import completed.`)
		// console.log(`[${nowString}] Vendors import completed. Next import scheduled at: ${nextImport}`)
	} catch (error) {
		console.error(`[${nowString}] Error importing vendors:`, error)
		// console.log(`[${nowString}] Next import scheduled at: ${nextImport}`)
	}
}

// setInterval(importVendors, IMPORT_INTERVAL_GAP)

// importVendors()
