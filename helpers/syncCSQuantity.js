import csModel from "../models/cs.model.js"
import poModel from "../models/po.model.js"
import quotationModel from "../models/quotation.model.js"
import rfqModel from "../models/rfq.model.js"
import { getIndentID } from "./mapIndent.js"

/**
 * Syncs the poQty field in CS items based on PO data.
 * @param {string[]} csNumbers - Array of CS numbers to sync.
 */
export const syncCSQuantity = async (csNumbers) => {
	if (!Array.isArray(csNumbers) || csNumbers.length === 0) return

	const [csDocs, poDocs] = await Promise.all([
		csModel.find(
			{ csNumber: { $in: csNumbers } },
			{ csNumber: 1, items: 1, selection: 1, csType: 1, rfqNumber: 1, vendors: 1 }
		),
		poModel.find(
			{
				$or: [{ refCSNumber: { $in: csNumbers } }, { "items.csNumber": { $in: csNumbers } }]
			},
			{ refCSNumber: 1, items: 1, vendorCode: 1 }
		)
	])

	const qtyMap = {}
	for (const po of poDocs) {
		for (const item of po.items) {
			const _csNumber = item.csNumber || po.refCSNumber
			if (!_csNumber) continue
			const vendor = po.vendorCode
			const itemId = getIndentID(item)
			qtyMap[_csNumber] = qtyMap[_csNumber] || {}
			qtyMap[_csNumber][vendor] = qtyMap[_csNumber][vendor] || {}
			qtyMap[_csNumber][vendor][itemId] = (qtyMap[_csNumber][vendor][itemId] || 0) + (item.qty || 0)
		}
	}

	await Promise.all(
		csDocs.map(async (cs) => {
			const csObj = cs.toObject()

			let isCSCompleted = true
			const quotationPOStatus = {}

			const updatedItems = csObj.items.map((item) => {
				const itemId = getIndentID(item)
				let totalPOQty = 0

				const selectedQty =
					csObj.csType === "item_wise"
						? (csObj.selection || []).find((s) => s?.itemCode && getIndentID(s) === itemId)?.qty || 0
						: item.qty

				const updatedVendors = (item.vendors || []).map((vendor) => {
					const poQty = qtyMap[csObj.csNumber]?.[vendor.vendorCode]?.[itemId] || 0

					if (csObj.csType === "item_wise" && quotationPOStatus[vendor.vendorCode] !== false)
						quotationPOStatus[vendor.vendorCode] = poQty === selectedQty

					totalPOQty += poQty
					return { ...vendor, poQty }
				})

				if (isCSCompleted) isCSCompleted = selectedQty === totalPOQty

				return {
					...item,
					vendors: updatedVendors,
					poStatus: selectedQty === totalPOQty ? 1 : 0
				}
			})

			await Promise.all(
				csObj.vendors.map(async (vendor) => {
					const vendorSelection = csObj.selection.filter((i) => i.vendorCode === vendor.vendorCode)
					let status

					if (!vendorSelection?.length) {
						status = 3
					} else if (csObj.csType === "over_all" && isCSCompleted) {
						status = 2
					} else if (csObj.csType === "item_wise") {
						status = quotationPOStatus[vendor.vendorCode] ? 2 : 1.5
					} else {
						status = 1.5
					}

					await quotationModel.findOneAndUpdate({ quotationNumber: vendor.quotationNumber }, { status })
				})
			)

			await rfqModel.findOneAndUpdate({ rfqNumber: cs.rfqNumber }, { status: isCSCompleted ? 2 : 1 })
			await csModel.findByIdAndUpdate(cs._id, { status: isCSCompleted ? 2 : 1, items: updatedItems })
		})
	)
}

syncCSQuantity(["83026627", "C/250625/1713/L1", "C/250628/2159/I5"])
