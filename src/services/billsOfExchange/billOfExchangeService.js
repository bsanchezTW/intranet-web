const db = require("../../db");
const {
  BILL_CURRENCY,
  BILL_STATUS,
  DEFAULT_ISSUE_PLACE,
  DEFAULT_INTERVAL_DAYS,
  MAX_INSTALLMENTS,
  MAX_INTERVAL_DAYS,
  formatBillNumber,
} = require("../../constants/billOfExchange");
const { amountToWords } = require("../../utils/amountInWords");
const { toDateOnly, addDays } = require("../../utils/vacationDateUtils");

/**
 * Letras de cambio: validación del formulario, cronograma de cuotas,
 * numeración correlativa y consultas del listado.
 *
 * normalizeBatchInput y planInstallments son puras para poder probarlas sin
 * base; el resto habla con Postgres.
 */

// Serializa la asignación de números entre peticiones simultáneas. Es una
// llave de toda la base: chile y peru comparten servidor, pero sólo Perú
// emite letras.
const NUMBERING_LOCK_KEY = 7215001;
const MAX_SEQ = 99999;

const TEXT_LIMITS = {
  acceptor_name: 200,
  acceptor_address: 300,
  acceptor_locality: 120,
  acceptor_phone: 30,
  guarantor_name: 200,
  guarantor_address: 300,
  guarantor_locality: 120,
  guarantor_phone: 30,
  bank_name: 80,
  bank_office: 40,
  bank_account: 40,
  bank_dc: 4,
  invoice_ref: 40,
  issue_place: 80,
};

function cleanText(value, max) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return max ? text.slice(0, max) : text;
}

/** RUC (11 dígitos) o DNI (8). Devuelve sólo los dígitos, o null si no calza. */
function normalizeDoc(value) {
  const digits = String(value ?? "").replace(/\D/g, "");
  return digits.length === 8 || digits.length === 11 ? digits : null;
}

/** Monto a céntimos enteros. Acepta "6,942.40", "6942.40" y "6942,40". */
function parseCents(value) {
  let raw = String(value ?? "").replace(/\s/g, "");
  if (!raw) return null;
  if (raw.includes(",") && !raw.includes(".")) raw = raw.replace(",", ".");
  else raw = raw.replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) return null;
  const cents = Math.round(Number(raw) * 100);
  return Number.isSafeInteger(cents) ? cents : null;
}

function centsToDecimal(cents) {
  return (cents / 100).toFixed(2);
}

function parsePositiveInt(value) {
  const raw = String(value ?? "").trim();
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function isValidIsoDate(value) {
  const iso = toDateOnly(value);
  if (!iso || iso !== String(value).trim()) return false;
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/**
 * Cronograma de cuotas iguales. Los céntimos que no se reparten parejo van a
 * la última letra, para que la suma sea exactamente el total.
 *
 * Primera cuota en `firstDueDate`; las siguientes cada `intervalDays` días.
 */
function planInstallments({ totalCents, count, firstDueDate, intervalDays }) {
  const base = Math.floor(totalCents / count);
  const remainder = totalCents - base * count;
  return Array.from({ length: count }, (_, i) => ({
    installment: i + 1,
    due_date: addDays(firstDueDate, i * intervalDays),
    cents: i === count - 1 ? base + remainder : base,
  }));
}

/** El body urlencoded trae cuotas[0][due_date]… como arreglo u objeto. */
function rawInstallments(body) {
  const raw = body && body.cuotas;
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : Object.values(raw);
  return list.filter((row) => row && (String(row.due_date ?? "").trim() || String(row.amount ?? "").trim()));
}

/**
 * Valida el formulario de emisión.
 *
 * Devuelve `values` (lo que se vuelve a pintar en el formulario si hay
 * errores, y lo que se guarda si no los hay) y `errors` por campo. Si el
 * formulario trae las cuotas ya editadas, se respetan; si no (sin JS), se
 * calculan desde el total y la cantidad.
 */
function normalizeBatchInput(body = {}) {
  const errors = {};
  const values = {};

  for (const [field, max] of Object.entries(TEXT_LIMITS)) {
    values[field] = cleanText(body[field], max);
  }
  values.issue_place = values.issue_place || DEFAULT_ISSUE_PLACE;

  // --- Aceptante --------------------------------------------------------
  const acceptorDoc = normalizeDoc(body.acceptor_doc);
  values.acceptor_doc = acceptorDoc || cleanText(body.acceptor_doc, 15);
  if (!acceptorDoc) errors.acceptor_doc = "Ingresa un RUC de 11 dígitos o un DNI de 8.";
  if (!values.acceptor_name) errors.acceptor_name = "Ingresa la razón social o el nombre del aceptante.";
  if (!values.acceptor_address) errors.acceptor_address = "Ingresa el domicilio del aceptante.";

  // --- Aval: opcional, pero si se nombra hay que identificarlo ------------
  const guarantorDocRaw = cleanText(body.guarantor_doc, 15);
  const guarantorDoc = guarantorDocRaw ? normalizeDoc(guarantorDocRaw) : null;
  values.guarantor_doc = guarantorDoc || guarantorDocRaw;
  if (guarantorDocRaw && !guarantorDoc) {
    errors.guarantor_doc = "El documento del aval debe ser un RUC de 11 dígitos o un DNI de 8.";
  }
  const hasGuarantor = Boolean(
    values.guarantor_name || guarantorDocRaw || values.guarantor_address ||
      values.guarantor_locality || values.guarantor_phone,
  );
  if (hasGuarantor && !values.guarantor_name) {
    errors.guarantor_name = "Ingresa el nombre del aval o deja vacíos sus datos.";
  }
  if (hasGuarantor && !guarantorDocRaw) {
    errors.guarantor_doc = "Ingresa el documento del aval.";
  }

  // --- Condiciones -------------------------------------------------------
  // Moneda única: lo que diga el formulario no cuenta.
  values.currency_code = BILL_CURRENCY.code;

  values.issue_date = String(body.issue_date || "").trim();
  if (!isValidIsoDate(values.issue_date)) errors.issue_date = "Ingresa la fecha de giro.";

  values.total_amount = cleanText(body.total_amount, 20);
  values.installments_count = cleanText(body.installments_count, 3);
  values.first_due_date = String(body.first_due_date || "").trim();
  values.interval_days = cleanText(body.interval_days, 4) || String(DEFAULT_INTERVAL_DAYS);
  values.start_number = cleanText(body.start_number, 6);

  const startNumber = values.start_number ? parsePositiveInt(values.start_number) : null;
  if (values.start_number && (!startNumber || startNumber > MAX_SEQ)) {
    errors.start_number = `El número inicial debe ser un entero entre 1 y ${MAX_SEQ}.`;
  }

  // --- Cuotas ------------------------------------------------------------
  let cuotas = [];
  const edited = rawInstallments(body);
  if (edited.length) {
    if (edited.length > MAX_INSTALLMENTS) {
      errors.cuotas = `Máximo ${MAX_INSTALLMENTS} letras por emisión.`;
    }
    cuotas = edited.slice(0, MAX_INSTALLMENTS).map((row, i) => ({
      installment: i + 1,
      due_date: String(row.due_date || "").trim(),
      amount: cleanText(row.amount, 20),
      cents: parseCents(row.amount),
    }));
  } else {
    const totalCents = parseCents(values.total_amount);
    const count = parsePositiveInt(values.installments_count);
    const interval = parsePositiveInt(values.interval_days);
    if (!totalCents) errors.total_amount = "Ingresa el importe total.";
    if (!count || count > MAX_INSTALLMENTS) {
      errors.installments_count = `Indica entre 1 y ${MAX_INSTALLMENTS} letras.`;
    }
    if (!interval || interval > MAX_INTERVAL_DAYS) {
      errors.interval_days = `Indica entre 1 y ${MAX_INTERVAL_DAYS} días.`;
    }
    let firstDue = values.first_due_date;
    if (!firstDue && isValidIsoDate(values.issue_date) && interval) {
      firstDue = addDays(values.issue_date, interval);
    }
    if (!isValidIsoDate(firstDue)) {
      errors.first_due_date = "Ingresa el primer vencimiento.";
    }
    if (!Object.keys(errors).some((k) => ["total_amount", "installments_count", "interval_days", "first_due_date"].includes(k))) {
      if (totalCents < count) {
        errors.total_amount = "El importe no alcanza para tantas letras.";
      } else {
        cuotas = planInstallments({ totalCents, count, firstDueDate: firstDue, intervalDays: interval }).map(
          (c) => ({ ...c, amount: centsToDecimal(c.cents) }),
        );
      }
    }
  }

  const cuotaErrors = [];
  cuotas.forEach((c, i) => {
    if (!isValidIsoDate(c.due_date)) {
      cuotaErrors.push(`Letra ${i + 1}: falta el vencimiento.`);
    } else if (isValidIsoDate(values.issue_date) && c.due_date < values.issue_date) {
      cuotaErrors.push(`Letra ${i + 1}: vence antes de la fecha de giro.`);
    }
    if (!c.cents || c.cents <= 0) cuotaErrors.push(`Letra ${i + 1}: importe inválido.`);
  });
  if (cuotaErrors.length) errors.cuotas = cuotaErrors.join(" ");
  if (!cuotas.length && !errors.cuotas && edited.length) errors.cuotas = "Agrega al menos una letra.";

  values.cuotas = cuotas.map(({ installment, due_date, amount }) => ({ installment, due_date, amount }));
  const totalCents = cuotas.reduce((sum, c) => sum + (c.cents || 0), 0);
  values.computed_total = centsToDecimal(totalCents);
  values.startNumber = startNumber;

  return { values, errors, ok: Object.keys(errors).length === 0 };
}

// ---------------------------------------------------------------------------
// Base de datos
// ---------------------------------------------------------------------------

async function nextSeq(queryable, year) {
  const { rows } = await queryable.query(
    "SELECT COALESCE(MAX(number_seq), 0) + 1 AS next FROM bills_of_exchange WHERE number_year = $1",
    [year],
  );
  return Number(rows[0].next);
}

/** Próximo correlativo libre del año, para mostrarlo en el formulario. */
async function nextNumberFor(year) {
  return nextSeq(db, year);
}

class BillNumberError extends Error {
  constructor(message) {
    super(message);
    this.code = "BILL_NUMBER_TAKEN";
  }
}

/**
 * Emite el lote completo en una transacción. `values` es la salida de
 * normalizeBatchInput con ok = true.
 */
async function createBatch(values, userId) {
  const year = Number(values.issue_date.slice(0, 4));
  const count = values.cuotas.length;
  const client = await db.getClient();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [NUMBERING_LOCK_KEY]);

    let start = values.startNumber;
    if (start) {
      const { rows } = await client.query(
        `SELECT number_seq FROM bills_of_exchange
          WHERE number_year = $1 AND number_seq BETWEEN $2 AND $3
          ORDER BY number_seq LIMIT 1`,
        [year, start, start + count - 1],
      );
      if (rows.length) {
        throw new BillNumberError(
          `La letra ${formatBillNumber(year, rows[0].number_seq)} ya existe. Elige otro número inicial o deja el campo vacío para usar el siguiente libre.`,
        );
      }
    } else {
      start = await nextSeq(client, year);
    }
    if (start + count - 1 > MAX_SEQ) {
      throw new BillNumberError(`La numeración de ${year} supera ${MAX_SEQ}.`);
    }

    const total = values.cuotas.reduce((sum, c) => sum + Math.round(Number(c.amount) * 100), 0);
    const { rows: batchRows } = await client.query(
      `INSERT INTO bill_of_exchange_batches (
         invoice_ref, issue_date, issue_place, currency_code, total_amount,
         acceptor_name, acceptor_doc, acceptor_address, acceptor_locality, acceptor_phone,
         guarantor_name, guarantor_doc, guarantor_address, guarantor_locality, guarantor_phone,
         bank_name, bank_office, bank_account, bank_dc, created_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
       RETURNING id`,
      [
        values.invoice_ref || null,
        values.issue_date,
        values.issue_place,
        values.currency_code,
        centsToDecimal(total),
        values.acceptor_name,
        values.acceptor_doc,
        values.acceptor_address,
        values.acceptor_locality || null,
        values.acceptor_phone || null,
        values.guarantor_name || null,
        values.guarantor_doc || null,
        values.guarantor_address || null,
        values.guarantor_locality || null,
        values.guarantor_phone || null,
        values.bank_name || null,
        values.bank_office || null,
        values.bank_account || null,
        values.bank_dc || null,
        userId ?? null,
      ],
    );
    const batchId = batchRows[0].id;

    await client.query(
      `INSERT INTO bills_of_exchange (batch_id, installment, number_year, number_seq, due_date, amount, updated_by)
       SELECT $1::bigint, s.installment::smallint, $2::smallint, $3::int + s.installment::int - 1,
              s.due_date, s.amount, $6::int
         FROM UNNEST($4::date[], $5::numeric[]) WITH ORDINALITY AS s(due_date, amount, installment)`,
      [
        batchId,
        year,
        start,
        values.cuotas.map((c) => c.due_date),
        values.cuotas.map((c) => Number(c.amount).toFixed(2)),
        userId ?? null,
      ],
    );

    await client.query("COMMIT");
    return {
      id: Number(batchId),
      first: formatBillNumber(year, start),
      last: formatBillNumber(year, start + count - 1),
      count,
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    // Carrera improbable (el lock la evita), pero el UNIQUE es quien manda.
    if (err.code === "23505") {
      throw new BillNumberError("Ese número de letra acaba de usarse. Vuelve a intentarlo.");
    }
    throw err;
  } finally {
    client.release();
  }
}

const BILL_COLUMNS = `
  b.id, b.batch_id, b.installment, b.number_year, b.number_seq,
  b.due_date::text AS due_date, b.amount, b.status, b.void_reason,
  b.paid_at, b.voided_at`;

const BATCH_COLUMNS = `
  bt.id, bt.invoice_ref, bt.issue_date::text AS issue_date, bt.issue_place,
  bt.currency_code, bt.total_amount,
  bt.acceptor_name, bt.acceptor_doc, bt.acceptor_address, bt.acceptor_locality, bt.acceptor_phone,
  bt.guarantor_name, bt.guarantor_doc, bt.guarantor_address, bt.guarantor_locality, bt.guarantor_phone,
  bt.bank_name, bt.bank_office, bt.bank_account, bt.bank_dc,
  bt.created_at, bt.created_by,
  NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), '') AS created_by_name`;

function withNumber(row) {
  return { ...row, number: formatBillNumber(row.number_year, row.number_seq) };
}

const STATUS_FILTERS = {
  vigentes: "b.status = 'issued' AND b.due_date >= $2::date",
  vencidas: "b.status = 'issued' AND b.due_date < $2::date",
  pagadas: "b.status = 'paid'",
  anuladas: "b.status = 'voided'",
};

/** Listado con búsqueda libre (aceptante, documento, factura o número). */
async function listBills({ q = "", estado = "", today }) {
  const term = cleanText(q, 80);
  const filter = STATUS_FILTERS[estado] || "TRUE";
  const { rows } = await db.query(
    `SELECT ${BILL_COLUMNS},
            bt.acceptor_name, bt.acceptor_doc, bt.invoice_ref,
            bt.issue_date::text AS issue_date, bt.currency_code,
            (SELECT COUNT(*)::int FROM bills_of_exchange x WHERE x.batch_id = b.batch_id) AS installments_total,
            (b.status = 'issued' AND b.due_date < $2::date) AS overdue
       FROM bills_of_exchange b
       JOIN bill_of_exchange_batches bt ON bt.id = b.batch_id
      WHERE ($1::text IS NULL
             OR bt.acceptor_name ILIKE $1 OR bt.acceptor_doc ILIKE $1
             OR bt.invoice_ref ILIKE $1
             OR ('LT-' || LPAD(b.number_seq::text, 5, '0') || '-' || b.number_year) ILIKE $1)
        AND ${filter}
      ORDER BY b.number_year DESC, b.number_seq DESC
      LIMIT 500`,
    [term ? `%${term}%` : null, today],
  );
  return rows.map(withNumber);
}

/** Letras por cobrar (vigentes y vencidas), para el encabezado. */
async function summary(today) {
  const { rows } = await db.query(
    `SELECT COUNT(*) FILTER (WHERE due_date >= $1::date)::int AS vigentes,
            COUNT(*) FILTER (WHERE due_date < $1::date)::int AS vencidas,
            COALESCE(SUM(amount), 0) AS por_cobrar,
            COALESCE(SUM(amount) FILTER (WHERE due_date < $1::date), 0) AS vencido
       FROM bills_of_exchange
      WHERE status = 'issued'`,
    [today],
  );
  return rows[0];
}

async function getBatch(batchId) {
  const { rows } = await db.query(
    `SELECT ${BATCH_COLUMNS}
       FROM bill_of_exchange_batches bt
       LEFT JOIN users u ON u.id = bt.created_by
      WHERE bt.id = $1`,
    [batchId],
  );
  if (!rows.length) return null;
  const { rows: bills } = await db.query(
    `SELECT ${BILL_COLUMNS} FROM bills_of_exchange b WHERE b.batch_id = $1 ORDER BY b.installment`,
    [batchId],
  );
  return { ...rows[0], bills: bills.map(withNumber) };
}

/** Una letra con su lote, o null. */
async function getBill(billId) {
  const { rows } = await db.query(
    `SELECT ${BILL_COLUMNS} FROM bills_of_exchange b WHERE b.id = $1`,
    [billId],
  );
  if (!rows.length) return null;
  const batch = await getBatch(rows[0].batch_id);
  return batch ? { bill: withNumber(rows[0]), batch } : null;
}

const TRANSITIONS = {
  pagar: { from: [BILL_STATUS.ISSUED], to: BILL_STATUS.PAID },
  anular: { from: [BILL_STATUS.ISSUED], to: BILL_STATUS.VOIDED },
  // Deshace un "pagada" marcado por error. Anular, en cambio, es definitivo:
  // el número ya no se reutiliza y la letra física debe destruirse.
  reactivar: { from: [BILL_STATUS.PAID], to: BILL_STATUS.ISSUED },
};

/**
 * Cambia el estado de una letra. Devuelve la fila actualizada o null si la
 * transición no aplica desde el estado actual.
 */
async function changeStatus(billId, action, userId, reason = "") {
  const transition = TRANSITIONS[action];
  if (!transition) return null;
  const { rows } = await db.query(
    `UPDATE bills_of_exchange
        SET status = $2::text,
            paid_at = CASE WHEN $2::text = 'paid' THEN NOW() WHEN $2::text = 'issued' THEN NULL ELSE paid_at END,
            voided_at = CASE WHEN $2::text = 'voided' THEN NOW() ELSE voided_at END,
            void_reason = CASE WHEN $2::text = 'voided' THEN NULLIF($4::text, '') ELSE void_reason END,
            updated_by = $3
      WHERE id = $1 AND status = ANY($5::text[])
      RETURNING ${BILL_COLUMNS.replace(/b\./g, "")}`,
    [billId, transition.to, userId ?? null, cleanText(reason, 300), transition.from],
  );
  return rows[0] ? withNumber(rows[0]) : null;
}

/** Datos del último lote de ese RUC/DNI, para no volver a tipearlos. */
async function findAcceptor(doc) {
  const normalized = normalizeDoc(doc);
  if (!normalized) return null;
  const { rows } = await db.query(
    `SELECT acceptor_doc, acceptor_name, acceptor_address, acceptor_locality, acceptor_phone,
            guarantor_name, guarantor_doc, guarantor_address, guarantor_locality, guarantor_phone,
            bank_name, bank_office, bank_account, bank_dc
       FROM bill_of_exchange_batches
      WHERE acceptor_doc = $1
      ORDER BY created_at DESC
      LIMIT 1`,
    [normalized],
  );
  return rows[0] || null;
}

/** Aceptantes conocidos para la lista de sugerencias del formulario. */
async function listAcceptors() {
  const { rows } = await db.query(
    `SELECT DISTINCT ON (acceptor_doc) acceptor_doc, acceptor_name
       FROM bill_of_exchange_batches
      ORDER BY acceptor_doc, created_at DESC
      LIMIT 500`,
  );
  return rows;
}

/**
 * Lo que necesita el PDF de una letra: todo plano, con el número armado y el
 * monto en letras ya resuelto.
 */
function toPrintable(batch, bill) {
  return {
    number: bill.number,
    invoiceRef: batch.invoice_ref || "",
    issueDate: batch.issue_date,
    issuePlace: batch.issue_place,
    dueDate: bill.due_date,
    amount: bill.amount,
    amountWords: amountToWords(bill.amount, BILL_CURRENCY.words),
    voided: bill.status === BILL_STATUS.VOIDED,
    acceptor: {
      name: batch.acceptor_name,
      doc: batch.acceptor_doc,
      address: batch.acceptor_address,
      locality: batch.acceptor_locality || "",
      phone: batch.acceptor_phone || "",
    },
    guarantor: {
      name: batch.guarantor_name || "",
      doc: batch.guarantor_doc || "",
      address: batch.guarantor_address || "",
      locality: batch.guarantor_locality || "",
      phone: batch.guarantor_phone || "",
    },
    bank: {
      name: batch.bank_name || "",
      office: batch.bank_office || "",
      account: batch.bank_account || "",
      dc: batch.bank_dc || "",
    },
  };
}

module.exports = {
  normalizeBatchInput,
  planInstallments,
  parseCents,
  normalizeDoc,
  nextNumberFor,
  createBatch,
  listBills,
  summary,
  getBatch,
  getBill,
  changeStatus,
  findAcceptor,
  listAcceptors,
  toPrintable,
  BillNumberError,
};
