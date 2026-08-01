const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc");
const tz = require("dayjs/plugin/timezone");
const { chromium } = require("playwright");

dayjs.extend(utc);
dayjs.extend(tz);

function formatDate(d) {
  return d.format("YYYY-MM-DD");
}

function normalizeStatusClass(statusClass) {
  return (statusClass || "").toString().trim();
}

function nowInTz(timezone) {
  return dayjs().tz(timezone);
}

function parseDate(value, fieldName) {
  const parsed = dayjs(value, "YYYY-MM-DD", true);
  if (!parsed.isValid()) {
    throw new Error(`${fieldName} must be YYYY-MM-DD, got: ${value || "<empty>"}`);
  }
  return parsed;
}

async function checkAvailabilityAttempt(config) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1366, height: 1000 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  });

  try {
    await page.goto(config.restaurantUrl, { waitUntil: "networkidle", timeout: 45000 });

    const frameHandle = await page.waitForSelector('iframe[src*="/reservation/module_restaurant/"]', {
      timeout: 45000,
    });

    const frame = await frameHandle.contentFrame();
    if (!frame) {
      throw new Error("Reservation iframe was found, but frame context could not be loaded.");
    }

    await frame.waitForSelector("#datepicker", { timeout: 30000 });

    if (config.partySize > 0) {
      await frame.evaluate(async (partySize) => {
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const peopleSelect = document.querySelector("#people_search");

        if (peopleSelect) {
          peopleSelect.value = String(partySize);
          peopleSelect.dispatchEvent(new Event("change", { bubbles: true }));
        }

        if (typeof window.update_hour_people === "function") {
          window.update_hour_people();
        }

        await wait(1800);
      }, config.partySize);
    }

    const extractHighlight = () =>
      frame.evaluate(() => {
        const highlight = window.highlight || {};
        const normalized = {};

        for (const [date, value] of Object.entries(highlight)) {
          if (!Array.isArray(value)) {
            continue;
          }

          normalized[date] = {
            selectable: Boolean(value[0]),
            statusClass: (value[1] || "").toString(),
          };
        }

        return normalized;
      });

    // Read availability data twice with a delay to avoid false positives
    // caused by async page updates that mark slots unavailable shortly after load.
    const firstRead = await extractHighlight();
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const secondRead = await extractHighlight();

    const stableMap = {};
    for (const [date, first] of Object.entries(firstRead)) {
      const second = secondRead[date];
      if (second) {
        // Only mark as selectable if both reads agree
        stableMap[date] = {
          selectable: first.selectable && second.selectable,
          statusClass: second.statusClass,
        };
      } else {
        stableMap[date] = first;
      }
    }
    // Include any dates that only appeared in the second read
    for (const [date, second] of Object.entries(secondRead)) {
      if (!stableMap[date]) {
        stableMap[date] = second;
      }
    }

    const raw = { availabilityMap: stableMap };

    const results = [];
    let cursor = config.startDate.startOf("day");
    const today = nowInTz(config.timezone).startOf("day");

    while (cursor.isBefore(config.endDate.add(1, "day"), "day")) {
      const dateKey = formatDate(cursor);
      const entry = raw.availabilityMap[dateKey];

      if (!entry) {
        results.push({
          date: dateKey,
          available: false,
          reason: "missing_in_widget_data",
          statusClass: null,
        });
        cursor = cursor.add(1, "day");
        continue;
      }

      const statusClass = normalizeStatusClass(entry.statusClass);
      const isPast = cursor.isBefore(today, "day");
      const blocked = config.unavailableClasses.has(statusClass);
      const available = entry.selectable && !blocked && !isPast;

      results.push({
        date: dateKey,
        available,
        reason: available ? "available" : blocked ? "blocked_class" : isPast ? "past_date" : "not_selectable",
        statusClass,
      });

      cursor = cursor.add(1, "day");
    }

    return {
      checkedAt: nowInTz(config.timezone).format(),
      pageUrl: page.url(),
      results,
      availableDates: results.filter((r) => r.available).map((r) => r.date),
    };
  } finally {
    await browser.close();
  }
}

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 5000;

async function checkAvailability(input) {
  const config = {
    restaurantUrl: input.restaurantUrl,
    startDate: parseDate(input.startDate, "startDate"),
    endDate: parseDate(input.endDate, "endDate"),
    timezone: input.timezone || "America/Mexico_City",
    partySize: Number(input.partySize || 2),
    unavailableClasses: new Set(input.unavailableClasses || ["complete", "close_date"]),
  };

  if (config.endDate.isBefore(config.startDate, "day")) {
    throw new Error("endDate must be on or after startDate");
  }

  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.log(`Attempt ${attempt}/${MAX_RETRIES}...`);
      return await checkAvailabilityAttempt(config);
    } catch (error) {
      lastError = error;
      const isTimeout = error.message && error.message.includes("Timeout");
      if (!isTimeout || attempt === MAX_RETRIES) {
        throw error;
      }
      console.log(`Attempt ${attempt} timed out, retrying in ${RETRY_DELAY_MS / 1000}s...`);
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }
  throw lastError;
}

module.exports = {
  checkAvailability,
};
