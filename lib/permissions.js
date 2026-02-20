export const PERMISSIONS = {
	ACCESS_CONTROL: "access_control",
	VENDOR_ACCESS: "vendor_access",
	MANAGE_RFQ: "manage_rfq",
	MANAGE_CS: "manage_cs",
	MANAGE_PO: "manage_po",
	VIEW_QUOTATION: "view_quotation",
	AUTHORIZE_CS: "authorize_cs",
	AUTHORIZE_PO: "authorize_po"
}




//    if (!vendorUser) {
//       const vendorRole = await roleModel.findOne(
//         { permissions: { $in: [PERMISSIONS.VENDOR_ACCESS] } },
//         { _id: 1 },
//       );
//       const hashedPassword = await hashAsync(vendor.vendorCode, 10);
//       vendorUser = await userModel.create({
//         username: vendor.vendorCode,
//         vendorCode: vendor.vendorCode,
//         password: hashedPassword,
//         passwordStatus: "temporary",
//         createdBy: user,
//         name: vendor.name,
//         email: vendor.contactPerson.email,
//         role: vendorRole._id,
//       });
//     }