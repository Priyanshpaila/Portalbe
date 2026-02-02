export const formatDate = (date) => {
	return new Date(date)
		.toLocaleString("en-US", {
			month: "short",
			day: "numeric",
			year: "numeric",
			hour: "numeric",
			minute: "2-digit",
			hour12: true
		})
		.replace(/,/g, "")
		.replace(/\s(?=[^ ]*$)/, "")
}
export const dateAsId = () => {
	const d = new Date()
	const arr = [d.getFullYear() % 100, d.getMonth() - 1, d.getDate(), d.getHours(), d.getMinutes()].map((i) =>
		i.toString().padStart(2, "0")
	)

	return arr.slice(0, 3).join("") + "/" + arr.slice(3).join("")
}
