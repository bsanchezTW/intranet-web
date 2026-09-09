const crypto = require("crypto");
const express = require("express");
const router = express.Router();
const { runDbProbe } = require("../services/dbDiagnostics");
const logger = require("../utils/logger");

function safeEqualString(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function canSeeDbTest(req) {
  const requiredKey = String(process.env.ADMIN_DB_TEST_KEY || "").trim();
  if (!requiredKey) return true;
  return safeEqualString(String(req.query.key || ""), requiredKey);
}

router.get("/admin-test-db", async (req, res, next) => {
  if (!canSeeDbTest(req)) {
    return res.status(404).render("404", { titulo: "Página no encontrada" });
  }

  try {
    const report = await runDbProbe();
    res.set("Cache-Control", "no-store");
    res.set("X-Robots-Tag", "noindex, nofollow");
    res.set("Referrer-Policy", "no-referrer");
    return res.render("admin-test-db", {
      layout: false,
      titulo: "Diagnóstico BD",
      report,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    logger.error("db", err);
    return next(err);
  }
});

module.exports = router;
