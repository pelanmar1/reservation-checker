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

function toBool(value, fallback = false) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function parseUnavailableClasses() {
  return getEnv("UNAVAILABLE_CLASSES", "complete,close_date")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

function buildSummary(config, checkResult) {
  const detailLines = checkResult.results.map((row) => {
    return `${row.date} | ${row.available ? "AVAILABLE" : "unavailable"} | slots=${(row.timeSlots || []).join(", ") || "<none>"} | reason=${row.reason}`;
  });

  return [
    "Reservation availability found.",
    `Restaurant: ${config.restaurantUrl}`,
    `Range: ${config.startDate} to ${config.endDate}`,
    `Party size: ${config.partySize}`,
    `Available dates: ${checkResult.availableDates.join(", ")}`,
    `Checked at: ${checkResult.checkedAt}`,
    `Page URL: ${checkResult.pageUrl}`,
    "",
    "Availability details:",
    ...detailLines,
  ].join("\n");
}

function buildDebugSummary(config, checkResult) {
  const detailLines = checkResult.results.map((row) => {
    return `${row.date} | ${row.available ? "AVAILABLE" : "unavailable"} | slots=${(row.timeSlots || []).join(", ") || "<none>"} | reason=${row.reason}`;
  });

  return [
    "Debug run: sending current availability snapshot.",
    `Restaurant: ${config.restaurantUrl}`,
    `Range: ${config.startDate} to ${config.endDate}`,
    `Party size: ${config.partySize}`,
    `Available dates: ${checkResult.availableDates.join(", ") || "None"}`,
    `Checked at: ${checkResult.checkedAt}`,
    `Page URL: ${checkResult.pageUrl}`,
    "",
    "Availability details:",
    ...detailLines,
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
    debugAlwaysEmail: toBool(getEnv("DEBUG_ALWAYS_EMAIL", "false"), false),
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
      `${row.date} | ${row.available ? "AVAILABLE" : "unavailable"} | slots=${(row.timeSlots || []).join(", ") || "<none>"} | reason=${row.reason}`
    );
  }

  const hasAvailability = checkResult.availableDates.length > 0;
  const shouldSendDebugEmail = config.debugAlwaysEmail;

  if (!hasAvailability && !shouldSendDebugEmail) {
    console.log("No availability found. No email sent.");
    return;
  }

  const subject = hasAvailability
    ? `Table availability found (${checkResult.availableDates.length} date(s))`
    : "Debug: current reservation availability snapshot";

  const text = hasAvailability
    ? buildSummary(config, checkResult)
    : buildDebugSummary(config, checkResult);

  await sendAvailabilityEmail({
    to: config.alertTo,
    subject,
    text,
  });

  if (hasAvailability) {
    console.log("Availability found and email sent.");
  } else {
    console.log("Debug email sent with current availability snapshot.");
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
