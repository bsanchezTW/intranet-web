// email-listener.js
//
// Escucha el buzón IMAP de soporte y crea un ticket en `support_tickets` por
// cada correo nuevo. La lógica (UID, reconexión, filtros) vive en
// services/tickets/emailIntake.js.

require("./config/env");
const { isFeatureEnabled } = require("./config/features");
const { getCurrentCountry } = require("./config/country");
const logger = require("./utils/logger");

if (!isFeatureEnabled("supportTickets")) {
  logger.info("correo", `Tickets no disponibles en ${getCurrentCountry()}. Saliendo.`);
  process.exit(0);
}

const { ImapFlow } = require("imapflow");
const { simpleParser } = require("mailparser");
const db = require("./db");
const { getCountryDbBinding } = require("./config/supabaseProjects");
const { createEmailIntake, createEmailListener } = require("./services/tickets/emailIntake");

const intake = createEmailIntake({
  db,
  schema: getCountryDbBinding(getCurrentCountry()).schema,
  parse: (source) => simpleParser(source),
  // Los correos que manda la propia casilla (notificaciones) no son tickets.
  ownAddress: process.env.IMAP_USER,
  logger,
});

const listener = createEmailListener({
  createClient: () =>
    new ImapFlow({
      host: process.env.IMAP_HOST || "outlook.office365.com",
      port: process.env.IMAP_PORT ? Number(process.env.IMAP_PORT) : 993,
      secure: true,
      auth: { user: process.env.IMAP_USER, pass: process.env.IMAP_PASS },
      logger: false,
    }),
  intake,
  logger,
});

async function shutdown(signal) {
  logger.info("correo", `${signal}: cerrando`);
  await listener.stop();
  await db.pool.end().catch(() => {});
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

listener.run().catch((err) => {
  logger.error("correo", err);
  process.exit(1);
});
