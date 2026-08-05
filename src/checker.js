const path = require("path");
const dotenv = require("dotenv");
const { checkAvailability } = require("./availability");

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

function formatPartySizes(row) {
  return (row.availablePartySizes || []).length > 0 ? row.availablePartySizes.join(", ") : "<unknown>";
}

function parseUnavailableClasses() {
  return (process.env.UNAVAILABLE_CLASSES || "complete,close_date")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

async function main() {
  const restaurantUrl = process.env.RESTAURANT_URL;
  const startDate = process.env.START_DATE;
  const endDate = process.env.END_DATE;

  if (!restaurantUrl || !startDate || !endDate) {
    throw new Error("RESTAURANT_URL, START_DATE and END_DATE must be set in .env for check-once.");
  }

  const result = await checkAvailability({
    restaurantUrl,
    startDate,
    endDate,
    timezone: process.env.TIMEZONE || "America/Mexico_City",
    partySize: Number(process.env.PARTY_SIZE || 2),
    unavailableClasses: parseUnavailableClasses(),
  });

  console.log("\n=== Availability Check ===");
  console.log(`Checked at: ${result.checkedAt}`);
  console.log(`Page URL: ${result.pageUrl}`);

  for (const row of result.results) {
    console.log(
      `${row.date} | ${row.available ? "AVAILABLE" : "unavailable"} | partySizes=${formatPartySizes(row)} | slots=${(row.timeSlots || []).join(", ") || "<none>"} | reason=${row.reason}`
    );
  }

  if (result.availableDates.length > 0) {
    console.log(`Available dates: ${result.availableDates.join(", ")}`);
  } else {
    console.log("No availability found in the requested range.");
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
