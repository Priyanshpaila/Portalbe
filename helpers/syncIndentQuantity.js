import indentModel from "../models/indent.model.js"
import poModel from "../models/po.model.js"
import rfqModel from "../models/rfq.model.js"

// To make sure that the balanceQty is always upto date with current DB state, we need to calculate the balanceQty following times:
// 1. When importing indents (complete)
// 2. When creating/updating/deleting the rfq (partial)
// 3. When creating/updating/deleting the po (partial)

const getKey = (doc) => doc.indentNumber + ":" + doc.itemCode

export const syncIndentQuantity = async ({ indents, data: _data, shouldUpdate = false }) => {
	try {
		const data = _data || (await indentModel.find(indents ? { $or: indents } : {}))
		const qtyMap = {}

		const [rfqDocs, poDocs] = await Promise.all([
			rfqModel.find(
				{
					items: {
						$elemMatch: {
							$or: data.map((i) => ({
								indentNumber: i.indentNumber,
								itemCode: i.itemCode
							}))
						}
					}
				},
				{
					"items.indentNumber": 1,
					"items.itemCode": 1,
					"items.rfqQty": 1
				}
			),
			poModel.find(
				{
					refDocumentType: "purchase_order",
					items: {
						$elemMatch: {
							$or: data.map((i) => ({
								indentNumber: i.indentNumber,
								itemCode: i.itemCode
							}))
						}
					}
				},
				{
					"items.indentNumber": 1,
					"items.itemCode": 1,
					"items.qty": 1
				}
			)
		])

		for (const { items } of rfqDocs) {
			for (const item of items) {
				const key = getKey(item)
				if (!qtyMap[key]) qtyMap[key] = { rfqQty: 0, poQty: 0 }
				qtyMap[key].rfqQty += +item.rfqQty
			}
		}

		for (const { items } of poDocs) {
			for (const item of items) {
				const key = getKey(item)
				if (!qtyMap[key]) qtyMap[key] = { rfqQty: 0, poQty: 0 }
				qtyMap[key].poQty += +item.qty
			}
		}

		for (const doc of data) {
			const key = getKey(doc)
			doc.indentQty = +doc.indentQty
			doc.preRFQQty = qtyMap[key]?.rfqQty || 0
			doc.prePOQty = qtyMap[key]?.poQty || 0
			doc.balanceQty = Math.max(0, doc.indentQty - doc.preRFQQty - doc.prePOQty)
		}

		if (shouldUpdate) await Promise.all(data.map((indent) => indentModel.updateOne({ id: indent.id }, indent)))
		else return { data }
	} catch (error) {
		return { error }
	}
}
