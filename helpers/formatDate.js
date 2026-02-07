// formatDate.js
export const toValidDate = (input) => {
  if (!input) return null;

  // already a Date
  if (input instanceof Date) {
    return Number.isNaN(input.getTime()) ? null : input;
  }

  // number timestamp or string
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return null;

  return d;
};

export const formatDate = (date) => {
  const d = toValidDate(date);
  if (!d) return "N/A"; // ✅ prevents InvalidDate

  return d
    .toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      // optional: keep consistent timezone for server
      // timeZone: "Asia/Kolkata",
    })
    .replace(/,/g, "")
    .replace(/\s(?=[^ ]*$)/, "");
};

export const dateAsId = () => {
  const d = new Date();

  // ✅ FIX: getMonth() is 0-based, so +1 (not -1)
  const arr = [
    d.getFullYear() % 100,
    d.getMonth() + 1,
    d.getDate(),
    d.getHours(),
    d.getMinutes(),
  ].map((i) => i.toString().padStart(2, "0"));

  return arr.slice(0, 3).join("") + "/" + arr.slice(3).join("");
};
