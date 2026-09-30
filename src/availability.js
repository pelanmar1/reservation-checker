const fs = require("fs");
const path = require("path");
const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc");
const tz = require("dayjs/plugin/timezone");
const { chromium } = require("playwright");

dayjs.extend(utc);
dayjs.extend(tz);

function formatDate(d) {
  return d.format("YYYY-MM-DD");
}

function normalizePartySize(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`partySize must be a positive integer, got: ${value === undefined || value === "" ? "<empty>" : value}`);
  }
  return parsed;
}

function nowInTz(timezone) {
  return dayjs().tz(timezone);
}

function uniqueSortedNumbers(values) {
  return [...new Set(values.filter((value) => Number.isFinite(value)).map((value) => Math.floor(value)))].sort((a, b) => a - b);
}

function parseDate(value, fieldName) {
  const parsed = dayjs(value, "YYYY-MM-DD", true);
  if (!parsed.isValid()) {
    throw new Error(`${fieldName} must be YYYY-MM-DD, got: ${value || "<empty>"}`);
  }
  return parsed;
}

const PEOPLE_HINT = /persona|people|pax|comensal|guest|party|diner/i;
const HOUR_HINT = /\bhora|hour|time|turno/i;
const TIME_PATTERN = /^([01]?\d|2[0-3]):[0-5]\d$/;
const UNAVAILABLE_LABEL = /complet|lleno|agotad|lista de espera|waiting|waitlist|no disponible|sin disponibilidad|not available|unavailable|sold out|full|cerrad|closed/i;
const SETTLE_TIMEOUT_MS = 10000;

function sanitizeForFilename(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]+/g, "_");
}

async function waitForSettled(page) {
  await page.waitForLoadState("networkidle", { timeout: SETTLE_TIMEOUT_MS }).catch(() => {});
  await page.waitForTimeout(500);
}

async function openBookingContext(page, restaurantUrl) {
  await page.goto(restaurantUrl, { waitUntil: "networkidle", timeout: 45000 });

  const frameHandle = await page.$('iframe[src*="/reservation/module_restaurant/"]');
  if (!frameHandle) {
    await page.waitForSelector("body", { timeout: 30000 });
    return page;
  }

  const frame = await frameHandle.contentFrame();
  if (!frame) {
    throw new Error("Reservation iframe was found, but frame context could not be loaded.");
  }

  await frame.waitForSelector("body", { timeout: 30000 });
  return frame;
}

async function saveArtifacts(page, artifactsDir, name) {
  if (!artifactsDir) {
    return;
  }

  try {
    fs.mkdirSync(artifactsDir, { recursive: true });
    const base = path.join(artifactsDir, sanitizeForFilename(name));
    await page.screenshot({ path: `${base}.png`, fullPage: true });

    const parts = [];
    for (const frame of page.frames()) {
      const html = await frame.content().catch(() => "");
      parts.push(`<!-- frame: ${frame.url()} -->\n${html}`);
    }
    fs.writeFileSync(`${base}.html`, parts.join("\n\n"));
  } catch (error) {
    console.log(`Could not save debug artifacts for ${name}: ${error.message}`);
  }
}

// Marks the calendar cell for the target date with data-rc-day="target" and returns its classes.
// Supports explicit date attributes, bootstrap-datepicker (data-date as UTC ms),
// jQuery UI datepicker (data-year/data-month on the td) and a month-header + day-number fallback.
async function markDayCell(context, target) {
  return await context.evaluate((t) => {
    document.querySelectorAll("[data-rc-day]").forEach((el) => el.removeAttribute("data-rc-day"));

    const pad = (n) => String(n).padStart(2, "0");
    const variants = [
      `${t.year}-${pad(t.month)}-${pad(t.day)}`,
      `${pad(t.day)}-${pad(t.month)}-${t.year}`,
      `${pad(t.day)}/${pad(t.month)}/${t.year}`,
      `${t.day}/${t.month}/${t.year}`,
      `${t.year}/${pad(t.month)}/${pad(t.day)}`,
      `${t.year}${pad(t.month)}${pad(t.day)}`,
    ];
    const utcMs = String(Date.UTC(t.year, t.month - 1, t.day));
    const attrs = ["data-date", "data-day", "data-dia", "data-value", "data-fecha", "onclick", "id", "href"];

    const isVisible = (el) => {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };

    const pick = (candidates) => {
      const visible = candidates.filter(isVisible);
      const pool = visible.length ? visible : candidates;
      // Prefer the innermost element (fewest descendants) so we never click a big container.
      return pool.sort((a, b) => a.querySelectorAll("*").length - b.querySelectorAll("*").length)[0] || null;
    };

    const result = (el, strategy) => {
      el.setAttribute("data-rc-day", "target");
      const cell = el.closest("td") || el;
      const classes = new Set(
        [...(el.className ? String(el.className).split(/\s+/) : []), ...(cell.className ? String(cell.className).split(/\s+/) : [])].filter(Boolean)
      );
      return { found: true, strategy, classes: [...classes] };
    };

    const all = Array.from(document.querySelectorAll("body *"));

    const byAttr = all.filter((el) =>
      attrs.some((name) => {
        const value = el.getAttribute(name);
        if (!value) {
          return false;
        }
        if (name === "data-date" && value === utcMs) {
          return true;
        }
        return variants.some((v) => value === v || value.includes(`'${v}'`) || value.includes(`"${v}"`) || value.endsWith(v));
      })
    );
    const attrMatch = pick(byAttr);
    if (attrMatch) {
      return result(attrMatch, "attribute");
    }

    const jqui = all.filter(
      (el) =>
        el.tagName === "TD" &&
        el.getAttribute("data-year") === String(t.year) &&
        el.getAttribute("data-month") === String(t.month - 1) &&
        (el.textContent || "").trim() === String(t.day)
    );
    if (jqui.length) {
      return result(pick(jqui), "jquery-ui");
    }

    const monthNames = [t.monthNameEs, t.monthNameEn].map((m) => m.toLowerCase());
    const headers = all.filter((el) => {
      if (el.children.length > 2) {
        return false;
      }
      const text = (el.textContent || "").trim().toLowerCase();
      return text.length < 40 && text.includes(String(t.year)) && monthNames.some((m) => text.includes(m));
    });

    const otherMonth = /\b(old|new|other|outside|prev|next|disabled-other|ui-datepicker-other-month)\b/i;
    for (const header of headers) {
      let container = header.parentElement;
      for (let depth = 0; container && depth < 6; depth += 1, container = container.parentElement) {
        const cells = Array.from(container.querySelectorAll("td, button, a, div, span")).filter((el) => {
          if ((el.textContent || "").trim() !== String(t.day)) {
            return false;
          }
          const cell = el.closest("td") || el;
          return !otherMonth.test(String(el.className || "")) && !otherMonth.test(String(cell.className || ""));
        });
        if (cells.length) {
          return result(pick(cells), "month-header");
        }
      }
    }

    const headerTexts = all
      .filter((el) => el.children.length === 0 && /\b(19|20)\d{2}\b/.test(el.textContent || "") && (el.textContent || "").trim().length < 40)
      .map((el) => el.textContent.trim())
      .slice(0, 5);
    return { found: false, headerTexts };
  }, target);
}

async function goToNextMonth(context) {
  const clicked = await context.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll("a, button, th, span, div, i")).filter((el) => {
      const hint = [el.className, el.id, el.getAttribute("title"), el.getAttribute("aria-label"), el.getAttribute("data-handler"), (el.textContent || "").trim()]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return /\b(next|siguiente|sig)\b|›|»|^>$/.test(hint) && el.getBoundingClientRect().width > 0;
    });
    const target = candidates.sort((a, b) => a.querySelectorAll("*").length - b.querySelectorAll("*").length)[0];
    if (!target) {
      return false;
    }
    target.click();
    return true;
  });
  return clicked;
}

async function selectDate(context, page, date) {
  const target = {
    year: date.year(),
    month: date.month() + 1,
    day: date.date(),
    monthNameEs: ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"][date.month()],
    monthNameEn: date.locale("en").format("MMMM"),
  };

  let marked = await markDayCell(context, target);
  for (let i = 0; !marked.found && i < 12; i += 1) {
    if (!(await goToNextMonth(context))) {
      break;
    }
    await page.waitForTimeout(400);
    marked = await markDayCell(context, target);
  }

  if (!marked.found) {
    return { selected: false, detail: `calendar headers seen: ${(marked.headerTexts || []).join(" | ") || "<none>"}` };
  }

  await context.click('[data-rc-day="target"]', { force: true, timeout: 5000 });
  await waitForSettled(page);
  return { selected: true, strategy: marked.strategy, classes: marked.classes };
}

// Finds the "Personas" and "Hora" dropdowns, tags them with data-rc-role and returns their enabled options.
async function readDropdowns(context, hints) {
  return await context.evaluate((h) => {
    const peopleHint = new RegExp(h.people, "i");
    const hourHint = new RegExp(h.hour, "i");
    const timePattern = new RegExp(h.time);
    const unavailable = new RegExp(h.unavailable, "i");

    document.querySelectorAll("[data-rc-role]").forEach((el) => el.removeAttribute("data-rc-role"));

    const ownText = (select) => {
      const parts = [select.id, select.name, select.className, select.getAttribute("aria-label"), select.getAttribute("title")];
      if (select.id) {
        const label = document.querySelector(`label[for="${CSS.escape(select.id)}"]`);
        if (label) {
          parts.push(label.textContent);
        }
      }
      const wrappingLabel = select.closest("label");
      if (wrappingLabel) {
        parts.push(wrappingLabel.textContent);
      }
      const prev = select.previousElementSibling;
      if (prev && !prev.querySelector("select") && prev.tagName !== "SELECT") {
        parts.push(prev.textContent);
      }
      if (select.options[0]) {
        parts.push(select.options[0].textContent);
      }
      return parts.filter(Boolean).join(" ");
    };

    const contextText = (select) => {
      let node = select.parentElement;
      for (let depth = 0; node && depth < 3; depth += 1, node = node.parentElement) {
        if (node.querySelectorAll("select").length > 1) {
          break;
        }
        const text = (node.textContent || "").trim();
        if (text) {
          return text.slice(0, 200);
        }
      }
      return "";
    };

    const readOptions = (select) =>
      Array.from(select.options).map((option) => ({
        value: (option.getAttribute("value") ?? option.value ?? "").trim(),
        label: (option.textContent || "").trim(),
        disabled: option.disabled || option.hidden || option.getAttribute("aria-disabled") === "true",
        selected: option.selected,
        className: String(option.className || ""),
      }));

    const selects = Array.from(document.querySelectorAll("select"));
    const isTimeSelect = (select) => readOptions(select).some((o) => timePattern.test(o.label) || timePattern.test(o.value));

    const findByHint = (hint, exclude) => {
      const pool = selects.filter((s) => !exclude(s));
      return pool.find((s) => hint.test(ownText(s))) || pool.find((s) => hint.test(contextText(s))) || null;
    };

    const peopleSelect =
      document.querySelector("select#people_search") || findByHint(peopleHint, (s) => isTimeSelect(s));
    const hourSelect =
      findByHint(hourHint, (s) => s === peopleSelect) ||
      selects.find((s) => s !== peopleSelect && isTimeSelect(s)) ||
      null;

    const parseSize = (option) => {
      const numeric = Number(option.value);
      if (Number.isInteger(numeric) && numeric > 0) {
        return numeric;
      }
      const match = option.label.match(/^\s*(\d+)/);
      return match ? Number(match[1]) : NaN;
    };

    let people = null;
    if (peopleSelect) {
      peopleSelect.setAttribute("data-rc-role", "people");
      const options = readOptions(peopleSelect);
      people = {
        selectedValue: peopleSelect.value,
        options: options
          .filter((o) => !o.disabled && !unavailable.test(o.label) && !unavailable.test(o.className))
          .map((o) => ({ value: o.value, size: parseSize(o) }))
          .filter((o) => Number.isInteger(o.size) && o.size > 0),
      };
    }

    let hours = null;
    if (hourSelect) {
      hourSelect.setAttribute("data-rc-role", "hour");
      hours = readOptions(hourSelect)
        .filter((o) => !o.disabled && o.value && o.value !== "-1")
        .filter((o) => !unavailable.test(o.label) && !unavailable.test(o.className))
        .map((o) => {
          const labelTime = (o.label.match(/([01]?\d|2[0-3]):[0-5]\d/) || [])[0];
          return timePattern.test(o.value) ? o.value : labelTime || "";
        })
        .filter(Boolean);
    }

    return { people, hours, hoursSnapshot: hourSelect ? hourSelect.innerHTML : null };
  }, hints);
}

const DROPDOWN_HINTS = {
  people: PEOPLE_HINT.source,
  hour: HOUR_HINT.source,
  time: TIME_PATTERN.source,
  unavailable: UNAVAILABLE_LABEL.source,
};

async function checkSingleDate(browser, config, date, artifactName) {
  const page = await browser.newPage({
    viewport: { width: 1366, height: 1000 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  });

  const row = {
    date: formatDate(date),
    available: false,
    reason: "",
    statusClass: null,
    timeSlots: [],
    availablePartySizes: [],
  };

  try {
    const context = await openBookingContext(page, config.restaurantUrl);
    const dateSelection = await selectDate(context, page, date);

    if (!dateSelection.selected) {
      row.reason = `date_not_found (${dateSelection.detail})`;
      return row;
    }

    const blockedClass = (dateSelection.classes || []).find((c) => config.unavailableClasses.has(c));
    row.statusClass = (dateSelection.classes || []).join(" ") || null;
    if (blockedClass) {
      row.reason = `date_marked_${blockedClass}`;
      return row;
    }

    let dropdowns = await readDropdowns(context, DROPDOWN_HINTS);
    const deadline = Date.now() + SETTLE_TIMEOUT_MS;
    while ((!dropdowns.people || dropdowns.people.options.length === 0) && Date.now() < deadline) {
      await page.waitForTimeout(250);
      dropdowns = await readDropdowns(context, DROPDOWN_HINTS);
    }

    if (!dropdowns.people) {
      row.reason = "personas_dropdown_not_found";
      return row;
    }

    row.availablePartySizes = uniqueSortedNumbers(dropdowns.people.options.map((o) => o.size));
    if (row.availablePartySizes.length === 0) {
      row.reason = "no_party_sizes_listed";
      return row;
    }

    const partyOption = dropdowns.people.options.find((o) => o.size === config.partySize);
    if (!partyOption) {
      row.reason = "party_size_unavailable";
      return row;
    }

    const alreadySelected = dropdowns.people.selectedValue === partyOption.value;
    const hoursBefore = dropdowns.hoursSnapshot;
    if (!alreadySelected) {
      await context.selectOption('[data-rc-role="people"]', partyOption.value, { force: true, timeout: 5000 });
      await waitForSettled(page);
    }

    dropdowns = await readDropdowns(context, DROPDOWN_HINTS);
    const hourDeadline = Date.now() + SETTLE_TIMEOUT_MS;
    while (
      (dropdowns.hours === null || (!alreadySelected && dropdowns.hoursSnapshot === hoursBefore && dropdowns.hours.length === 0)) &&
      Date.now() < hourDeadline
    ) {
      await page.waitForTimeout(250);
      dropdowns = await readDropdowns(context, DROPDOWN_HINTS);
    }

    if (dropdowns.hours === null) {
      row.reason = "hora_dropdown_not_found";
      return row;
    }

    row.timeSlots = [...new Set(dropdowns.hours)];
    row.available = row.timeSlots.length > 0;
    row.reason = row.available ? "time_slots_available" : "no_time_slots";
    return row;
  } finally {
    await saveArtifacts(page, config.artifactsDir, `${artifactName}-${row.date}`);
    await page.close();
  }
}

async function checkAvailabilityAttempt(config) {
  const browser = await chromium.launch({ headless: true });

  try {
    const results = [];
    let cursor = config.startDate.startOf("day");
    const today = nowInTz(config.timezone).startOf("day");
    const runId = nowInTz(config.timezone).format("YYYYMMDD-HHmmss");

    while (cursor.isBefore(config.endDate.add(1, "day"), "day")) {
      if (cursor.isBefore(today, "day")) {
        results.push({
          date: formatDate(cursor),
          available: false,
          reason: "past_date",
          statusClass: null,
          timeSlots: [],
          availablePartySizes: [],
        });
      } else {
        results.push(await checkSingleDate(browser, config, cursor, runId));
      }
      cursor = cursor.add(1, "day");
    }

    return {
      checkedAt: nowInTz(config.timezone).format(),
      pageUrl: config.restaurantUrl,
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
    partySize: normalizePartySize(input.partySize),
    unavailableClasses: new Set(input.unavailableClasses || ["complete", "close_date"]),
    artifactsDir: input.artifactsDir || process.env.DEBUG_ARTIFACTS_DIR || "",
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
