const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc");
const tz = require("dayjs/plugin/timezone");
const { chromium } = require("playwright");

dayjs.extend(utc);
dayjs.extend(tz);

function formatDate(d) {
  return d.format("YYYY-MM-DD");
}

function formatWidgetDate(d) {
  return d.format("DD-MM-YYYY");
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

    let bookingContext = page;
    let moduleUrl = page.url();
    const frameHandle = await page.$('iframe[src*="/reservation/module_restaurant/"]');

    if (frameHandle) {
      const frame = await frameHandle.contentFrame();
      if (!frame) {
        throw new Error("Reservation iframe was found, but frame context could not be loaded.");
      }

      bookingContext = frame;
      moduleUrl = frame.url() || (await frameHandle.getAttribute("src")) || moduleUrl;
    }

    await bookingContext.waitForSelector("body", { timeout: 30000 });

    const moduleMeta = await bookingContext.evaluate(
      ({ partySize }) => {
        const getValue = (selectors) => {
          for (const selector of selectors) {
            const element = document.querySelector(selector);
            if (!element) {
              continue;
            }

            const value = typeof element.value === "string" ? element.value : element.getAttribute("value");
            if (value !== null && value !== undefined && String(value).trim() !== "") {
              return String(value).trim();
            }
          }
          return "";
        };

        const peopleSelect = document.querySelector("#people_search");
        if (peopleSelect && partySize > 0) {
          peopleSelect.value = String(partySize);
          peopleSelect.dispatchEvent(new Event("change", { bubbles: true }));
        }

        const pathParts = new URL(window.location.href).pathname.split("/").filter(Boolean);
        const restaurantIndex = pathParts.indexOf("module_restaurant");
        const maxPeopleOptions = peopleSelect
          ? Array.from(peopleSelect.options)
              .map((option) => Number(option.value))
              .filter((value) => Number.isFinite(value))
          : [];

        return {
          restaurant: restaurantIndex >= 0 ? pathParts[restaurantIndex + 1] || "" : "",
          language: restaurantIndex >= 0 ? pathParts[restaurantIndex + 2] || "" : "",
          people: String(partySize > 0 ? partySize : peopleSelect?.value || 2),
          onlyThisPeople: getValue(['input[name="only_this_people"]', "#only_this_people"]),
          minPeople: getValue(['input[name="min_people"]', "#min_people"]),
          maxPeople:
            getValue(['input[name="max_people"]', "#max_people"]) ||
            (maxPeopleOptions.length > 0 ? String(Math.max(...maxPeopleOptions)) : ""),
          timeFix: getValue(['input[name="time_fix"]', "#time_fix"]),
          skipBlockedTables:
            getValue(['input[name="skip_blocked_tables"]', "#skip_blocked_tables"]) || "false",
          marketplace: getValue(['input[name="marketplace"]', "#marketplace"]) || "false",
        };
      },
      { partySize: config.partySize }
    );

    if (!moduleMeta.restaurant) {
      const parsedModuleUrl = new URL(moduleUrl, page.url());
      const pathParts = parsedModuleUrl.pathname.split("/").filter(Boolean);
      const restaurantIndex = pathParts.indexOf("module_restaurant");

      moduleMeta.restaurant = restaurantIndex >= 0 ? pathParts[restaurantIndex + 1] || "" : "";
      moduleMeta.language = restaurantIndex >= 0 ? pathParts[restaurantIndex + 2] || "" : "";
    }

    if (!moduleMeta.restaurant) {
      throw new Error(`Could not determine CoverManager restaurant identifier from ${moduleUrl}`);
    }

    const fetchSlotsForDate = async (widgetDate) =>
      await bookingContext.evaluate(async (request) => {
        const payload = new URLSearchParams();
        const fields = {
          language: request.language,
          restaurant: request.restaurant,
          dia: request.date,
          people: request.people,
          only_this_people: request.onlyThisPeople,
          min_people: request.minPeople,
          max_people: request.maxPeople,
          time_fix: request.timeFix,
          skip_blocked_tables: request.skipBlockedTables,
          marketplace: request.marketplace,
        };

        for (const [key, value] of Object.entries(fields)) {
          payload.set(key, value ?? "");
        }

        const response = await fetch("/reservation/update_hour_people/0", {
          method: "POST",
          headers: {
            accept: "application/json, text/javascript, */*; q=0.01",
            "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
            "x-requested-with": "XMLHttpRequest",
          },
          body: payload.toString(),
          credentials: "same-origin",
        });

        if (!response.ok) {
          throw new Error(`Slot lookup failed with HTTP ${response.status}`);
        }

        const data = await response.json();
        const parser = new DOMParser();
        const doc = parser.parseFromString(data.hour_box || "", "text/html");
        const timePattern = /^([01]?\d|2[0-3]):[0-5]\d$/;

        const optionSlots = Array.from(doc.querySelectorAll("option"))
          .map((option) => ({
            value: (option.getAttribute("value") || "").trim(),
            label: (option.textContent || "").trim(),
            disabled: option.disabled,
          }))
          .filter((option) => {
            if (option.disabled) {
              return false;
            }

            if (!option.value || option.value === "-1") {
              return false;
            }

            return timePattern.test(option.label) || timePattern.test(option.value);
          })
          .map((option) => (timePattern.test(option.label) ? option.label : option.value));

        const fallbackSlots = optionSlots.length
          ? optionSlots
          : Array.from(doc.querySelectorAll("button, a, div, span, label, input"))
              .map((element) => {
                const text = (element.textContent || "").trim();
                const value = (element.getAttribute("value") || element.getAttribute("data-value") || "").trim();
                const disabled =
                  element.hasAttribute("disabled") ||
                  element.getAttribute("aria-disabled") === "true" ||
                  (element.className || "").toString().includes("disabled");

                if (disabled) {
                  return "";
                }

                if (timePattern.test(text)) {
                  return text;
                }

                if (timePattern.test(value)) {
                  return value;
                }

                return "";
              })
              .filter(Boolean);

        return {
          timeSlots: [...new Set(fallbackSlots)],
        };
      }, {
        ...moduleMeta,
        date: widgetDate,
      });

    const results = [];
    let cursor = config.startDate.startOf("day");
    const today = nowInTz(config.timezone).startOf("day");

    while (cursor.isBefore(config.endDate.add(1, "day"), "day")) {
      const dateKey = formatDate(cursor);
      const isPast = cursor.isBefore(today, "day");

      if (isPast) {
        results.push({
          date: dateKey,
          available: false,
          reason: "past_date",
          statusClass: null,
          timeSlots: [],
        });
        cursor = cursor.add(1, "day");
        continue;
      }

      const slotResult = await fetchSlotsForDate(formatWidgetDate(cursor));
      const available = slotResult.timeSlots.length > 0;

      results.push({
        date: dateKey,
        available,
        reason: available ? "time_slots_available" : "no_time_slots",
        statusClass: null,
        timeSlots: slotResult.timeSlots,
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
