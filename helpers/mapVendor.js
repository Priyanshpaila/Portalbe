export const vendorMap = {
	Lifnr: "vendorCode",
	Bukrs: "companyCode",

	NameOrg1: "orgName1",
	NameOrg2: "orgName2",

	NameFirst: "firstName",
	NameLast: "lastName",

	Name1: "name1",
	Name2: "name2",
	Name3: "name3",
	Name4: "name4",

	Land1: "countryKey",
	Country: "countryKey",
	City1: "city",
	Region: "region",
	Langu: "languageKey",
	Ort01: "city",
	Ort02: "district",
	Pfach: "poBox",
	Pstl2: "poBoxPostalCode",
	Pstlz: "postalCode",
	PostCode1: "cityPostalCode",
	Stras: "streetHouseNumber",
	Street: "street",
	StrSuppl1: "street2",
	StrSuppl2: "street3",
	StrSuppl3: "street4",
	Location: "street5",

	Erdat: "creationDate",
	Sortl: "sortField",
	J1ipanno: "panNumber",
	STENR: "msme",
	STCD3: "gstin"
}

const vendorContactPersonMap = {
	SmtpAddr: "email",
	R3User: "mobilePhoneIndicator",
	TelnrLong: "fullPhoneNumber",
	TelnrCall: "callerPhoneNumber",
	NAMECP: "name"
}

export const vendorMapReverse = Object.fromEntries(Object.entries(vendorMap).map(([key, value]) => [value, key]))

export const mapVendor = (vendors) => {
	const result = []
	for (const vendor of vendors) {
		const mappedVendor = {}
		for (const key in vendor) {
			if (!vendorMap[key]) continue
			mappedVendor[vendorMap[key]] = vendor[key].startsWith("/Date(")
				? new Date(parseInt(vendor[key].slice(6, -2)))
				: vendor[key]
		}

		mappedVendor.name =
			[mappedVendor.firstName, mappedVendor.lastName].filter(Boolean).join(" ") ||
			mappedVendor.name1 ||
			mappedVendor.name2 ||
			mappedVendor.name3 ||
			mappedVendor.name4 ||
			""
		delete mappedVendor.firstName
		delete mappedVendor.lastName
		mappedVendor.contactPerson = {}

		for (const key in vendorContactPersonMap) {
			mappedVendor.contactPerson[vendorContactPersonMap[key]] = vendor[key].startsWith("/Date(")
				? new Date(parseInt(vendor[key].slice(6, -2)))
				: vendor[key]
		}

		mappedVendor.contactPerson = [mappedVendor.contactPerson]

		result.push(mappedVendor)
	}

	return result
}
