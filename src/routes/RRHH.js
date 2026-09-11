const express = require("express");
const router = express.Router();
const db = require("../db");
const multer = require("multer");
const crypto = require("crypto");
const fileStorage = require("../services/fileStorage");
const userPhotoStorage = require("../services/userPhotoStorage");
const { UPLOAD_LIMITS_BYTES } = require("../config/uploadLimits");
const { ROLES, ALL_ROLES } = require("../constants/roles");
const {
  DEFAULT_COLOR,
  COLOR_PALETTE,
  getWorkAreaPill,
  getWorkAreaPillClass,
  enrichAreaWithPill,
  normalizeHex,
} = require("../constants/workAreas");
const { isFeatureEnabled } = require("../config/features");
const costCenterService = require("../services/costCenters/costCenterService");

/** Etiqueta del documento según la instancia: "RUT" o "DNI". */
function documentLabel() {
  return require("../config/country").getDocumentConfig().label;
}

function parseRoleFromForm(role) {
  const value = String(role || "").trim();
  return ALL_ROLES.includes(value) ? value : ROLES.USUARIO;
}
const requireRole = require("../middlewares/requireRole");
const { sendMail } = require("../services/mailer");
const { toTitleCase } = require("../utils/formatName");
const { getMonogram, applyIdentityToSession } = require("../utils/monogram");
const {
  validateMobilePhone,
  formatPhoneForDisplay,
  toTelHref,
} = require("../utils/phone");
const { validateEmail } = require("../utils/email");
const {
  validateNationalId,
  nationalIdClientConfig,
  formatNationalId,
} = require("../utils/nationalId");
const { mapPersonaForView } = require("../utils/schemaMappers");
const balanceService = require("../services/vacations/vacationBalanceService");
const { invalidateFinanceTeam } = require("../services/expenses/financeTeam");
const { invalidateSupportTeam } = require("../services/tickets/supportTeam");

function parsePriorYearsCredited(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(10, n);
}

function parseProgressiveOverride(value) {
  if (value == null || !String(value).trim()) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function parseWorkDaysPerWeek(value) {
  const n = parseInt(String(value || "5"), 10);
  if (n >= 3 && n <= 6) return n;
  return 5;
}

function redirectPersonalCrearError(res, message) {
  return res.redirect(
    `/RRHH/personal?crearError=${encodeURIComponent(message)}`,
  );
}

function redirectPersonalEditarError(res, id, message) {
  return res.redirect(
    `/RRHH/personal?editar=${encodeURIComponent(id)}&editarError=${encodeURIComponent(message)}`,
  );
}

const storage = multer.memoryStorage();
const uploadOrganigram = multer({
  storage,
  limits: { fileSize: UPLOAD_LIMITS_BYTES.ORGANIGRAM },
});
const uploadProfilePhoto = multer({
  storage,
  limits: { fileSize: UPLOAD_LIMITS_BYTES.PROFILE_PHOTO },
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype || !file.mimetype.startsWith("image/")) {
      return cb(new Error("Formato de imagen no permitido."));
    }
    return cb(null, true);
  },
});

// Variables globales
let urlOrganigramaActual = null;
let versionCache = Date.now();

// Función Auxiliar
async function getOrganigramaUrl() {
  if (urlOrganigramaActual) return `${urlOrganigramaActual}?v=${versionCache}`;

  try {
    const files = await fileStorage.listFiles("organigrama");
    if (files && files.length > 0) {
      files.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      urlOrganigramaActual = files[0].secure_url;
      return `${urlOrganigramaActual}?v=${versionCache}`;
    }
    return null;
  } catch (err) {
    console.error("Error buscando organigrama:", err);
    return null;
  }
}

function parseFechaNacimiento(fecha) {
  if (!fecha) return null;
  const str =
    typeof fecha === "string"
      ? fecha.slice(0, 10)
      : fecha instanceof Date
        ? fecha.toISOString().slice(0, 10)
        : String(fecha).slice(0, 10);
  const m = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return { month: parseInt(m[2], 10) - 1, day: parseInt(m[3], 10) };
}

function pbkdf2Hash(password, saltHex) {
  const salt = Buffer.from(saltHex, "hex");
  return crypto
    .pbkdf2Sync(password, salt, 120000, 32, "sha256")
    .toString("hex");
}

function generarCredencialesTemporales() {
  const passwordTemporal = crypto.randomBytes(4).toString("hex");
  const saltHex = crypto.randomBytes(16).toString("hex");
  const hashHex = pbkdf2Hash(passwordTemporal, saltHex);
  return { passwordTemporal, saltHex, hashHex };
}

function puedeCrearCuentaIntranet(email) {
  return Boolean(email);
}

function enviarClaveTemporal(email, firstName, passwordTemporal) {
  return sendMail({
    to: email,
    subject: "Cuenta creada - Intranet",
    html: `
      <h3>Hola ${firstName},</h3>
      <p>Tu cuenta fue creada en la Intranet Transworld.</p>
      <p>Tu contraseña temporal es: <strong>${passwordTemporal}</strong></p>
      <p>Ingresa con tu correo y esta contraseña. En el primer acceso te pediremos verificar tu correo.</p>
      <p>Por seguridad, se te solicitará cambiarla en tu primer ingreso.</p>
    `,
    text: `Hola ${firstName}, tu contraseña temporal es: ${passwordTemporal}. Ingresa con tu correo y esta contraseña; en el primer acceso te pediremos verificar tu correo.`,
  }).catch((mailErr) =>
    console.error("Error enviando correo:", mailErr.message),
  );
}

async function getAreasTrabajo() {
  const { rows } = await db.query(
    "SELECT id, area_name, color FROM work_areas ORDER BY area_name ASC",
  );
  return rows.map(enrichAreaWithPill);
}

/**
 * Centros de costo que la ficha de un colaborador puede ofrecer.
 *
 * Sólo los activos: un centro apagado ya no se ofrece al rendir, así que
 * tampoco tiene sentido asignarlo desde aquí. Si la instancia no tiene el
 * centro de gastos encendido devuelve vacío y el campo no se dibuja.
 */
async function getCentrosCostoAsignables() {
  if (!isFeatureEnabled("expenseCenter")) return [];
  const { rows } = await db.query(
    "SELECT id, code, name FROM cost_centers WHERE active = TRUE ORDER BY code ASC",
  );
  return rows;
}

function parsePositiveInt(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

function parseAreaName(value) {
  const name = String(value || "")
    .trim()
    .replace(/\s+/g, " ");
  if (!name || name.length > 150) return null;
  return name;
}

function parseAreaColor(value) {
  return normalizeHex(value) || DEFAULT_COLOR;
}

function redirectAreasOk(res, msg) {
  return res.redirect(
    `/RRHH/areas?ok=1&msg=${encodeURIComponent(msg)}`,
  );
}

function redirectAreasError(res, message) {
  return res.redirect(
    `/RRHH/areas?error=${encodeURIComponent(message)}`,
  );
}

function isUniqueViolation(err) {
  return err && err.code === "23505";
}

/**
 * Quién forma la mesa de ayuda y quién aprueba en Finanzas se deduce del área,
 * y ambos servicios lo cachean 60 s. Cualquier cambio de área o de membresía
 * tiene que invalidarlos o el permiso queda desfasado hasta un minuto.
 */
/**
 * Deja sin jefe a cualquier área cuyo jefe ya no pertenezca a ella. Se llama
 * después de reasignar a alguien: una jefatura que apunta fuera del área es
 * exactamente el estado que impide aprobar con criterio.
 */
async function limpiarJefaturaHuerfana(userId) {
  await db.query(
    `UPDATE work_areas w
        SET manager_user_id = NULL
       FROM users u
      WHERE w.manager_user_id = $1
        AND u.id = $1
        AND (u.work_area_id IS NULL OR u.work_area_id <> w.id)`,
    [userId],
  );
}

function invalidarCachesDeArea() {
  invalidateFinanceTeam();
  invalidateSupportTeam();
}

/**
 * Valida al jefe propuesto para un área. Devuelve { ok, managerId } o
 * { ok: false, error }. Un jefe que no pertenece al área que dirige no puede
 * aprobar sus gastos con criterio, así que se exige la pertenencia.
 */
async function parseAreaManager(rawValue, areaId) {
  const raw = String(rawValue ?? "").trim();
  if (!raw) return { ok: true, managerId: null };

  const managerId = parsePositiveInt(raw);
  if (!managerId) return { ok: false, error: "Jefe de área inválido." };

  const { rows } = await db.query(
    "SELECT id, work_area_id FROM users WHERE id = $1",
    [managerId],
  );
  if (!rows.length) {
    return { ok: false, error: "El colaborador elegido como jefe no existe." };
  }
  if (Number(rows[0].work_area_id) !== Number(areaId)) {
    return {
      ok: false,
      error: "El jefe de área debe pertenecer al área que dirige.",
    };
  }
  return { ok: true, managerId };
}

function formatAreaMember(row) {
  const firstName = row.first_name || "";
  const lastName = row.last_name || "";
  const primerNombre = String(firstName).trim().split(/\s+/)[0] || "";
  const primerApellido = String(lastName).trim().split(/\s+/)[0] || "";
  const nombreLista =
    [primerNombre, primerApellido].filter(Boolean).join(" ") || "-";
  const nombreCompleto =
    [firstName, lastName].filter(Boolean).join(" ") || "-";
  const monogram = getMonogram({
    first_name: firstName,
    last_name: lastName,
    area: row.area_name,
    area_color: row.area_color || row.color,
  });
  return {
    id: row.id,
    first_name: firstName,
    last_name: lastName,
    photo: row.photo || null,
    work_area_id: row.work_area_id,
    area_name: row.area_name || null,
    nombreLista,
    nombreCompleto,
    inicial: monogram.initials,
    monogramStyle: monogram.style,
  };
}

async function refreshSessionIdentity(req, userId) {
  if (!req.session?.user || !userId) return;
  if (String(req.session.user.id) !== String(userId)) return;
  const { rows } = await db.query(
    `SELECT u.first_name, u.last_name, u.photo, u.work_area_id,
            at.area_name, at.color AS area_color
       FROM users u
       LEFT JOIN work_areas at ON at.id = u.work_area_id
      WHERE u.id = $1`,
    [userId],
  );
  if (rows[0]) applyIdentityToSession(req.session.user, rows[0]);
}

// ==========================================
// RUTAS PRINCIPALES
// ==========================================

// 1. PÁGINA PRINCIPAL
router.get("/", (req, res) => {
  res.render("RRHH/index", {
    titulo: "Recursos Humanos",
    user: req.session.user,
  });
});

// 2. LISTADO DE PERSONAL
// FIX: Se agregan columnas faltantes: telefono, usuario_intranet
// FIX: Los campos se mapean 1:1 desde la BD sin transformaciones intermedias
router.get("/personal", async (req, res) => {
  const sql = `
    SELECT
      u.id,
      u.first_name,
      u.last_name,
      u.email,
      u.role,
      u.photo,
      u.birth_date,
      u.work_area_id,
      u.phone,
      u.is_intranet_user,
      u.email_confirmed,
      u.national_id,
      at.area_name AS area,
      at.color AS area_color
    FROM users u
    LEFT JOIN work_areas at ON at.id = u.work_area_id
    ORDER BY u.last_name ASC NULLS LAST, u.first_name ASC
  `;

  try {
    const { rows: results } = await db.query(sql);
    const mostrarColumnaRol = Boolean(res.locals.isAdministrador);

    const personasFormateadas = results.map((p) => {
      const birthDate = p.birth_date ?? p.fecha_nacimiento;
      const phoneRaw = p.phone ?? p.telefono;
      const partes = parseFechaNacimiento(birthDate);
      const ordenCumple = partes ? partes.month * 100 + partes.day : 9999;
      const fechaCumpleFmt = partes
        ? `${String(partes.day).padStart(2, "0")}-${String(partes.month + 1).padStart(2, "0")}`
        : "-";

      const telefonoHref = toTelHref(phoneRaw);
      const telefonoDisplay = formatPhoneForDisplay(phoneRaw);
      const pill = getWorkAreaPill(p.area, p.area_color);

      const persona = {
        ...p,
        phone: telefonoDisplay || phoneRaw,
        telefono: telefonoDisplay || phoneRaw,
        // Guardado normalizado ("12345678-5"); los puntos se agregan al mostrar.
        documento: formatNationalId(p.national_id),
        ordenCumple,
        fechaCumpleFmt,
        telefonoHref,
        pillClass: pill.pillClass,
        pillStyle: pill.pillStyle,
        monogram: getMonogram(p),
      };

      if (!mostrarColumnaRol) {
        delete persona.role;
      }

      return persona;
    });

    // Leer mensajes flash de la querystring
    const successMsg = req.query.ok === "1" ? decodeURIComponent(req.query.msg || "Operación exitosa") : null;
    const crearError = req.query.crearError
      ? decodeURIComponent(req.query.crearError)
      : null;
    const abrirCrearModal =
      req.query.abrirCrear === "1" || Boolean(crearError);
    const editarId = req.query.editar ? String(req.query.editar) : null;
    const editarError = req.query.editarError
      ? decodeURIComponent(req.query.editarError)
      : null;

    const [areas, centrosCosto] = await Promise.all([
      getAreasTrabajo(),
      getCentrosCostoAsignables(),
    ]);

    res.render("RRHH/personal", {
      titulo: "Personal",
      personas: personasFormateadas,
      areas,
      centrosCosto,
      maxCentrosCosto: costCenterService.MAX_COST_CENTERS_PER_USER,
      mostrarColumnaRol,
      getWorkAreaPillClass,
      getWorkAreaPill,
      documentoConfig: nationalIdClientConfig(),
      user: req.session.user,
      success: successMsg,
      error: null,
      crearError,
      abrirCrearModal,
      editarId,
      editarError,
    });
  } catch (err) {
    console.error("Error consultando personas:", err);
    res.status(500).send("Error consultando personas");
  }
});

// --- CRUD Personas ---

router.get("/crear", requireRole.administrador(), (req, res) => {
  res.redirect("/RRHH/personal?abrirCrear=1");
});

// FIX: Se añaden los campos faltantes telefono al INSERT
// FIX: Validación clara con mensajes específicos
router.post("/crear", requireRole.administrador(), async (req, res) => {
  const {
    first_name,
    last_name,
    email,
    work_area_id,
    birth_date,
    phone,
    hire_date,
    prior_years_credited,
    progressive_days_override,
    work_days_per_week,
    national_id,
  } = req.body;

  try {
    const hireVal = hire_date && String(hire_date).trim() ? hire_date : null;
    const priorYearsVal = parsePriorYearsCredited(prior_years_credited);
    const progressiveOverrideVal = parseProgressiveOverride(progressive_days_override);
    const workDaysVal = parseWorkDaysPerWeek(work_days_per_week);
    const emailRaw =
      email && typeof email === "string" ? email.trim() : "";
    const emailCheck = emailRaw
      ? validateEmail(emailRaw)
      : { valid: true, value: null };
    const emailClean = emailCheck.value;
    const areaId = (work_area_id && String(work_area_id).trim()) ? Number(work_area_id) : null;
    const telefonoCheck = (phone && typeof phone === 'string' && phone.trim()) ? validateMobilePhone(phone) : { valid: true, value: null, storageValue: null };
    const telefonoVal = telefonoCheck.storageValue;

    // Opcional al crear la ficha: RR.HH. no siempre tiene el documento a mano.
    // La rendición de gastos sí lo exige, que es donde el dato importa.
    const documentoCheck = validateNationalId(national_id);
    if (!documentoCheck.valid) {
      return redirectPersonalCrearError(res, documentoCheck.error);
    }
    const documentoVal = documentoCheck.storageValue;

    const firstName = (first_name && typeof first_name === 'string') ? toTitleCase(first_name.trim()) : '';
    const lastName = (last_name && typeof last_name === 'string') ? toTitleCase(last_name.trim()) : '';
    const fechaVal =
      birth_date && String(birth_date).trim()
        ? birth_date
        : null;

    if (!firstName || !lastName || !areaId) {
      return redirectPersonalCrearError(
        res,
        "Completa los campos obligatorios: Nombre, Apellido y Área de Trabajo.",
      );
    }

    if (!emailClean && !fechaVal) {
      return redirectPersonalCrearError(
        res,
        "La fecha de nacimiento es obligatoria para colaboradores sin correo.",
      );
    }

    if (documentoVal) {
      const { rows: repetido } = await db.query(
        "SELECT id FROM users WHERE national_id = $1",
        [documentoVal],
      );
      if (repetido.length) {
        return redirectPersonalCrearError(
          res,
          `Ya hay un colaborador registrado con ese ${documentLabel()}.`,
        );
      }
    }

    if (!emailCheck.valid) {
      return redirectPersonalCrearError(res, emailCheck.error);
    }

    if (!telefonoCheck.valid) {
      return redirectPersonalCrearError(res, telefonoCheck.error);
    }

    if (emailClean) {
      const { rows: existingUser } = await db.query(
        "SELECT id FROM users WHERE email = $1 LIMIT 1",
        [emailClean],
      );
      if (existingUser.length > 0) {
        return redirectPersonalCrearError(
          res,
          "El correo ya existe en el sistema.",
        );
      }
    }

    const crearCuentaIntranet = puedeCrearCuentaIntranet(emailClean);
    let successMsg = "Colaborador+agregado+correctamente";
    let userId;

    if (crearCuentaIntranet) {
      const { passwordTemporal, saltHex, hashHex } =
        generarCredencialesTemporales();

      const { rows: inserted } = await db.queryRetryIdCollision(
        `INSERT INTO users
          (first_name, last_name, email, password_hash, password_salt, role, email_confirmed, must_change_password, work_area_id, birth_date, phone, is_intranet_user, home_tutorial_seen, hire_date, prior_years_credited, progressive_days_override, work_days_per_week, national_id)
        VALUES ($1, $2, $3, $4, $5, $6, FALSE, TRUE, $7, $8, $9, TRUE, FALSE, $10, $11, $12, $13, $14)
        RETURNING id`,
        [
          firstName,
          lastName,
          emailClean,
          hashHex,
          saltHex,
          ROLES.DESHABILITADO,
          areaId,
          fechaVal,
          telefonoVal,
          hireVal,
          priorYearsVal,
          progressiveOverrideVal,
          workDaysVal,
          documentoVal,
        ],
      );
      userId = inserted[0].id;

      await enviarClaveTemporal(emailClean, firstName, passwordTemporal);
      successMsg =
        "Usuario+creado+correctamente.+Se+envió+la+clave+temporal+al+correo.";
    } else {
      const { rows: inserted } = await db.queryRetryIdCollision(
        `INSERT INTO users
          (first_name, last_name, email, role, email_confirmed, must_change_password, work_area_id, birth_date, phone, is_intranet_user, hire_date, prior_years_credited, progressive_days_override, work_days_per_week, national_id)
        VALUES ($1, $2, $3, $4, FALSE, FALSE, $5, $6, $7, FALSE, $8, $9, $10, $11, $12)
        RETURNING id`,
        [
          firstName,
          lastName,
          emailClean,
          ROLES.DESHABILITADO,
          areaId,
          fechaVal,
          telefonoVal,
          hireVal,
          priorYearsVal,
          progressiveOverrideVal,
          workDaysVal,
          documentoVal,
        ],
      );
      userId = inserted[0].id;
    }

    // Genera los períodos de vacaciones si se registró fecha de ingreso.
    if (hireVal) {
      balanceService
        .recalculatePeriods(userId)
        .catch((e) => console.error("[Vacaciones] recalc al crear:", e.message));
    }

    // Los centros de costo van después del INSERT porque necesitan el id. Si
    // fallan, la ficha ya existe: se avisa en vez de deshacer al colaborador.
    // Con el centro de gastos apagado la ficha no dibuja el campo, y un
    // formulario sin casillas dejaría a la persona sin ningún centro.
    const centrosCrear = isFeatureEnabled("expenseCenter")
      ? await costCenterService.setUserCostCenters(
          userId,
          req.body.cost_center_ids,
        )
      : { ok: true };
    if (!centrosCrear.ok) {
      return res.redirect(
        `/RRHH/personal?ok=1&msg=${successMsg}+pero+no+se+pudieron+asignar+los+centros+de+costo`,
      );
    }

    res.redirect(`/RRHH/personal?ok=1&msg=${successMsg}`);
  } catch (err) {
    if (err && err.code === "23505") {
      return redirectPersonalCrearError(
        res,
        "El correo ya existe en el sistema.",
      );
    }
    console.error("Error creando usuario:", err);
    return redirectPersonalCrearError(
      res,
      `Error al crear el usuario: ${err.message}`,
    );
  }
});

router.get("/editar/:id", requireRole.administrador(), async (req, res) => {
  const { id } = req.params;
  try {
    const [userResult, areas, centrosCosto, centrosDelUsuario] =
      await Promise.all([
        db.query("SELECT * FROM users WHERE id = $1", [id]),
        getAreasTrabajo(),
        getCentrosCostoAsignables(),
        costCenterService.listUserCostCenters(id),
      ]);
    const { rows } = userResult;

    if (rows.length === 0) return res.status(404).send("Usuario no encontrado");

    const phoneRaw = rows[0].phone ?? rows[0].telefono;
    const phoneDisplay =
      formatPhoneForDisplay(phoneRaw) || phoneRaw || "";
    const persona = mapPersonaForView({
      ...rows[0],
      phone: phoneDisplay,
      telefono: phoneDisplay,
      // Guardado sin separadores; los puntos se agregan sólo al mostrarlo.
      documento: formatNationalId(rows[0].national_id),
    });

    if (req.query.partial === "1") {
      // El fragmento se renderiza fuera del layout: lo que la vista necesite
      // hay que pasárselo aquí, porque no hereda los locals de /personal.
      return res.render("RRHH/partials/persona_editar_modal", {
        layout: false,
        persona,
        areas,
        centrosCosto,
        centrosSeleccionados: centrosDelUsuario.map((c) => c.id),
        maxCentrosCosto: costCenterService.MAX_COST_CENTERS_PER_USER,
        documentoConfig: nationalIdClientConfig(),
        getWorkAreaPillClass,
        getWorkAreaPill,
      });
    }

    return res.redirect(`/RRHH/personal?editar=${encodeURIComponent(id)}`);
  } catch (err) {
    console.error(err);
    res.status(500).send("Error cargando formulario de edición");
  }
});

router.post(
  "/editar/:id",
  requireRole.administrador(),
  uploadProfilePhoto.single("foto"),
  async (req, res) => {
    const { id } = req.params;
    const {
      first_name,
      last_name,
      role,
      work_area_id,
      birth_date,
      phone,
      email,
      eliminar_foto,
      hire_date,
      prior_years_credited,
      progressive_days_override,
      work_days_per_week,
      national_id,
    } = req.body;

    try {
      const hireVal = hire_date && String(hire_date).trim() ? hire_date : null;
      const priorYearsVal = parsePriorYearsCredited(prior_years_credited);
      const progressiveOverrideVal = parseProgressiveOverride(progressive_days_override);
      const workDaysVal = parseWorkDaysPerWeek(work_days_per_week);
      const areaId = (work_area_id && String(work_area_id).trim()) ? Number(work_area_id) : null;
      const telefonoCheck = (phone && typeof phone === 'string' && phone.trim()) ? validateMobilePhone(phone) : { valid: true, value: null, storageValue: null };
      const telefonoVal = telefonoCheck.storageValue;
      const documentoCheck = validateNationalId(national_id);
      if (!documentoCheck.valid) {
        return redirectPersonalEditarError(res, id, documentoCheck.error);
      }
      const documentoVal = documentoCheck.storageValue;
      const firstName = (first_name && typeof first_name === 'string') ? toTitleCase(first_name.trim()) : '';
      const lastName = (last_name && typeof last_name === 'string') ? toTitleCase(last_name.trim()) : '';
      const emailRaw =
        email && typeof email === "string" ? email.trim() : "";
      const emailCheck = emailRaw
        ? validateEmail(emailRaw)
        : { valid: true, value: null };
      const emailClean = emailCheck.value;
      const fechaVal =
        birth_date && String(birth_date).trim()
          ? birth_date
          : null;

      if (!firstName || !lastName || !areaId) {
        return redirectPersonalEditarError(
          res,
          id,
          "Completa los campos obligatorios: Nombre, Apellido y Área.",
        );
      }

      if (documentoVal) {
        const { rows: repetido } = await db.query(
          "SELECT id FROM users WHERE national_id = $1 AND id <> $2",
          [documentoVal, id],
        );
        if (repetido.length) {
          return redirectPersonalEditarError(
            res,
            id,
            `Ya hay otro colaborador registrado con ese ${documentLabel()}.`,
          );
        }
      }

      if (!emailClean && !fechaVal) {
        return redirectPersonalEditarError(
          res,
          id,
          "La fecha de nacimiento es obligatoria para colaboradores sin correo.",
        );
      }

      if (!emailCheck.valid) {
        return redirectPersonalEditarError(res, id, emailCheck.error);
      }

      if (!telefonoCheck.valid) {
        return redirectPersonalEditarError(res, id, telefonoCheck.error);
      }

      if (emailClean) {
        const { rows: emailConflict } = await db.query(
          "SELECT id FROM users WHERE email = $1 AND id <> $2 LIMIT 1",
          [emailClean, id],
        );
        if (emailConflict.length > 0) {
          return redirectPersonalEditarError(
            res,
            id,
            "El correo ya está registrado por otro usuario.",
          );
        }
      }

      const { rows: prev } = await db.query(
        "SELECT photo AS foto, password_hash, email_confirmed, role, email FROM users WHERE id = $1",
        [id],
      );
      if (!prev.length) {
        return redirectPersonalEditarError(res, id, "Usuario no encontrado.");
      }
      const prevUser = prev[0];
      const prevEmail = prevUser.email ? String(prevUser.email).trim() : "";
      if (prevEmail && !emailClean) {
        return redirectPersonalEditarError(
          res,
          id,
          "No puedes quitar el correo de un usuario ya registrado en la intranet.",
        );
      }
      const previousUrl = prevUser.foto || null;
      const teniaPassword = Boolean(prevUser.password_hash);
      const correoVerificado = Boolean(prevUser.email_confirmed);
      const roleToSave = correoVerificado
        ? parseRoleFromForm(role)
        : ROLES.DESHABILITADO;
      const crearCuentaIntranet =
        !teniaPassword && puedeCrearCuentaIntranet(emailClean);
      const shouldRemovePhoto =
        eliminar_foto === "1" || eliminar_foto === "true";

      let fotoValue;
      if (req.file) {
        fotoValue = await userPhotoStorage.saveUserPhotoReplacing(
          id,
          req.file.buffer,
          previousUrl,
        );
      } else if (shouldRemovePhoto) {
        await userPhotoStorage.removeUserPhoto(id, previousUrl);
        fotoValue = null;
      }

      const setClauses = [
        "first_name=$1",
        "last_name=$2",
        "role=$3",
        "work_area_id=$4",
        "birth_date=$5",
        "phone=$6",
        "email=$7",
        "hire_date=$8",
        "prior_years_credited=$9",
        "progressive_days_override=$10",
        "work_days_per_week=$11",
        "national_id=$12",
      ];
      const values = [
        firstName,
        lastName,
        roleToSave,
        areaId,
        fechaVal,
        telefonoVal,
        emailClean,
        hireVal,
        priorYearsVal,
        progressiveOverrideVal,
        workDaysVal,
        documentoVal,
      ];

      if (fotoValue !== undefined) {
        setClauses.push(`photo=$${values.length + 1}`);
        values.push(fotoValue);
      }

      let successMsg = "Usuario+actualizado+correctamente";
      let passwordTemporalNueva = null;
      if (crearCuentaIntranet) {
        const credenciales = generarCredencialesTemporales();
        passwordTemporalNueva = credenciales.passwordTemporal;
        setClauses.push(
          `password_hash=$${values.length + 1}`,
          `password_salt=$${values.length + 2}`,
          "email_confirmed=FALSE",
          "must_change_password=TRUE",
          "is_intranet_user=TRUE",
          "confirm_token=NULL",
          "confirm_expires=NULL",
        );
        values.push(credenciales.hashHex, credenciales.saltHex);
        successMsg =
          "Usuario+actualizado.+Se+envió+la+clave+temporal+al+correo.";
      }

      values.push(id);
      await db.query(
        `UPDATE users SET ${setClauses.join(", ")} WHERE id=$${values.length}`,
        values,
      );

      // La ficha muestra el conjunto completo de centros activos, así que lo
      // que venga marcado es el estado final; sin casillas, ninguno.
      // Con el centro de gastos apagado no hay campo que leer y no se toca nada.
      const centrosEditar = isFeatureEnabled("expenseCenter")
        ? await costCenterService.setUserCostCenters(
            id,
            req.body.cost_center_ids,
          )
        : { ok: true };
      if (!centrosEditar.ok) {
        return redirectPersonalEditarError(res, id, centrosEditar.error);
      }

      if (
        req.session.user &&
        String(req.session.user.id) === String(id)
      ) {
        await refreshSessionIdentity(req, id);
      }

      if (passwordTemporalNueva) {
        await enviarClaveTemporal(emailClean, firstName, passwordTemporalNueva);
      }

      // Recalcula períodos de vacaciones si hay fecha de ingreso.
      if (hireVal) {
        balanceService
          .recalculatePeriods(id)
          .catch((e) => console.error("[Vacaciones] recalc al editar:", e.message));
      }

      res.redirect(`/RRHH/personal?ok=1&msg=${successMsg}`);
    } catch (err) {
      if (err && err.code === "23505") {
        return redirectPersonalEditarError(
          res,
          id,
          "El correo ya está registrado por otro usuario.",
        );
      }
      console.error(err);
      return redirectPersonalEditarError(res, id, "Error actualizando usuario.");
    }
  },
);

router.post("/eliminar/:id", requireRole.administrador(), async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await db.query(
      "SELECT photo AS foto FROM users WHERE id = $1",
      [id],
    );
    if (!rows.length) {
      return res.status(404).send("Usuario no encontrado");
    }
    await userPhotoStorage.removeUserPhoto(id, rows[0].foto);

    await db.query("DELETE FROM users WHERE id = $1", [id]);
    res.redirect("/RRHH/personal?ok=1&msg=Usuario+eliminado+correctamente");
  } catch (err) {
    console.error(err);
    res.status(500).send("Error eliminando usuario");
  }
});

// ==========================================
// RUTAS DE ORGANIGRAMA
// ==========================================

router.get("/organigrama", async (req, res) => {
  const organigramaUrl = await getOrganigramaUrl();
  res.render("RRHH/organigrama", {
    titulo: "Organigrama",
    organigramaUrl,
    user: req.session.user,
  });
});

router.post(
  "/organigrama/subir",
  requireRole.administrador(),
  uploadOrganigram.single("organigrama"),
  async (req, res) => {
    if (!req.file) return res.status(400).send("No se subió archivo.");

    try {
      await fileStorage.deleteFolder("organigrama");

      const result = await fileStorage.saveFile(
        req.file.buffer,
        "organigrama",
        req.file.originalname,
      );

      urlOrganigramaActual = result.secure_url;
      versionCache = Date.now();

      if (req.session.user && req.session.user.id) {
        await db.query(
          "INSERT INTO change_log (user_id, action, section, link_path) VALUES ($1, $2, $3, $4)",
          [
            req.session.user.id,
            "actualizó",
            "Organigrama",
            "/RRHH/organigrama",
          ],
        );
      }

      res.redirect("/RRHH/organigrama");
    } catch (err) {
      console.error("Error en subida de organigrama:", err);
      res.status(500).send("Error subiendo archivo.");
    }
  },
);

router.post(
  "/organigrama/eliminar",
  requireRole.administrador(),
  async (req, res) => {
    try {
      await fileStorage.deleteFolder("organigrama");
      urlOrganigramaActual = null;
      res.redirect("/RRHH/organigrama");
    } catch (e) {
      console.error("Error eliminando:", e);
      res.status(500).send("Error al eliminar.");
    }
  },
);

// ==========================================
// ÁREAS DE TRABAJO
// ==========================================

router.get("/areas", async (req, res) => {
  try {
    const [areasResult, peopleResult] = await Promise.all([
      db.query(
        `SELECT w.id, w.area_name, w.color, w.manager_user_id,
                m.first_name AS manager_first_name,
                m.last_name  AS manager_last_name
         FROM work_areas w
         LEFT JOIN users m ON m.id = w.manager_user_id
         ORDER BY w.area_name ASC`,
      ),
      db.query(
        `SELECT u.id, u.first_name, u.last_name, u.photo, u.work_area_id,
                at.area_name, at.color AS area_color
         FROM users u
         LEFT JOIN work_areas at ON at.id = u.work_area_id
         ORDER BY u.last_name ASC NULLS LAST, u.first_name ASC`,
      ),
    ]);

    const people = peopleResult.rows.map((row) => formatAreaMember(row));
    const peopleByArea = new Map();
    const unassigned = [];
    for (const person of people) {
      const areaId = person.work_area_id ? Number(person.work_area_id) : null;
      if (areaId) {
        const list = peopleByArea.get(areaId) || [];
        list.push(person);
        peopleByArea.set(areaId, list);
      } else {
        unassigned.push(person);
      }
    }

    const areas = areasResult.rows.map((area) => {
      const members = peopleByArea.get(Number(area.id)) || [];
      const managerName = [area.manager_first_name, area.manager_last_name]
        .filter(Boolean)
        .join(" ")
        .trim();
      return {
        ...enrichAreaWithPill(area),
        members,
        memberCount: members.length,
        managerName: managerName || null,
      };
    });

    const successMsg =
      req.query.ok === "1"
        ? decodeURIComponent(req.query.msg || "Operación exitosa")
        : null;
    const errorMsg = req.query.error
      ? decodeURIComponent(req.query.error)
      : null;

    res.render("RRHH/areas", {
      titulo: "Áreas de trabajo",
      areas,
      people,
      unassigned,
      colorPalette: COLOR_PALETTE,
      defaultColor: DEFAULT_COLOR,
      user: req.session.user,
      success: successMsg,
      error: errorMsg,
    });
  } catch (err) {
    console.error("Error consultando áreas:", err);
    res.status(500).send("Error consultando áreas");
  }
});

router.post("/areas", requireRole.administrador(), async (req, res) => {
  const areaName = parseAreaName(req.body.area_name);
  const color = parseAreaColor(req.body.color);
  if (!areaName) {
    return redirectAreasError(res, "El nombre del área es obligatorio.");
  }

  try {
    // queryRetryIdCollision y no query: work_areas usa un id aleatorio de 4
    // dígitos y dos altas simultáneas pueden recibir el mismo candidato.
    await db.queryRetryIdCollision(
      "INSERT INTO work_areas (area_name, color) VALUES ($1, $2)",
      [areaName, color],
    );
    // El área nace sin jefe: todavía no tiene miembros entre los cuales elegirlo.
    return redirectAreasOk(
      res,
      "Área creada. Asígnale colaboradores y luego designa a su jefe.",
    );
  } catch (err) {
    if (isUniqueViolation(err)) {
      return redirectAreasError(res, "Ya existe un área con ese nombre.");
    }
    console.error("Error creando área:", err);
    return redirectAreasError(res, "No se pudo crear el área.");
  }
});

router.post("/areas/:id", requireRole.administrador(), async (req, res) => {
  const areaId = parsePositiveInt(req.params.id);
  const areaName = parseAreaName(req.body.area_name);
  const color = parseAreaColor(req.body.color);
  if (!areaId) {
    return redirectAreasError(res, "Área inválida.");
  }
  if (!areaName) {
    return redirectAreasError(res, "El nombre del área es obligatorio.");
  }

  try {
    const manager = await parseAreaManager(req.body.manager_user_id, areaId);
    if (!manager.ok) return redirectAreasError(res, manager.error);

    const { rowCount } = await db.query(
      `UPDATE work_areas
          SET area_name = $1, color = $2, manager_user_id = $3
        WHERE id = $4`,
      [areaName, color, manager.managerId, areaId],
    );
    if (!rowCount) {
      return redirectAreasError(res, "El área no existe.");
    }
    invalidarCachesDeArea();
    if (Number(req.session.user?.work_area_id) === areaId) {
      await refreshSessionIdentity(req, req.session.user.id);
    }
    return redirectAreasOk(res, "Área actualizada.");
  } catch (err) {
    if (isUniqueViolation(err)) {
      return redirectAreasError(res, "Ya existe un área con ese nombre.");
    }
    console.error("Error actualizando área:", err);
    return redirectAreasError(res, "No se pudo actualizar el área.");
  }
});

router.post(
  "/areas/:id/eliminar",
  requireRole.administrador(),
  async (req, res) => {
    const areaId = parsePositiveInt(req.params.id);
    if (!areaId) {
      return redirectAreasError(res, "Área inválida.");
    }

    try {
      const { rows } = await db.query(
        "SELECT COUNT(*)::int AS n FROM users WHERE work_area_id = $1",
        [areaId],
      );
      if (rows[0].n > 0) {
        return redirectAreasError(
          res,
          "No se puede eliminar un área con colaboradores. Muévelos primero.",
        );
      }

      // La carpeta de procedimientos y protocolos muere con el área. Las filas
      // de documents las limpia el ON DELETE CASCADE, pero los objetos del
      // bucket no tienen FK: hay que borrarlos a mano y antes del DELETE, que
      // es cuando todavía se pueden consultar.
      const { rows: docs } = await db.query(
        `SELECT public_id FROM documents
          WHERE work_area_id = $1 AND public_id IS NOT NULL`,
        [areaId],
      );

      const { rowCount } = await db.query(
        "DELETE FROM work_areas WHERE id = $1",
        [areaId],
      );
      if (!rowCount) {
        return redirectAreasError(res, "El área no existe.");
      }

      // Un fallo de storage no debe deshacer el borrado ya confirmado en BD:
      // deja archivos huérfanos en el bucket, que es recuperable; abortar aquí
      // dejaría el área a medio eliminar, que no lo es.
      if (docs.length) {
        const { failed } = await fileStorage.deleteFiles(
          docs.map((d) => d.public_id),
        );
        if (failed) {
          console.error(
            `[Áreas] ${failed} archivo(s) del área ${areaId} no se pudieron borrar del storage.`,
          );
        }
      }

      invalidarCachesDeArea();
      return redirectAreasOk(
        res,
        docs.length
          ? `Área eliminada junto con ${docs.length} documento(s) de su carpeta.`
          : "Área eliminada.",
      );
    } catch (err) {
      console.error("Error eliminando área:", err);
      return redirectAreasError(res, "No se pudo eliminar el área.");
    }
  },
);

router.post(
  "/areas/:id/miembros",
  requireRole.administrador(),
  async (req, res) => {
    const areaId = parsePositiveInt(req.params.id);
    // El modal manda una casilla por persona, así que user_id llega como lista;
    // el formato de un solo valor se sigue aceptando.
    const userIds = [].concat(req.body.user_id || []).map(parsePositiveInt);
    if (!areaId || !userIds.length || userIds.some((id) => !id)) {
      return redirectAreasError(res, "Datos inválidos.");
    }

    try {
      const [areaResult, usersResult] = await Promise.all([
        db.query("SELECT id FROM work_areas WHERE id = $1", [areaId]),
        db.query("SELECT id FROM users WHERE id = ANY($1::int[])", [userIds]),
      ]);
      if (!areaResult.rows.length) {
        return redirectAreasError(res, "El área no existe.");
      }
      // Si alguno de los ids no existe se corta entero: asignar "los que sí"
      // dejaría al administrador sin saber cuáles quedaron fuera.
      if (usersResult.rows.length !== userIds.length) {
        return redirectAreasError(res, "Alguno de los colaboradores ya no existe.");
      }

      await db.query(
        "UPDATE users SET work_area_id = $1 WHERE id = ANY($2::int[])",
        [areaId, userIds],
      );
      // Quien venía de otra área y allí era jefe deja esa jefatura vacante.
      for (const userId of userIds) {
        await limpiarJefaturaHuerfana(userId);
      }
      invalidarCachesDeArea();
      await refreshSessionIdentity(req, req.session.user?.id);
      return redirectAreasOk(
        res,
        userIds.length === 1
          ? "Colaborador asignado al área."
          : `${userIds.length} colaboradores asignados al área.`,
      );
    } catch (err) {
      console.error("Error asignando colaborador:", err);
      return redirectAreasError(res, "No se pudo asignar el colaborador.");
    }
  },
);

router.post(
  "/areas/:id/miembros/:userId/quitar",
  requireRole.administrador(),
  async (req, res) => {
    const areaId = parsePositiveInt(req.params.id);
    const userId = parsePositiveInt(req.params.userId);
    if (!areaId || !userId) {
      return redirectAreasError(res, "Datos inválidos.");
    }

    try {
      const client = await db.getClient();
      let eraJefe = false;
      try {
        await client.query("BEGIN");
        const { rowCount } = await client.query(
          `UPDATE users
           SET work_area_id = NULL
           WHERE id = $1 AND work_area_id = $2`,
          [userId, areaId],
        );
        if (!rowCount) {
          await client.query("ROLLBACK");
          return redirectAreasError(res, "Colaborador no encontrado en esta área.");
        }
        // En la misma transacción: quien sale del área no puede seguir siendo
        // su jefe, y dejar la FK apuntando fuera bloquearía las aprobaciones.
        const { rowCount: jefaturas } = await client.query(
          "UPDATE work_areas SET manager_user_id = NULL WHERE id = $1 AND manager_user_id = $2",
          [areaId, userId],
        );
        eraJefe = jefaturas > 0;
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }

      invalidarCachesDeArea();
      await refreshSessionIdentity(req, userId);
      return redirectAreasOk(
        res,
        eraJefe
          ? "Colaborador quitado del área. El área quedó sin jefe: designa uno para que su gente pueda rendir gastos."
          : "Colaborador quitado del área.",
      );
    } catch (err) {
      console.error("Error quitando colaborador:", err);
      return redirectAreasError(res, "No se pudo quitar el colaborador.");
    }
  },
);

router.post(
  "/areas/:id/miembros/:userId/mover",
  requireRole.administrador(),
  async (req, res) => {
    const areaId = parsePositiveInt(req.params.id);
    const userId = parsePositiveInt(req.params.userId);
    const targetAreaId = parsePositiveInt(req.body.target_area_id);
    if (!areaId || !userId || !targetAreaId) {
      return redirectAreasError(res, "Datos inválidos.");
    }
    if (targetAreaId === areaId) {
      return redirectAreasError(res, "Selecciona un área distinta.");
    }

    try {
      const [targetResult, userResult] = await Promise.all([
        db.query("SELECT id, area_name FROM work_areas WHERE id = $1", [
          targetAreaId,
        ]),
        db.query(
          "SELECT id, work_area_id FROM users WHERE id = $1",
          [userId],
        ),
      ]);
      if (!targetResult.rows.length) {
        return redirectAreasError(res, "El área destino no existe.");
      }
      const user = userResult.rows[0];
      if (!user) {
        return redirectAreasError(res, "Colaborador no encontrado.");
      }
      if (Number(user.work_area_id) !== areaId) {
        return redirectAreasError(res, "Colaborador no encontrado en esta área.");
      }

      const client = await db.getClient();
      let eraJefe = false;
      try {
        await client.query("BEGIN");
        await client.query("UPDATE users SET work_area_id = $1 WHERE id = $2", [
          targetAreaId,
          userId,
        ]);
        const { rowCount: jefaturas } = await client.query(
          "UPDATE work_areas SET manager_user_id = NULL WHERE id = $1 AND manager_user_id = $2",
          [areaId, userId],
        );
        eraJefe = jefaturas > 0;
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }

      invalidarCachesDeArea();
      await refreshSessionIdentity(req, userId);
      const destName = targetResult.rows[0].area_name;
      if (eraJefe) {
        return redirectAreasOk(
          res,
          `Colaborador movido a «${destName}». Su área anterior quedó sin jefe: designa uno.`,
        );
      }
      return redirectAreasOk(
        res,
        destName
          ? `Colaborador movido a «${destName}».`
          : "Colaborador movido de área.",
      );
    } catch (err) {
      console.error("Error moviendo colaborador:", err);
      return redirectAreasError(res, "No se pudo mover el colaborador.");
    }
  },
);

// Sub-módulos montados bajo /RRHH
const vacationsRouter = require("./vacations");
router.use("/vacaciones", vacationsRouter);

const costCentersRouter = require("./costCenters");
router.use("/centros-costo", costCentersRouter);

module.exports = router;
