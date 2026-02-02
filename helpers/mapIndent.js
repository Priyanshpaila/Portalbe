export const indentMap = {
	Banfn: "indentNumber",
	Matnr: "itemCode",
	Bnfpo: "lineNumber",
	Loekz: "deletionIndicator",
	Estkz: "creationIndicator",
	Bsakz: "controlIndicator",
	Bsart: "documentType",
	Bstyp: "documentCategory",
	Ernam: "createdBy",
	Bedat: "lastChangedOn",
	Afnam: "requestedBy",
	Txz01: "itemDescription",
	Ebelp: "materialNumber",
	Werks: "company",
	Lgort: "storageLocation",
	Bednr: "trackingNumber",
	Menge: "indentQty",
	Meins: "unitOfMeasure",
	Ebeln: "documentNumber",
	Erdat: "documentDate",
	Packno: "packageNumber",
	Creationdate: "creationDate",
	Creationtime: "creationTime",
	Lastchangedatetime: "utcTimestamp",
	ITEMNOTE: "techSpec",
	MAKEMODEL: "make",
	ITEMTEXT: "remark",
	KOSTL: "costCenter"
}

// "DELIVERYTE": "",
// "MATERIALPO": "",
// "TARGETPRIC": "",

export const indentMapReverse = Object.fromEntries(Object.entries(indentMap).map(([key, value]) => [value, key]))
export const getIndentID = (values) => values.indentNumber + ":" + values.itemCode

export const mapIndent = (indents, returnObject) => {
	const result = returnObject ? {} : []
	for (const indent of indents) {
		const mappedIndent = {}
		for (const key in indent) {
			if (!indentMap[key]) continue
			mappedIndent[indentMap[key]] = indent[key].startsWith("/Date(")
				? new Date(parseInt(indent[key].slice(6, -2)))
				: indent[key]
		}

		mappedIndent.createdOn = new Date(
			new Date(mappedIndent.creationDate).setHours(
				mappedIndent.creationTime.slice(2, 4),
				mappedIndent.creationTime.slice(5, 7),
				mappedIndent.creationTime.slice(8, 10)
			)
		)

		mappedIndent.id = getIndentID(mappedIndent)
		mappedIndent.itemDescription = mappedIndent.itemDescription.replace(/_/g, " ")
		delete mappedIndent.creationTime
		delete mappedIndent.creationDate

		if (returnObject) result[mappedIndent.id] = mappedIndent
		else result.push(mappedIndent)
	}

	return result
}
