const nodemailer = require("nodemailer");

function smtpConfigFromEnv() {
  const port = Number(process.env.SMTP_PORT || 587);
  return {
    host: process.env.SMTP_HOST || "",
    port,
    secure: String(process.env.SMTP_SECURE || "false").toLowerCase() === "true",
    user: process.env.SMTP_USER || "",
    pass: process.env.SMTP_PASS || "",
    from: process.env.ALERT_FROM || "",
  };
}

function canSendEmail(smtp) {
  return Boolean(smtp.host && smtp.port && smtp.user && smtp.pass && smtp.from);
}

async function sendAvailabilityEmail({ to, subject, text }) {
  const smtp = smtpConfigFromEnv();
  if (!canSendEmail(smtp)) {
    throw new Error("SMTP is not fully configured. Set SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS, ALERT_FROM.");
  }

  const transporter = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: {
      user: smtp.user,
      pass: smtp.pass,
    },
  });

  await transporter.sendMail({
    from: smtp.from,
    to,
    subject,
    text,
  });
}

module.exports = {
  sendAvailabilityEmail,
  smtpConfigFromEnv,
  canSendEmail,
};
