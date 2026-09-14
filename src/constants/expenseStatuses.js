/**
 * Estados y tipos de una solicitud del centro de gastos.
 *
 * Corresponden a los enums expense_request_status y expense_request_kind en BD
 * (services/expenses/expenseSchema.js). El flujo es de dos etapas:
 *
 *   draft ──(el solicitante la envía)──▶ pending
 *
 *   pending ──(jefe de área)──▶ approved_manager ──(Finanzas)──▶ approved_finance
 *      │                              │
 *      ├──▶ rejected                  └──▶ rejected
 *      └──▶ cancelled  (sólo el solicitante, y sólo mientras está pending)
 *
 * `rejected_stage` guarda en qué etapa se rechazó; el estado no se desdobla
 * para no multiplicar los casos que la UI debe conocer.
 *
 * Un borrador es privado de su dueño: no aparece en bandejas ni historiales.
 */

const EXPENSE_STATUS = {
  DRAFT: "draft",
  PENDING: "pending",
  APPROVED_MANAGER: "approved_manager",
  APPROVED_FINANCE: "approved_finance",
  REJECTED: "rejected",
  CANCELLED: "cancelled",
};

const ALL_EXPENSE_STATUSES = Object.values(EXPENSE_STATUS);

const EXPENSE_STATUS_LABELS = {
  draft: "Borrador",
  pending: "Pendiente de jefatura",
  approved_manager: "Aprobada por jefatura",
  approved_finance: "Aprobada por Finanzas",
  rejected: "Rechazada",
  cancelled: "Anulada",
};

/** Clase CSS del badge por estado (ver public/css/gastos.css). */
const EXPENSE_STATUS_BADGE = {
  draft: "gasto-badge gasto-badge--draft",
  pending: "gasto-badge gasto-badge--pending",
  approved_manager: "gasto-badge gasto-badge--manager",
  approved_finance: "gasto-badge gasto-badge--finance",
  rejected: "gasto-badge gasto-badge--rejected",
  cancelled: "gasto-badge gasto-badge--cancelled",
};

/** Estados en los que la solicitud sigue viva y espera a alguien. */
const EXPENSE_OPEN_STATUSES = [
  EXPENSE_STATUS.PENDING,
  EXPENSE_STATUS.APPROVED_MANAGER,
];

const EXPENSE_KIND = {
  RENDICION: "rendicion",
  FONDOS: "fondos",
};

const ALL_EXPENSE_KINDS = Object.values(EXPENSE_KIND);

const EXPENSE_KIND_LABELS = {
  rendicion: "Rendición de gastos",
  fondos: "Solicitud de fondos",
};

/** Etapa que rechazó, para el detalle. */
const EXPENSE_STAGE = {
  MANAGER: "manager",
  FINANCE: "finance",
};

const EXPENSE_STAGE_LABELS = {
  manager: "Jefatura de área",
  finance: "Finanzas",
};

function expenseStatusLabel(status) {
  return EXPENSE_STATUS_LABELS[status] || status;
}

function expenseStatusBadge(status) {
  return EXPENSE_STATUS_BADGE[status] || "gasto-badge";
}

function expenseKindLabel(kind) {
  return EXPENSE_KIND_LABELS[kind] || kind;
}

function expenseStageLabel(stage) {
  return EXPENSE_STAGE_LABELS[stage] || stage;
}

function isExpenseKind(value) {
  return ALL_EXPENSE_KINDS.includes(value);
}

module.exports = {
  EXPENSE_STATUS,
  ALL_EXPENSE_STATUSES,
  EXPENSE_STATUS_LABELS,
  EXPENSE_STATUS_BADGE,
  EXPENSE_OPEN_STATUSES,
  EXPENSE_KIND,
  ALL_EXPENSE_KINDS,
  EXPENSE_KIND_LABELS,
  EXPENSE_STAGE,
  EXPENSE_STAGE_LABELS,
  expenseStatusLabel,
  expenseStatusBadge,
  expenseKindLabel,
  expenseStageLabel,
  isExpenseKind,
};
