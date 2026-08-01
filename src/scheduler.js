const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc");
const tz = require("dayjs/plugin/timezone");
const { checkAvailability } = require("./availability");
const { getWatchConfig, updateWatchMetadata } = require("./store");
const { sendAvailabilityEmail } = require("./notifier");

dayjs.extend(utc);
dayjs.extend(tz);

function parseUnavailableClasses(raw) {
  return raw
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

class WatchScheduler {
  constructor(options) {
    this.timezone = options.timezone;
    this.restaurantUrl = options.restaurantUrl;
    this.defaultPartySize = options.defaultPartySize;
    this.notifyCooldownMinutes = options.notifyCooldownMinutes;
    this.unavailableClasses = options.unavailableClasses;
    this.intervalMs = options.intervalMinutes * 60 * 1000;
    this.timer = null;
    this.running = false;
    this.lastRunSummary = null;
  }

  getState() {
    return {
      running: this.running,
      intervalMinutes: this.intervalMs / 1000 / 60,
      lastRunSummary: this.lastRunSummary,
    };
  }

  setIntervalMinutes(minutes) {
    const safeMinutes = Number.isFinite(Number(minutes)) && Number(minutes) > 0 ? Math.floor(Number(minutes)) : 5;
    this.intervalMs = safeMinutes * 60 * 1000;

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = setInterval(() => {
        this.runCycle("interval").catch(() => {});
      }, this.intervalMs);
    }
  }

  async runCycle(trigger = "interval") {
    if (this.running) {
      return;
    }

    this.running = true;
    try {
      const watch = await getWatchConfig();
      if (!watch || !watch.startDate || !watch.endDate || !watch.notificationEmail) {
        this.lastRunSummary = {
          checkedAt: new Date().toISOString(),
          trigger,
          status: "skipped",
          reason: "watch_not_configured",
        };
        return;
      }

      if (watch.checkIntervalMinutes) {
        this.setIntervalMinutes(Number(watch.checkIntervalMinutes));
      }

      const checkResult = await checkAvailability({
        restaurantUrl: this.restaurantUrl,
        startDate: watch.startDate,
        endDate: watch.endDate,
        timezone: this.timezone,
        partySize: Number(watch.partySize || this.defaultPartySize),
        unavailableClasses: this.unavailableClasses,
      });

      let notified = false;
      let notificationError = null;

      if (checkResult.availableDates.length > 0) {
        const lastNotifiedAt = watch.lastNotifiedAt ? dayjs(watch.lastNotifiedAt) : null;
        const now = dayjs();
        const cooldownReady = !lastNotifiedAt || now.diff(lastNotifiedAt, "minute") >= this.notifyCooldownMinutes;

        if (cooldownReady) {
          const subject = "Table availability found";
          const body = [
            "Reservation availability found.",
            `Restaurant: ${this.restaurantUrl}`,
            `Range: ${watch.startDate} to ${watch.endDate}`,
            `Party size: ${watch.partySize || this.defaultPartySize}`,
            `Available dates: ${checkResult.availableDates.join(", ")}`,
            "",
            "Available time slots:",
            ...checkResult.results
              .filter((row) => row.available)
              .map((row) => `${row.date}: ${(row.timeSlots || []).join(", ") || "<none>"}`),
            `Checked at: ${checkResult.checkedAt}`,
          ].join("\n");

          try {
            await sendAvailabilityEmail({
              to: watch.notificationEmail,
              subject,
              text: body,
            });
            notified = true;
          } catch (error) {
            notificationError = error.message;
          }
        }
      }

      const metadataPatch = {
        lastRun: {
          trigger,
          checkedAt: checkResult.checkedAt,
          pageUrl: checkResult.pageUrl,
          availableDates: checkResult.availableDates,
          totalDatesChecked: checkResult.results.length,
          notificationSent: notified,
          notificationError,
        },
      };

      if (notified) {
        metadataPatch.lastNotifiedAt = new Date().toISOString();
      }

      await updateWatchMetadata(metadataPatch);
      this.lastRunSummary = {
        ...metadataPatch.lastRun,
        status: "ok",
      };
    } catch (error) {
      this.lastRunSummary = {
        checkedAt: new Date().toISOString(),
        trigger,
        status: "error",
        message: error.message,
      };
    } finally {
      this.running = false;
    }
  }

  async runNow() {
    await this.runCycle("manual");
    return this.lastRunSummary;
  }

  start() {
    if (this.timer) {
      return;
    }

    this.runCycle("startup").catch(() => {});
    this.timer = setInterval(() => {
      this.runCycle("interval").catch(() => {});
    }, this.intervalMs);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

function createSchedulerFromEnv() {
  return new WatchScheduler({
    timezone: process.env.TIMEZONE || "America/Mexico_City",
    restaurantUrl: process.env.RESTAURANT_URL || "https://restaurante.covermanager.com/mantequilla-social-club/",
    defaultPartySize: Number(process.env.PARTY_SIZE || 2),
    notifyCooldownMinutes: Number(process.env.NOTIFY_COOLDOWN_MINUTES || 60),
    unavailableClasses: parseUnavailableClasses(process.env.UNAVAILABLE_CLASSES || "complete,close_date"),
    intervalMinutes: Number(process.env.CHECK_INTERVAL_MINUTES || 5),
  });
}

module.exports = {
  WatchScheduler,
  createSchedulerFromEnv,
};
