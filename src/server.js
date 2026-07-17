const path = require("path");
const express = require("express");
const dotenv = require("dotenv");
const { getWatchConfig, saveWatchConfig } = require("./store");
const { createSchedulerFromEnv } = require("./scheduler");
const { smtpConfigFromEnv, canSendEmail } = require("./notifier");

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

const app = express();
const scheduler = createSchedulerFromEnv();

app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(process.cwd(), "public")));

function esc(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isValidDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value || "");
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value || "");
}

function toPositiveInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

function renderHome({ watch, schedulerState, flash, smtpReady }) {
  const current = watch || {};
  const lastRun = schedulerState.lastRunSummary;
  const fixedRestaurantUrl = process.env.RESTAURANT_URL || "https://restaurante.covermanager.com/mantequilla-social-club/";

  const lastRunHtml = !lastRun
    ? "<p>No runs yet.</p>"
    : `
      <div class="result-box">
        <div><strong>Status:</strong> ${esc(lastRun.status || "ok")}</div>
        <div><strong>Trigger:</strong> ${esc(lastRun.trigger || "unknown")}</div>
        <div><strong>Checked at:</strong> ${esc(lastRun.checkedAt || "-")}</div>
        <div><strong>Available dates:</strong> ${esc((lastRun.availableDates || []).join(", ") || "None")}</div>
        <div><strong>Notification sent:</strong> ${lastRun.notificationSent ? "Yes" : "No"}</div>
        <div><strong>Notification error:</strong> ${esc(lastRun.notificationError || "-")}</div>
        <div><strong>Message:</strong> ${esc(lastRun.message || "-")}</div>
      </div>
    `;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Reservation Watcher</title>
  <link rel="stylesheet" href="/style.css" />
</head>
<body>
  <main class="container">
    <h1>Reservation Watcher</h1>
    <p>Configure your date range and email. The server checks periodically and emails you when availability appears.</p>

    ${flash ? `<div class="flash">${esc(flash)}</div>` : ""}
    ${!smtpReady ? "<div class=\"flash flash-warn\">SMTP is not fully configured. Email notifications will fail until SMTP env vars are set.</div>" : ""}

    <section class="card">
      <h2>Watch Configuration</h2>
      <form method="post" action="/watch" class="form-grid">
        <label>Restaurant URL (fixed)
          <input type="url" value="${esc(fixedRestaurantUrl)}" readonly />
        </label>
        <label>Start date
          <input type="date" name="startDate" required value="${esc(current.startDate || "")}" />
        </label>
        <label>End date
          <input type="date" name="endDate" required value="${esc(current.endDate || "")}" />
        </label>
        <label>Notification email
          <input type="email" name="notificationEmail" required value="${esc(current.notificationEmail || "")}" />
        </label>
        <label>Party size
          <input type="number" min="1" max="20" name="partySize" value="${esc(current.partySize || process.env.PARTY_SIZE || "2")}" />
        </label>
        <label>Check interval (minutes)
          <input type="number" min="1" max="720" name="checkIntervalMinutes" value="${esc(String(current.checkIntervalMinutes || schedulerState.intervalMinutes || 5))}" />
        </label>
        <button type="submit">Save watch</button>
      </form>
    </section>

    <section class="card">
      <h2>Scheduler</h2>
      <p>Interval: every ${esc(String(schedulerState.intervalMinutes))} minute(s)</p>
      <form method="post" action="/run-now">
        <button type="submit">Run check now</button>
      </form>
      ${lastRunHtml}
    </section>
  </main>
</body>
</html>`;
}

app.get("/", async (req, res) => {
  const watch = await getWatchConfig();
  const schedulerState = scheduler.getState();
  const flash = req.query.msg ? String(req.query.msg) : "";
  const smtpReady = canSendEmail(smtpConfigFromEnv());

  res.status(200).send(renderHome({ watch, schedulerState, flash, smtpReady }));
});

app.post("/watch", async (req, res) => {
  const restaurantUrl = process.env.RESTAURANT_URL || "https://restaurante.covermanager.com/mantequilla-social-club/";
  const startDate = String(req.body.startDate || "").trim();
  const endDate = String(req.body.endDate || "").trim();
  const notificationEmail = String(req.body.notificationEmail || "").trim();
  const partySize = Number(req.body.partySize || 2);
  const checkIntervalMinutes = toPositiveInt(req.body.checkIntervalMinutes, scheduler.getState().intervalMinutes || 5);

  if (!restaurantUrl) {
    return res.redirect("/?msg=Restaurant%20URL%20is%20required");
  }
  if (!isValidDate(startDate) || !isValidDate(endDate)) {
    return res.redirect("/?msg=Dates%20must%20be%20valid%20(YYYY-MM-DD)");
  }
  if (endDate < startDate) {
    return res.redirect("/?msg=End%20date%20must%20be%20after%20or%20equal%20to%20start%20date");
  }
  if (!isValidEmail(notificationEmail)) {
    return res.redirect("/?msg=Notification%20email%20is%20invalid");
  }

  await saveWatchConfig({
    restaurantUrl,
    startDate,
    endDate,
    notificationEmail,
    partySize: Number.isFinite(partySize) && partySize > 0 ? partySize : 2,
    checkIntervalMinutes,
  });

  scheduler.setIntervalMinutes(checkIntervalMinutes);

  res.redirect("/?msg=Watch%20saved");
});

app.post("/run-now", async (_req, res) => {
  await scheduler.runNow();
  res.redirect("/?msg=Manual%20check%20completed");
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  scheduler.start();
  console.log(`Reservation watcher web app listening on port ${port}`);
});
