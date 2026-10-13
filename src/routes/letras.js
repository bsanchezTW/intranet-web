const express = require("express");

const router = express.Router();
const db = require("../db");
const bills = require("../services/billsOfExchange/billOfExchangeService");
const { renderBillsPdf } = require("../services/billsOfExchange/billOfExchangePdf");
const {
  BILL_CURRENCY,
  BILL_DRAWER,
  DEFAULT_ISSUE_PLACE,
  DEFAULT_INTERVAL_DAYS,
  MAX_INSTALLMENTS,
  formatBillNumber,
  formatBillMoney,
  billDisplayStatus,
} = require("../constants/billOfExchange");
const { amountToWords } = require("../utils/amountInWords");
const { todayInCountry, formatDisplay, addDays } = require("../utils/vacationDateUtils");

/**
 * Letras de cambio (Finanzas, Perú).
 *
 * Se monta en /letras y no bajo /procesos por la misma razón que /gastos: el
 * router de procesos termina en un catch-all que se tragaría las rutas hijas.
 * El acceso (personal de Finanzas) lo resuelve requireFinanceStaff en app.js.
 */

const VIEW_HELPERS = {
  formatBillMoney,
  formatBillNumber,
  billDisplayStatus,
  formatBillDate: (value) => (value ? formatDisplay(value).replace(/-/g, "/") : "—"),
  currency: BILL_CURRENCY,
  drawer: BILL_DRAWER,
};

const EXTRA_CSS = ["/css/procesos.css?v=20260916m", "/css/letras.css?v=20261013a"];

function flashFrom(req) {
  return {
    success: req.query.ok === "1" ? String(req.query.msg || "Operación exitosa") : null,
    error: req.query.error ? String(req.query.error) : null,
  };
}

function parseId(value) {
  const raw = String(value ?? "");
  return /^\d{1,15}$/.test(raw) ? Number(raw) : null;
}

/** Sin `batchId` (lote eliminado) el historial enlaza al listado. */
async function logChange(userId, action, batchId) {
  try {
    await db.query(
      "INSERT INTO change_log (user_id, action, section, link_path) VALUES ($1, $2, $3, $4)",
      [userId, action, "Letras de cambio", batchId ? `/letras/lote/${batchId}` : "/letras"],
    );
  } catch (err) {
    console.error("[Letras] No se pudo registrar en el historial:", err.message);
  }
}

function sendPdf(res, buffer, filename) {
  res.set("Content-Type", "application/pdf");
  res.set("Content-Disposition", `inline; filename="${filename}"`);
  res.set("Cache-Control", "private, no-store");
  res.send(buffer);
}

// ---------------------------------------------------------------------------
// Listado
// ---------------------------------------------------------------------------

router.get("/", async (req, res) => {
  try {
    const today = todayInCountry();
    const q = String(req.query.q || "").trim().slice(0, 80);
    const estado = ["vigentes", "vencidas", "pagadas", "anuladas"].includes(req.query.estado)
      ? req.query.estado
      : "";
    const [letras, resumen] = await Promise.all([
      bills.listBills({ q, estado, today }),
      bills.summary(today),
    ]);

    res.render("letras/index", {
      titulo: "Letras de cambio",
      letras,
      resumen,
      filtros: { q, estado },
      today,
      ...flashFrom(req),
      ...VIEW_HELPERS,
      extraCss: EXTRA_CSS,
    });
  } catch (err) {
    console.error("[Letras] Error listando:", err);
    res.status(500).send("Error cargando las letras de cambio");
  }
});

// ---------------------------------------------------------------------------
// Emisión
// ---------------------------------------------------------------------------

function defaultFormValues(today) {
  return {
    issue_date: today,
    issue_place: DEFAULT_ISSUE_PLACE,
    installments_count: "1",
    interval_days: String(DEFAULT_INTERVAL_DAYS),
    first_due_date: addDays(today, DEFAULT_INTERVAL_DAYS),
    cuotas: [],
  };
}

/**
 * Formulario de emisión, o de edición si viene `lote`: en ese caso las
 * cuotas se pintan desde las letras del lote (las vigentes con lo que traiga
 * `values`) y no hay generador ni número inicial.
 */
async function renderForm(res, { values, errors = {}, status = 200, lote = null }) {
  const year = Number(String(values.issue_date || todayInCountry()).slice(0, 4)) || new Date().getFullYear();
  const [aceptantes, siguiente] = await Promise.all([
    bills.listAcceptors(),
    lote ? null : bills.nextNumberFor(year),
  ]);
  res.status(status).render("letras/nueva", {
    titulo: lote ? "Editar letras de cambio" : "Emitir letras de cambio",
    values,
    errors,
    aceptantes,
    lote,
    today: todayInCountry(),
    siguiente: lote ? null : { year, seq: siguiente, number: formatBillNumber(year, siguiente) },
    maxCuotas: MAX_INSTALLMENTS,
    ...VIEW_HELPERS,
    extraCss: EXTRA_CSS,
    extraJs: ["/js/letras-form.js?v=20261013a"],
  });
}

/** Valores del formulario de edición a partir del lote guardado. */
function batchFormValues(lote) {
  const fields = [
    "invoice_ref", "issue_date", "issue_place",
    "acceptor_doc", "acceptor_name", "acceptor_address", "acceptor_locality", "acceptor_phone",
    "guarantor_name", "guarantor_doc", "guarantor_address", "guarantor_locality", "guarantor_phone",
    "bank_name", "bank_office", "bank_account", "bank_dc",
  ];
  const values = Object.fromEntries(fields.map((f) => [f, lote[f] ?? ""]));
  values.cuotas = lote.bills
    .filter((b) => b.status === "issued")
    .map((b) => ({ id: Number(b.id), installment: b.installment, due_date: b.due_date, amount: Number(b.amount).toFixed(2) }));
  return values;
}

router.get("/nueva", async (req, res) => {
  try {
    await renderForm(res, { values: defaultFormValues(todayInCountry()) });
  } catch (err) {
    console.error("[Letras] Error cargando el formulario:", err);
    res.status(500).send("Error cargando el formulario");
  }
});

router.post("/", async (req, res) => {
  const user = req.session.user;
  const { values, errors, ok } = bills.normalizeBatchInput(req.body);
  try {
    if (!ok) return await renderForm(res, { values, errors, status: 422 });

    const lote = await bills.createBatch(values, user.id);
    const rango = lote.count === 1 ? lote.first : `${lote.first} a ${lote.last}`;
    await logChange(user.id, `Emitió ${lote.count === 1 ? "la letra" : `${lote.count} letras`} ${rango} a ${values.acceptor_name}`, lote.id);
    const msg = lote.count === 1 ? `Letra ${lote.first} emitida.` : `${lote.count} letras emitidas (${rango}).`;
    return res.redirect(`/letras/lote/${lote.id}?ok=1&msg=${encodeURIComponent(msg)}`);
  } catch (err) {
    if (err.code === "BILL_NUMBER_TAKEN") {
      return renderForm(res, { values, errors: { start_number: err.message }, status: 409 });
    }
    console.error("[Letras] Error emitiendo:", err);
    return res.status(500).send("Error emitiendo las letras");
  }
});

// ---------------------------------------------------------------------------
// API del formulario
// ---------------------------------------------------------------------------

/** Datos del último lote de ese RUC/DNI para autocompletar. */
router.get("/api/aceptante", async (req, res) => {
  try {
    const data = await bills.findAcceptor(req.query.doc);
    if (!data) return res.status(404).json({ error: "Sin registros previos" });
    return res.json(data);
  } catch (err) {
    console.error("[Letras] Error buscando aceptante:", err);
    return res.status(500).json({ error: "Error buscando el aceptante" });
  }
});

/** Próximo número libre de un año, para la vista previa de las cuotas. */
router.get("/api/siguiente", async (req, res) => {
  const year = Number(req.query.anio);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    return res.status(400).json({ error: "Año inválido" });
  }
  try {
    const seq = await bills.nextNumberFor(year);
    return res.json({ year, seq, number: formatBillNumber(year, seq) });
  } catch (err) {
    console.error("[Letras] Error calculando el siguiente número:", err);
    return res.status(500).json({ error: "Error calculando el número" });
  }
});

// ---------------------------------------------------------------------------
// Edición y eliminación
// ---------------------------------------------------------------------------

router.get("/lote/:id/editar", async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(404).render("404", { titulo: "Página no encontrada" });
  try {
    const lote = await bills.getBatch(id);
    if (!lote) return res.status(404).render("404", { titulo: "Página no encontrada" });
    return await renderForm(res, { values: batchFormValues(lote), lote });
  } catch (err) {
    console.error("[Letras] Error cargando la edición:", err);
    return res.status(500).send("Error cargando el formulario");
  }
});

router.post("/lote/:id", async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(404).render("404", { titulo: "Página no encontrada" });
  const user = req.session.user;
  try {
    const lote = await bills.getBatch(id);
    if (!lote) return res.status(404).render("404", { titulo: "Página no encontrada" });
    const { values, errors, ok } = bills.normalizeBatchInput(req.body, { editing: true });
    if (!ok) return await renderForm(res, { values, errors, lote, status: 422 });
    try {
      await bills.updateBatch(id, values, user.id);
    } catch (err) {
      if (err.code !== "BILL_EDIT_INVALID") throw err;
      return await renderForm(res, { values, errors: { [err.field]: err.message }, lote, status: 409 });
    }
    const rango = lote.bills.length === 1 ? lote.bills[0].number : `${lote.bills[0].number} a ${lote.bills[lote.bills.length - 1].number}`;
    await logChange(user.id, `Editó ${lote.bills.length === 1 ? "la letra" : "las letras"} ${rango} de ${values.acceptor_name}`, id);
    return res.redirect(`/letras/lote/${id}?ok=1&msg=${encodeURIComponent("Cambios guardados.")}`);
  } catch (err) {
    console.error("[Letras] Error editando el lote:", err);
    return res.status(500).send("Error guardando los cambios");
  }
});

router.post("/lote/:id/eliminar", async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).send("Solicitud inválida");
  try {
    const deleted = await bills.deleteBatch(id);
    if (!deleted) return res.status(404).send("No encontrado");
    const { numbers, acceptorName } = deleted;
    const rango = numbers.length === 1 ? numbers[0] : `${numbers[0]} a ${numbers[numbers.length - 1]}`;
    await logChange(req.session.user.id, `Eliminó ${numbers.length === 1 ? "la letra" : `${numbers.length} letras`} ${rango} de ${acceptorName}`, null);
    const msg = numbers.length === 1 ? `Letra ${rango} eliminada.` : `${numbers.length} letras eliminadas (${rango}).`;
    return res.redirect(`/letras?ok=1&msg=${encodeURIComponent(msg)}`);
  } catch (err) {
    console.error("[Letras] Error eliminando el lote:", err);
    return res.status(500).send("Error eliminando las letras");
  }
});

/** Elimina una letra. `volver=lista` regresa al listado en vez de al lote. */
router.post("/:id/eliminar", async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).send("Solicitud inválida");
  try {
    const deleted = await bills.deleteBill(id);
    if (!deleted) return res.status(404).send("No encontrado");
    await logChange(req.session.user.id, `Eliminó la letra ${deleted.number}`, deleted.batchDeleted ? null : deleted.batchId);
    const msg = encodeURIComponent(`Letra ${deleted.number} eliminada.`);
    const back = deleted.batchDeleted || req.body.volver === "lista" ? "/letras" : `/letras/lote/${deleted.batchId}`;
    return res.redirect(`${back}?ok=1&msg=${msg}`);
  } catch (err) {
    console.error("[Letras] Error eliminando la letra:", err);
    return res.status(500).send("Error eliminando la letra");
  }
});

// ---------------------------------------------------------------------------
// Lote: detalle, impresión y estados
// ---------------------------------------------------------------------------

router.get("/lote/:id", async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(404).render("404", { titulo: "Página no encontrada" });
  try {
    const lote = await bills.getBatch(id);
    if (!lote) return res.status(404).render("404", { titulo: "Página no encontrada" });
    res.render("letras/lote", {
      titulo: `Letras de ${lote.acceptor_name}`,
      lote,
      today: todayInCountry(),
      totalEnLetras: amountToWords(lote.total_amount, BILL_CURRENCY.words),
      ...flashFrom(req),
      ...VIEW_HELPERS,
      extraCss: EXTRA_CSS,
    });
  } catch (err) {
    console.error("[Letras] Error cargando el lote:", err);
    res.status(500).send("Error cargando las letras");
  }
});

/** Todas las letras del lote que no están anuladas, una por hoja. */
router.get("/lote/:id/pdf", async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(404).send("No encontrado");
  try {
    const lote = await bills.getBatch(id);
    if (!lote) return res.status(404).send("No encontrado");
    const imprimibles = lote.bills
      .filter((b) => b.status !== "voided")
      .map((b) => bills.toPrintable(lote, b));
    if (!imprimibles.length) {
      return res.redirect(`/letras/lote/${id}?error=${encodeURIComponent("Todas las letras del lote están anuladas.")}`);
    }
    const first = imprimibles[0].number;
    const last = imprimibles[imprimibles.length - 1].number;
    const name = imprimibles.length === 1 ? first : `${first}_a_${last}`;
    const pdf = await renderBillsPdf(imprimibles, { title: `Letras de cambio ${name}` });
    return sendPdf(res, pdf, `${name}.pdf`);
  } catch (err) {
    console.error("[Letras] Error generando el PDF del lote:", err);
    return res.status(500).send("Error generando el PDF");
  }
});

/** Una letra suelta. Si está anulada sale con la marca ANULADA. */
router.get("/:id/pdf", async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(404).send("No encontrado");
  try {
    const found = await bills.getBill(id);
    if (!found) return res.status(404).send("No encontrado");
    const printable = bills.toPrintable(found.batch, found.bill);
    const pdf = await renderBillsPdf([printable], { title: `Letra de cambio ${printable.number}` });
    return sendPdf(res, pdf, `${printable.number}.pdf`);
  } catch (err) {
    console.error("[Letras] Error generando el PDF:", err);
    return res.status(500).send("Error generando el PDF");
  }
});

const ACTION_MESSAGES = {
  pagar: (n) => `Letra ${n} marcada como pagada.`,
  anular: (n) => `Letra ${n} anulada.`,
  reactivar: (n) => `Letra ${n} vuelve a estar vigente.`,
};

const ACTION_LOG = {
  pagar: (n) => `Marcó como pagada la letra ${n}`,
  anular: (n) => `Anuló la letra ${n}`,
  reactivar: (n) => `Revirtió el pago de la letra ${n}`,
};

router.post("/:id/estado", async (req, res) => {
  const id = parseId(req.params.id);
  const accion = String(req.body.accion || "");
  if (!id || !ACTION_MESSAGES[accion]) return res.status(400).send("Solicitud inválida");
  try {
    const found = await bills.getBill(id);
    if (!found) return res.status(404).send("No encontrado");
    const back = `/letras/lote/${found.batch.id}`;
    const updated = await bills.changeStatus(id, accion, req.session.user.id, req.body.motivo);
    if (!updated) {
      return res.redirect(`${back}?error=${encodeURIComponent("La letra ya no está en un estado que permita esa acción.")}`);
    }
    await logChange(req.session.user.id, ACTION_LOG[accion](updated.number), found.batch.id);
    return res.redirect(`${back}?ok=1&msg=${encodeURIComponent(ACTION_MESSAGES[accion](updated.number))}`);
  } catch (err) {
    console.error("[Letras] Error cambiando el estado:", err);
    return res.status(500).send("Error actualizando la letra");
  }
});

module.exports = router;
