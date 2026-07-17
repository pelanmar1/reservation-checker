const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");
const { checkAvailability } = require("./availability");
const { sendAvailabilityEmail } = require("./notifier");

const envPath = path.resolve(process.cwd(), ".env");
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
}

function getEnv(name, fallback = "") {
  const value = process.env[name];
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  return String(value).trim();
}

function parseUnavailableClasses() {
  return getEnv("UNAVAILABLE_CLASSES", "complete,close_date")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

function buildSummary(config, checkResult) {
  return [
    "Reservation availability found.",
    `Restaurant: ${config.restaurantUrl}`,
    `Range: ${config.startDate} to ${config.endDate}`,
    `Party size: ${config.partySize}`,
    `Available dates: ${checkResult.availableDates.join(", ")}`,
    `Checked at: ${checkResult.checkedAt}`,
    `Page URL: ${checkResult.pageUrl}`,
  ].join("\n");
}

function validateConfig(config) {
  const missing = [];
  for (const [key, value] of Object.entries(config)) {
    if (value === undefined || value === null || value === "") {
      missing.push(key);
    }
  }

  if (missing.length > 0) {
    throw new Error(`Missing required configuration: ${missing.join(", ")}`);
  }
}

async function main() {
  const config = {
    restaurantUrl: getEnv("RESTAURANT_URL", "https://restaurante.covermanager.com/mantequilla-social-club/"),
    startDate: getEnv("START_DATE"),
    endDate: getEnv("END_DATE"),
    timezone: getEnv("TIMEZONE", "America/Mexico_City"),
    partySize: Number(getEnv("PARTY_SIZE", "2")),
    alertTo: getEnv("ALERT_TO"),
  };

  validateConfig({
    START_DATE: config.startDate,
    END_DATE: config.endDate,
    ALERT_TO: config.alertTo,
  });

  const checkResult = await checkAvailability({
    restaurantUrl: config.restaurantUrl,
    startDate: config.startDate,
    endDate: config.endDate,
    timezone: config.timezone,
    partySize: config.partySize,
    unavailableClasses: parseUnavailableClasses(),
  });

  console.log(`Checked at: ${checkResult.checkedAt}`);
  for (const row of checkResult.results) {
    console.log(
      `${row.date} | ${row.available ? "AVAILABLE" : "unavailable"} | class=${row.statusClass || "<none>"} | reason=${row.reason}`
    );
  }

  if (checkResult.availableDates.length === 0) {
    console.log("No availability found. No email sent.");
    return;
  }

  const subject = `Table availability found (${checkResult.availableDates.length} date(s))`;
  const text = buildSummary(config, checkResult);

  await sendAvailabilityEmail({
    to: config.alertTo,
    subject,
    text,
  });

  console.log("Availability found and email sent.");
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
