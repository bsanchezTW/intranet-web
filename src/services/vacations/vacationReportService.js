const db = require("../../db");
const balanceService = require("./vacationBalanceService");
const { getCurrentCountry } = require("../../config/country");
const { buildWorkbook } = require("../exports/excelWorkbook");
const { vacationStatusLabel } = require("../../constants/vacationStatuses");
const { historyOriginLabel, monthLabel } = require("../../constants/vacationHistory");
const {
  toDateOnly,
  formatDisplay,
  fullYearsBetween,
  fullMonthsBetween,
  todayInCountry,
} = require("../../utils/vacationDateUtils");

/**
 * Resumen consolidado de vacaciones del país y sus exportaciones.
 *
 * Es la vista que RR.HH. llevaba a mano en la hoja "resumen" del Excel: una
 * fila por trabajador con tiempo de servicio, días generados, días gozados
 * (historial + intranet), saldo y, para el abogado, cuánto habría que pagar
 * hoy en una liquidación.
 */

/** "7 años, 6 meses" a partir de la fecha de ingreso. */
function serviceTimeLabel(hireDate, referenceDate) {
  const hire = toDateOnly(hireDate);
  if (!hire) return "—";
  const years = fullYearsBetween(hire, referenceDate);
  const months = fullMonthsBetween(hire, referenceDate) - years * 12;
  const parts = [];
  if (years > 0) parts.push(`${years} año${years === 1 ? "" : "s"}`);
  if (months > 0) parts.push(`${months} mes${months === 1 ? "" : "es"}`);
  return parts.length ? parts.join(", ") : "menos de un mes";
}

/**
 * Una fila por colaborador con su saldo completo.
 *
 * Cuatro consultas en total (no una por trabajador): los períodos y el
 * historial se traen agrupados y se reparten en memoria. Con ~20 personas da
 * igual, pero deja el reporte listo para cuando no sean 20.
 */
async function buildTeamReport({ referenceDate = null, search = null } = {}) {
  const today = toDateOnly(referenceDate) || todayInCountry();
  const country = getCurrentCountry();

  const params = [];
  let filter = "";
  if (search && String(search).trim()) {
    params.push(`%${String(search).trim().toLowerCase()}%`);
    filter = `WHERE (LOWER(u.first_name || ' ' || u.last_name) LIKE $1
                  OR LOWER(COALESCE(u.email, '')) LIKE $1
                  OR LOWER(COALESCE(u.national_id, '')) LIKE $1)`;
  }

  const { rows: users } = await db.query(
    `SELECT u.id, u.first_name, u.last_name, u.email, u.national_id,
            u.hire_date, u.role, w.area_name
       FROM users u
       LEFT JOIN work_areas w ON w.id = u.work_area_id
       ${filter}
       ORDER BY u.last_name ASC NULLS LAST, u.first_name ASC`,
    params,
  );

  const userIds = users.map((u) => u.id);
  if (userIds.length === 0) return { rows: [], totals: emptyTotals(), referenceDate: today };

  const { rows: periods } = await db.query(
    `SELECT * FROM vacation_periods WHERE user_id = ANY($1::int[])
      ORDER BY period_start ASC`,
    [userIds],
  );
  const { rows: historyTotals } = await db.query(
    `SELECT user_id, COALESCE(SUM(days_used), 0) AS days, COUNT(*) AS records
       FROM vacation_history
      WHERE user_id = ANY($1::int[]) AND deleted_at IS NULL
      GROUP BY user_id`,
    [userIds],
  );

  const periodsByUser = new Map();
  for (const p of periods) {
    if (!periodsByUser.has(p.user_id)) periodsByUser.set(p.user_id, []);
    periodsByUser.get(p.user_id).push(p);
  }
  const historyByUser = new Map(
    historyTotals.map((h) => [
      h.user_id,
      { days: Number(h.days), records: Number(h.records) },
    ]),
  );

  const rows = users.map((user) => {
    const userPeriods = periodsByUser.get(user.id) || [];
    const summary = balanceService.summarizePeriods({
      periods: userPeriods,
      country,
      referenceDate: today,
    });
    const history = historyByUser.get(user.id) || { days: 0, records: 0 };
    // Días del historial que no cupieron en ningún período: la imputación FIFO
    // llena hasta donde hay derecho y el resto queda fuera. Sin esto el saldo
    // dice 0 y nadie se entera de que sobran días cargados.
    const unimputed = Math.round((history.days - summary.historicalUsedDays) * 100) / 100;

    return {
      id: user.id,
      name: [user.first_name, user.last_name].filter(Boolean).join(" ") || `#${user.id}`,
      nationalId: user.national_id || "—",
      email: user.email || "—",
      area: user.area_name || "—",
      hireDate: toDateOnly(user.hire_date),
      hireDateFmt: user.hire_date ? formatDisplay(user.hire_date) : "—",
      serviceTime: serviceTimeLabel(user.hire_date, today),
      hasHireDate: Boolean(user.hire_date),
      generatedDays: summary.generatedDays,
      historicalUsedDays: summary.historicalUsedDays,
      historyTotalDays: Math.round(history.days * 100) / 100,
      unimputedDays: unimputed > 0.001 ? unimputed : 0,
      historyRecords: history.records,
      approvedUsedDays: summary.approvedUsedDays,
      totalUsedDays: summary.totalUsedDays,
      adjustedDays: summary.adjustedDays,
      availableDays: summary.availableDays,
      truncoDays: summary.truncoDays,
      severanceDays: summary.severanceDays,
      nextAccrualDate: summary.nextAccrualDate,
      nextAccrualFmt: summary.nextAccrualDate ? formatDisplay(summary.nextAccrualDate) : "—",
      // El historial cargado supera el derecho generado: casi siempre es una
      // fecha de ingreso mal puesta o una fila duplicada. RR.HH. lo ve marcado.
      overDrawn: summary.availableDays < -0.001 || unimputed > 0.001,
    };
  });

  return { rows, totals: sumTotals(rows), referenceDate: today };
}

function emptyTotals() {
  return {
    people: 0,
    withHireDate: 0,
    generatedDays: 0,
    historicalUsedDays: 0,
    approvedUsedDays: 0,
    availableDays: 0,
    severanceDays: 0,
    unimputedDays: 0,
    overDrawn: 0,
  };
}

function sumTotals(rows) {
  const round2 = (n) => Math.round(n * 100) / 100;
  return {
    people: rows.length,
    withHireDate: rows.filter((r) => r.hasHireDate).length,
    generatedDays: round2(rows.reduce((s, r) => s + r.generatedDays, 0)),
    historicalUsedDays: round2(rows.reduce((s, r) => s + r.historicalUsedDays, 0)),
    approvedUsedDays: round2(rows.reduce((s, r) => s + r.approvedUsedDays, 0)),
    availableDays: round2(rows.reduce((s, r) => s + r.availableDays, 0)),
    severanceDays: round2(rows.reduce((s, r) => s + r.severanceDays, 0)),
    unimputedDays: round2(rows.reduce((s, r) => s + r.unimputedDays, 0)),
    overDrawn: rows.filter((r) => r.overDrawn).length,
  };
}

// ===========================================================================
// Exportaciones
// ===========================================================================

/** Resumen consolidado + hoja de liquidación. */
async function exportTeamReport({ referenceDate = null } = {}) {
  const { rows, referenceDate: ref } = await buildTeamReport({ referenceDate });

  return buildWorkbook([
    {
      name: "Resumen",
      columns: [
        { header: "Trabajador", key: "name", width: 30 },
        { header: "Documento", key: "nationalId", width: 14 },
        { header: "Área", key: "area", width: 22 },
        { header: "Fecha de ingreso", key: "hireDateFmt", width: 16 },
        { header: "Tiempo de servicio", key: "serviceTime", width: 20 },
        { header: "Días generados", key: "generatedDays", width: 15, numFmt: "0.##" },
        { header: "Gozados antes de la intranet", key: "historicalUsedDays", width: 26, numFmt: "0.##" },
        { header: "Gozados por la intranet", key: "approvedUsedDays", width: 22, numFmt: "0.##" },
        { header: "Total gozado", key: "totalUsedDays", width: 14, numFmt: "0.##" },
        { header: "Ajustes", key: "adjustedDays", width: 10, numFmt: "0.##" },
        { header: "Saldo disponible", key: "availableDays", width: 17, numFmt: "0.##" },
        { header: "Próximo derecho", key: "nextAccrualFmt", width: 16 },
      ],
      rows,
      note: `Saldo al ${formatDisplay(ref)}. Días calendario.`,
    },
    {
      name: "Liquidación",
      columns: [
        { header: "Trabajador", key: "name", width: 30 },
        { header: "Documento", key: "nationalId", width: 14 },
        { header: "Fecha de ingreso", key: "hireDateFmt", width: 16 },
        { header: "Tiempo de servicio", key: "serviceTime", width: 20 },
        { header: "Días generados (años cumplidos)", key: "generatedDays", width: 30, numFmt: "0.##" },
        { header: "Total gozado", key: "totalUsedDays", width: 14, numFmt: "0.##" },
        { header: "Saldo pendiente", key: "availableDays", width: 16, numFmt: "0.##" },
        { header: "Trunco del año en curso", key: "truncoDays", width: 24, numFmt: "0.##" },
        { header: "Total a liquidar", key: "severanceDays", width: 17, numFmt: "0.##" },
      ],
      rows,
      note:
        `Cálculo al ${formatDisplay(ref)}. "Saldo pendiente" son los días de años ya cumplidos; ` +
        `"trunco" es el proporcional del año en curso. El total a liquidar es la suma de ambos.`,
    },
  ]);
}

/** Historial previo a la intranet, todas las personas. */
async function exportHistory() {
  const { rows } = await db.query(
    `SELECT h.*,
            COALESCE(u.first_name, h.employee_first_name) AS first_name,
            COALESCE(u.last_name,  h.employee_last_name)  AS last_name,
            COALESCE(u.national_id, h.employee_national_id) AS national_id,
            cb.first_name AS created_by_first_name,
            cb.last_name  AS created_by_last_name
       FROM vacation_history h
       LEFT JOIN users u  ON u.id = h.user_id
       LEFT JOIN users cb ON cb.id = h.created_by
      WHERE h.country_code = $1 AND h.deleted_at IS NULL
      ORDER BY last_name ASC NULLS LAST, h.period_year ASC, COALESCE(h.period_month, 0) ASC`,
    [getCurrentCountry()],
  );

  return buildWorkbook([
    {
      name: "Historial",
      columns: [
        { header: "Trabajador", key: "name", width: 30 },
        { header: "Documento", key: "nationalId", width: 14 },
        { header: "Año", key: "year", width: 8 },
        { header: "Mes", key: "month", width: 14 },
        { header: "Desde", key: "from", width: 14 },
        { header: "Hasta", key: "to", width: 14 },
        { header: "Días", key: "days", width: 8, numFmt: "0.##" },
        { header: "Origen", key: "origin", width: 12 },
        { header: "Archivo", key: "source", width: 30 },
        { header: "Observación", key: "observation", width: 40 },
        { header: "Registrado por", key: "createdBy", width: 26 },
        { header: "Registrado el", key: "createdAt", width: 16 },
      ],
      rows: rows.map((r) => ({
        name: [r.first_name, r.last_name].filter(Boolean).join(" ") || "—",
        nationalId: r.national_id || "—",
        year: r.period_year,
        month: monthLabel(r.period_month) || "—",
        // Guion cuando no hay fecha: nunca una fecha inventada.
        from: r.start_date ? formatDisplay(r.start_date) : "—",
        to: r.end_date ? formatDisplay(r.end_date) : "—",
        days: Number(r.days_used),
        origin: historyOriginLabel(r.origin),
        source: r.source || "—",
        observation: r.observation || "",
        createdBy:
          [r.created_by_first_name, r.created_by_last_name].filter(Boolean).join(" ") || "—",
        createdAt: r.created_at ? formatDisplay(r.created_at) : "—",
      })),
      note: "Vacaciones gozadas antes de que la intranet administrara el módulo.",
    },
  ]);
}

/** Historial de solicitudes gestionadas por la intranet. */
async function exportRequests({ workAreaId = null, status = null } = {}) {
  const conditions = ["r.country_code = $1"];
  const params = [getCurrentCountry()];
  if (workAreaId) {
    params.push(workAreaId);
    conditions.push(`u.work_area_id = $${params.length}`);
  }
  if (status) {
    params.push(status);
    conditions.push(`r.status = $${params.length}`);
  }

  const { rows } = await db.query(
    `SELECT r.*,
            COALESCE(u.first_name, r.requester_first_name) AS first_name,
            COALESCE(u.last_name,  r.requester_last_name)  AS last_name,
            COALESCE(w.area_name,  r.requester_area_name)  AS area,
            rv.first_name AS reviewer_first_name,
            rv.last_name  AS reviewer_last_name
       FROM vacation_requests r
       LEFT JOIN users u  ON u.id = r.user_id
       LEFT JOIN work_areas w ON w.id = u.work_area_id
       LEFT JOIN users rv ON rv.id = r.reviewed_by
      WHERE ${conditions.join(" AND ")}
      ORDER BY r.start_date DESC`,
    params,
  );

  return buildWorkbook([
    {
      name: "Solicitudes",
      columns: [
        { header: "N°", key: "id", width: 10 },
        { header: "Trabajador", key: "name", width: 30 },
        { header: "Área", key: "area", width: 22 },
        { header: "Desde", key: "from", width: 14 },
        { header: "Hasta", key: "to", width: 14 },
        { header: "Días", key: "days", width: 8, numFmt: "0.##" },
        { header: "Estado", key: "status", width: 14 },
        { header: "Revisor", key: "reviewer", width: 26 },
        { header: "Revisada el", key: "reviewedAt", width: 16 },
        { header: "Comentario del trabajador", key: "requesterNotes", width: 36 },
        { header: "Comentario de RR.HH.", key: "reviewerNotes", width: 36 },
      ],
      rows: rows.map((r) => ({
        id: r.id,
        name: [r.first_name, r.last_name].filter(Boolean).join(" ") || "—",
        area: r.area || "—",
        from: formatDisplay(r.start_date),
        to: formatDisplay(r.end_date),
        days: Number(r.calendar_days ?? r.business_days ?? 0),
        status: vacationStatusLabel(r.status),
        reviewer:
          [r.reviewer_first_name, r.reviewer_last_name].filter(Boolean).join(" ") || "—",
        reviewedAt: r.reviewed_at ? formatDisplay(r.reviewed_at) : "—",
        requesterNotes: r.requester_notes || "",
        reviewerNotes: r.reviewer_notes || "",
      })),
    },
  ]);
}

module.exports = {
  serviceTimeLabel,
  buildTeamReport,
  exportTeamReport,
  exportHistory,
  exportRequests,
};
