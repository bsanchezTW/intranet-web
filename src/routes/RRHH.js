const express = require("express");
const router = express.Router();
const db = require("../db");
const multer = require("multer");
const crypto = require("crypto");
const fileStorage = require("../services/fileStorage");
const userPhotoStorage = require("../services/userPhotoStorage");
const { UPLOAD_LIMITS_BYTES } = require("../config/uploadLimits");
const { ROLES, ALL_ROLES, isDeshabilitado } = require("../constants/roles");
const {
  DEFAULT_COLOR,
  COLOR_PALETTE,
  getWorkAreaPill,
  getWorkAreaPillClass,
  enrichAreaWithPill,
  normalizeHex,
} = require("../constants/workAreas");
const { buildTree, chainFrom, wouldCreateCycle } = require("../services/workAreaTree");
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
const requireRrhhManager = require("../middlewares/requireRrhhManager");
const requireFeature = require("../middlewares/requireFeature");
const { sendMail } = require("../services/mailer");
const { MAIL_SENDERS } = require("../constants/mailSenders");
const { escapeHtml, secretBox } = require("../services/emailLayout");
const { toTitleCase } = require("../utils/formatName");
const { getMonogram, applyIdentityToSession } = require("../utils/monogram");
const {
  validateMobilePhone,
  validateWorkPhone,
  maskPhone,
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
const {
  companyEmail,
  companyEmailSql,
  accountUsesPersonalEmail,
  accountUsesPersonalEmailSql,
  maskEmail,
} = require("../utils/contactEmails");
const balanceService = require("../services/vacations/vacationBalanceService");
const profileService = require("../services/vacations/vacationProfileService");
const { invalidateFinanceTeam } = require("../services/expenses/financeTeam");
const { invalidateSupportTeam } = require("../services/tickets/supportTeam");
const { invalidateStaffAccess } = require("../services/access/staffAccess");
const { isAreaManager, isAvailableApprover } = require("../services/expenses/areaManager");

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

/**
 * Teléfono de empresa, correo personal y teléfono personal de la ficha. Son
 * opcionales; el correo de empresa se valida aparte porque es el login.
 * El error lleva el nombre del campo: el formulario tiene dos correos y dos
 * teléfonos, y "Teléfono incorrecto" solo no dice cuál.
 */
function validarContactoFicha({ work_phone, personal_email, phone }) {
  const workPhone = validateWorkPhone(work_phone);
  if (!workPhone.valid) return { error: `Teléfono de empresa: ${workPhone.error}` };
  const personalEmail = validateEmail(personal_email);
  if (!personalEmail.valid) return { error: `Correo personal: ${personalEmail.error}` };
  const personalPhone = validateMobilePhone(phone);
  if (!personalPhone.valid) return { error: `Teléfono personal: ${personalPhone.error}` };
  return {
    error: null,
    workPhone: workPhone.storageValue,
    personalEmail: personalEmail.value,
    personalPhone: personalPhone.storageValue,
  };
}


function redirectPersonalEditarError(res, id, message) {
  return res.redirect(
    `/RRHH/personal?editar=${encodeURIComponent(id)}&editarError=${encodeURIComponent(message)}`,
  );
}

const storage = multer.memoryStorage();
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
    subject: "Cuenta creada en Intranet",
    senderName: MAIL_SENDERS.hr,
    heading: "Cuenta creada",
    cta: { href: "/login", label: "Ingresar a la intranet" },
    html: `
      <p style="margin:0 0 16px 0;">Hola <strong>${escapeHtml(firstName)}</strong>,</p>
      <p style="margin:0 0 16px 0;">Tu cuenta fue creada en la Intranet Transworld.</p>
      ${secretBox(passwordTemporal, { label: "Contraseña temporal" })}
      <p style="margin:0; color:#51637a;">En el primer acceso te pediremos verificar tu correo y cambiar esta contraseña.</p>
    `,
    text: `Hola ${firstName}, tu contraseña temporal es: ${passwordTemporal}. Ingresa con tu correo y esta contraseña; en el primer acceso te pediremos verificar tu correo.`,
  })
    .then(() => true)
    .catch((mailErr) => {
      console.error("Error enviando correo:", mailErr.message);
      return false;
    });
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

/** Posición entre áreas hermanas: entero 1–999, o vacío (al final, por nombre). */
function parseSortOrder(value) {
  const n = parsePositiveInt(String(value ?? "").trim());
  return n && n <= 999 ? n : null;
}

// Las áreas se editan dentro del organigrama: cada cambio vuelve a él en modo
// edición, que es desde donde se hizo.
const ORGANIGRAMA_EDICION = "/RRHH/organigrama?editar=1";

function redirectAreasOk(res, msg) {
  return res.redirect(
    `${ORGANIGRAMA_EDICION}&ok=1&msg=${encodeURIComponent(msg)}`,
  );
}

function redirectAreasError(res, message) {
  return res.redirect(
    `${ORGANIGRAMA_EDICION}&error=${encodeURIComponent(message)}`,
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
function invalidarCachesDeArea() {
  invalidateFinanceTeam();
  invalidateSupportTeam();
  invalidateStaffAccess();
}

/**
 * Valida al jefe propuesto para un área. Devuelve { ok, managerId } o
 * { ok: false, error }. No se exige que pertenezca al área: gerentes y
 * administradores dirigen varias áreas desde la suya, y la jefatura no cambia
 * cuando la persona cambia de área.
 */
async function parseAreaManager(rawValue) {
  const raw = String(rawValue ?? "").trim();
  if (!raw) return { ok: true, managerId: null };

  const managerId = parsePositiveInt(raw);
  if (!managerId) return { ok: false, error: "Jefe de área inválido." };

  const { rows } = await db.query("SELECT id FROM users WHERE id = $1", [managerId]);
  if (!rows.length) {
    return { ok: false, error: "El colaborador elegido como jefe no existe." };
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
    titulo: "Recursos humanos",
    user: req.session.user,
  });
});

// 2. LISTADO DE PERSONAL
// Lo ve cualquier usuario: muestra el contacto de empresa completo y el
// personal enmascarado (parte del correo, últimos 4 dígitos del teléfono). El
// dato real no llega al navegador; RR.HH. lo ve y corrige en la ficha.
router.get("/personal", async (req, res) => {
  const sql = `
    SELECT
      u.id,
      u.first_name,
      u.last_name,
      ${companyEmailSql("u")} AS email,
      ${accountUsesPersonalEmailSql("u")} AS cuenta_con_correo_personal,
      u.role,
      u.photo,
      u.birth_date,
      u.work_area_id,
      u.work_phone,
      u.personal_email,
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
      const workPhoneRaw = p.work_phone;
      const partes = parseFechaNacimiento(birthDate);
      const ordenCumple = partes ? partes.month * 100 + partes.day : 9999;
      const fechaCumpleFmt = partes
        ? `${String(partes.day).padStart(2, "0")}-${String(partes.month + 1).padStart(2, "0")}`
        : "-";

      const telefonoHref = toTelHref(workPhoneRaw);
      const telefonoDisplay = formatPhoneForDisplay(workPhoneRaw);
      const pill = getWorkAreaPill(p.area, p.area_color);

      const { personal_email: correoPersonalRaw, phone: telefonoPersonalRaw, ...resto } = p;
      const persona = {
        ...resto,
        work_phone: telefonoDisplay || workPhoneRaw,
        correoPersonal: maskEmail(correoPersonalRaw),
        telefonoPersonal: maskPhone(telefonoPersonalRaw),
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

router.get("/crear", requireRrhhManager(), (req, res) => {
  res.redirect("/RRHH/personal?abrirCrear=1");
});

// FIX: Se añaden los campos faltantes telefono al INSERT
// FIX: Validación clara con mensajes específicos
router.post("/crear", requireRrhhManager(), async (req, res) => {
  const {
    first_name,
    last_name,
    email,
    work_area_id,
    birth_date,
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
    const contacto = validarContactoFicha(req.body);
    // La cuenta usa el correo de empresa y, si no hay, el personal.
    const emailClean = emailCheck.value || contacto.personalEmail || null;
    const areaId = (work_area_id && String(work_area_id).trim()) ? Number(work_area_id) : null;

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

    if (contacto.error) {
      return redirectPersonalCrearError(res, contacto.error);
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

    // El modal de alta pregunta si enviar la clave temporal. Si RR.HH. dice
    // que no, la ficha queda sin credenciales y se envían después con el botón
    // «Enviar contraseña temporal» de la edición.
    const enviarClave = String(req.body.enviar_clave ?? "1") !== "0";
    const crearCuentaIntranet =
      enviarClave && puedeCrearCuentaIntranet(emailClean);
    let successMsg = "Colaborador+agregado+correctamente";
    let userId;

    if (crearCuentaIntranet) {
      const { passwordTemporal, saltHex, hashHex } =
        generarCredencialesTemporales();

      const { rows: inserted } = await db.queryRetryIdCollision(
        `INSERT INTO users
          (first_name, last_name, email, password_hash, password_salt, role, email_confirmed, must_change_password, work_area_id, birth_date, phone, is_intranet_user, home_tutorial_seen, hire_date, prior_years_credited, progressive_days_override, work_days_per_week, national_id, work_phone, personal_email)
        VALUES ($1, $2, $3, $4, $5, $6, FALSE, TRUE, $7, $8, $9, TRUE, FALSE, $10, $11, $12, $13, $14, $15, $16)
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
          contacto.personalPhone,
          hireVal,
          priorYearsVal,
          progressiveOverrideVal,
          workDaysVal,
          documentoVal,
          contacto.workPhone,
          contacto.personalEmail,
        ],
      );
      userId = inserted[0].id;

      const enviado = await enviarClaveTemporal(
        emailClean,
        firstName,
        passwordTemporal,
      );
      successMsg = enviado
        ? "Usuario+creado+correctamente.+Se+envió+la+clave+temporal+al+correo."
        : "Usuario+creado,+pero+no+se+pudo+enviar+el+correo.+Reintenta+desde+su+ficha.";
    } else {
      const { rows: inserted } = await db.queryRetryIdCollision(
        `INSERT INTO users
          (first_name, last_name, email, role, email_confirmed, must_change_password, work_area_id, birth_date, phone, is_intranet_user, hire_date, prior_years_credited, progressive_days_override, work_days_per_week, national_id, work_phone, personal_email)
        VALUES ($1, $2, $3, $4, FALSE, FALSE, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
        RETURNING id`,
        [
          firstName,
          lastName,
          emailClean,
          ROLES.DESHABILITADO,
          areaId,
          fechaVal,
          contacto.personalPhone,
          Boolean(emailClean),
          hireVal,
          priorYearsVal,
          progressiveOverrideVal,
          workDaysVal,
          documentoVal,
          contacto.workPhone,
          contacto.personalEmail,
        ],
      );
      userId = inserted[0].id;
      if (emailClean) {
        successMsg =
          "Colaborador+agregado+sin+enviar+la+clave+temporal.+Puedes+enviarla+desde+su+ficha.";
      }
    }

    // Genera los períodos de vacaciones si se registró fecha de ingreso y el
    // módulo existe en esta instancia.
    if (hireVal && isFeatureEnabled("vacations")) {
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

router.get("/editar/:id", requireRrhhManager(), async (req, res) => {
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
      work_phone:
        formatPhoneForDisplay(rows[0].work_phone) || rows[0].work_phone || "",
      // `email` sigue siendo el de la cuenta; el campo "Correo de empresa"
      // sólo se llena si no es el personal.
      correo_empresa: companyEmail(rows[0]) || "",
      cuenta_con_correo_personal: accountUsesPersonalEmail(rows[0]),
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
  requireRrhhManager(),
  uploadProfilePhoto.single("foto"),
  async (req, res) => {
    const { id } = req.params;
    const {
      first_name,
      last_name,
      role,
      work_area_id,
      birth_date,
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
      const contacto = validarContactoFicha(req.body);
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
      // La cuenta usa el correo de empresa y, si no hay, el personal.
      const emailClean = emailCheck.value || contacto.personalEmail || null;
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

      if (contacto.error) {
        return redirectPersonalEditarError(res, id, contacto.error);
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
        "SELECT photo AS foto, password_hash, email_confirmed, role, email, hire_date, national_id FROM users WHERE id = $1",
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
          "Deja al menos un correo, de empresa o personal: la cuenta de intranet usa uno.",
        );
      }
      const previousUrl = prevUser.foto || null;
      const correoVerificado = Boolean(prevUser.email_confirmed);
      const roleToSave = correoVerificado
        ? parseRoleFromForm(role)
        : ROLES.DESHABILITADO;
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
        "national_id=$9",
        "work_phone=$10",
        "personal_email=$11",
      ];
      const values = [
        firstName,
        lastName,
        roleToSave,
        areaId,
        fechaVal,
        contacto.personalPhone,
        emailClean,
        hireVal,
        documentoVal,
        contacto.workPhone,
        contacto.personalEmail,
      ];

      // Datos de vacaciones: sólo se guardan si la ficha los muestra. En Chile
      // las vacaciones van por Rex+ y el formulario no los trae; sin este
      // filtro, cada edición borraría lo que ya estaba cargado.
      const camposVacaciones = [
        ["prior_years_credited", priorYearsVal],
        ["progressive_days_override", progressiveOverrideVal],
        ["work_days_per_week", workDaysVal],
      ];
      for (const [columna, valor] of camposVacaciones) {
        if (!Object.prototype.hasOwnProperty.call(req.body, columna)) continue;
        setClauses.push(`${columna}=$${values.length + 1}`);
        values.push(valor);
      }

      if (fotoValue !== undefined) {
        setClauses.push(`photo=$${values.length + 1}`);
        values.push(fotoValue);
      }

      // La clave temporal ya no se envía sola al guardar: RR.HH. la manda
      // explícitamente con «Enviar contraseña temporal» (POST /enviar-clave/:id).
      const successMsg = "Usuario+actualizado+correctamente";

      values.push(id);
      await db.query(
        `UPDATE users SET ${setClauses.join(", ")} WHERE id=$${values.length}`,
        values,
      );

      // La fecha de ingreso y el documento mueven el cálculo de vacaciones:
      // el cambio queda en la bitácora de la ficha de vacaciones.
      if (isFeatureEnabled("vacations")) {
        profileService
          .auditProfileChange(db, {
            userId: id,
            actorId: req.session.user?.id,
            before: profileService.profileSnapshot(prevUser),
            after: profileService.profileSnapshot({
              hire_date: hireVal,
              national_id: documentoVal,
            }),
            reason: "Editado desde Personal",
          })
          .catch((e) => console.error("[Vacaciones] bitácora al editar:", e.message));
      }

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

      // Recalcula períodos de vacaciones si hay fecha de ingreso y el módulo existe.
      if (hireVal && isFeatureEnabled("vacations")) {
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

/**
 * Envía (o reenvía) la contraseña temporal a un colaborador deshabilitado.
 * La cuenta vuelve al flujo del primer acceso: clave temporal → código de
 * verificación → nueva contraseña. Al verificar el correo, /verify-email lo
 * pasa a Usuario porque la ficha tiene área (la creó RR.HH.).
 */
router.post("/enviar-clave/:id", requireRrhhManager(), async (req, res) => {
  const { id } = req.params;
  const responder = (status, ok, mensaje) => {
    if (req.get("X-Requested-With") === "fetch") {
      return res.status(status).json({ ok, message: mensaje });
    }
    if (!ok) return redirectPersonalEditarError(res, id, mensaje);
    return res.redirect(
      `/RRHH/personal?ok=1&msg=${encodeURIComponent(mensaje)}`,
    );
  };

  try {
    const { rows } = await db.query(
      "SELECT id, first_name, email, role, work_area_id FROM users WHERE id = $1",
      [id],
    );
    if (!rows.length) return responder(404, false, "Usuario no encontrado.");
    const u = rows[0];
    const email = u.email ? String(u.email).trim() : "";

    if (!email) {
      return responder(
        400,
        false,
        "El colaborador no tiene correo. Agrega uno y guarda la ficha antes de enviar la contraseña.",
      );
    }
    if (!isDeshabilitado(u.role)) {
      return responder(
        400,
        false,
        "Sólo se envía la contraseña temporal a usuarios deshabilitados.",
      );
    }
    if (u.work_area_id == null) {
      return responder(
        400,
        false,
        "Asigna un área de trabajo y guarda la ficha antes de enviar la contraseña.",
      );
    }

    const { passwordTemporal, saltHex, hashHex } =
      generarCredencialesTemporales();
    await db.query(
      `UPDATE users
       SET password_hash = $1,
           password_salt = $2,
           email_confirmed = FALSE,
           must_change_password = TRUE,
           is_intranet_user = TRUE,
           confirm_token = NULL,
           confirm_expires = NULL
       WHERE id = $3`,
      [hashHex, saltHex, id],
    );

    const enviado = await enviarClaveTemporal(
      email,
      u.first_name,
      passwordTemporal,
    );
    if (!enviado) {
      return responder(
        502,
        false,
        "No se pudo enviar el correo. Intenta de nuevo en unos minutos.",
      );
    }
    return responder(200, true, `Contraseña temporal enviada a ${email}.`);
  } catch (err) {
    console.error("Error enviando clave temporal:", err);
    return responder(500, false, "Error al enviar la contraseña temporal.");
  }
});

router.post("/eliminar/:id", requireRrhhManager(), async (req, res) => {
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

/**
 * Áreas con sus miembros, más el árbol del organigrama.
 *
 * Cada área sin jefe propio trae a quién se le escalan sus solicitudes
 * (inheritedManagerName): es lo que decide si su gente puede pedir fondos o
 * vacaciones, y conviene verlo en el nodo y no descubrirlo al solicitar.
 */
async function cargarOrganigrama() {
  const [areasResult, peopleResult] = await Promise.all([
    db.query(
      `SELECT w.id, w.area_name, w.color, w.manager_user_id, w.parent_area_id, w.sort_order,
              m.first_name AS manager_first_name,
              m.last_name  AS manager_last_name,
              m.photo      AS manager_photo,
              m.work_area_id AS manager_work_area_id,
              m.role AS manager_role,
              m.is_intranet_user AS manager_is_intranet_user
       FROM work_areas w
       LEFT JOIN users m ON m.id = w.manager_user_id
       ORDER BY w.area_name ASC`,
    ),
    db.query(
      `SELECT u.id, u.first_name, u.last_name, u.photo, u.work_area_id,
              u.role, u.is_intranet_user,
              at.area_name, at.color AS area_color
       FROM users u
       LEFT JOIN work_areas at ON at.id = u.work_area_id
       ORDER BY u.last_name ASC NULLS LAST, u.first_name ASC`,
    ),
  ]);

  const people = peopleResult.rows.map((row) => ({
    ...formatAreaMember(row),
    disponible: isAvailableApprover(row),
  }));
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
      managerAvailable: area.manager_user_id
        ? isAvailableApprover({ role: area.manager_role, is_intranet_user: area.manager_is_intranet_user })
        : null,
    };
  });

  const porId = new Map(areas.map((a) => [Number(a.id), a]));
  const personaPorId = new Map(people.map((p) => [Number(p.id), p]));
  const areasPorJefe = new Map();
  for (const area of areas) {
    if (!area.manager_user_id) continue;
    const clave = Number(area.manager_user_id);
    areasPorJefe.set(clave, (areasPorJefe.get(clave) || []).concat(area.area_name));
  }
  for (const area of areas) {
    const padre = area.parent_area_id ? porId.get(Number(area.parent_area_id)) : null;
    area.parentName = padre ? padre.area_name : null;
    // Un gerente puede dirigir áreas en las que no trabaja: el nodo dice desde
    // dónde viene y qué más dirige, para que no parezca un error de datos.
    area.managerOtherAreas = area.manager_user_id
      ? (areasPorJefe.get(Number(area.manager_user_id)) || []).filter((n) => n !== area.area_name)
      : [];
    area.managerHomeArea = null;
    if (area.manager_user_id && Number(area.manager_work_area_id) !== Number(area.id)) {
      const casa = porId.get(Number(area.manager_work_area_id));
      area.managerHomeArea = casa ? casa.area_name : "Sin área";
    }
    // Quien aprueba, para pintar su foto o monograma en el nodo: el jefe
    // propio o, si no hay, el del área superior al que se escala.
    area.approverPerson = area.manager_user_id
      ? personaPorId.get(Number(area.manager_user_id)) || null
      : null;
    area.inheritedManagerName = null;
    area.inheritedFromName = null;
    area.inheritedManagerAvailable = null;
    if (!area.manager_user_id) {
      const superior = chainFrom(areas, area.id)
        .slice(1)
        .find((a) => a.manager_user_id);
      if (superior) {
        area.inheritedManagerName = superior.managerName;
        area.inheritedFromName = superior.area_name;
        area.inheritedManagerAvailable = superior.managerAvailable;
        area.approverPerson = personaPorId.get(Number(superior.manager_user_id)) || null;
      }
    }
    // El aprobador existe pero no puede iniciar sesión: su gente no puede
    // enviar solicitudes hasta que RRHH habilite la cuenta o cambie el jefe.
    area.approverUnavailable = area.manager_user_id
      ? area.managerAvailable === false
      : area.inheritedManagerAvailable === false;
  }

  return { areas, arbol: buildTree(areas), people, unassigned };
}

// ==========================================
// ORGANIGRAMA Y ÁREAS DE TRABAJO
// ==========================================

// Una sola pantalla: todos leen el organigrama y quien gestiona RRHH lo edita
// ahí mismo con ?editar=1 (áreas, jefes, dependencias y colaboradores).
router.get("/organigrama", async (req, res) => {
  try {
    const { areas, arbol, people, unassigned } = await cargarOrganigrama();
    const editando =
      Boolean(res.locals.canManageRrhh) && req.query.editar === "1";

    res.render("RRHH/organigrama", {
      titulo: "Organigrama",
      areas,
      arbol,
      people,
      unassigned,
      editando,
      colorPalette: COLOR_PALETTE,
      defaultColor: DEFAULT_COLOR,
      user: req.session.user,
      success:
        req.query.ok === "1"
          ? String(req.query.msg || "Operación exitosa")
          : null,
      error: req.query.error ? String(req.query.error) : null,
    });
  } catch (err) {
    console.error("Error cargando organigrama:", err);
    res.status(500).send("Error cargando el organigrama");
  }
});

// La pantalla de Áreas se fundió con el organigrama: los enlaces y marcadores
// viejos caen en su modo edición (que sólo se activa para quien gestiona RRHH).
router.get("/areas", (req, res) => res.redirect(ORGANIGRAMA_EDICION));

/**
 * Valida el área de la que depende `areaId` (null al crear). Devuelve
 * { ok, parentId } o { ok: false, error }. Colgar un área de sí misma o de una
 * de sus hijas cerraría un ciclo y dejaría a esa rama sin raíz ni aprobador.
 */
async function parseParentArea(rawValue, areaId = null) {
  const raw = String(rawValue ?? "").trim();
  if (!raw) return { ok: true, parentId: null };

  const parentId = parsePositiveInt(raw);
  if (!parentId) return { ok: false, error: "Área superior inválida." };

  const { rows } = await db.query("SELECT id, parent_area_id FROM work_areas");
  if (!rows.some((r) => Number(r.id) === parentId)) {
    return { ok: false, error: "El área superior elegida no existe." };
  }
  if (areaId != null && wouldCreateCycle(rows, areaId, parentId)) {
    return {
      ok: false,
      error: "Un área no puede depender de sí misma ni de una de sus áreas dependientes.",
    };
  }
  return { ok: true, parentId };
}

router.post("/areas", requireRrhhManager(), async (req, res) => {
  const areaName = parseAreaName(req.body.area_name);
  const color = parseAreaColor(req.body.color);
  const sortOrder = parseSortOrder(req.body.sort_order);
  if (!areaName) {
    return redirectAreasError(res, "El nombre del área es obligatorio.");
  }

  try {
    const parent = await parseParentArea(req.body.parent_area_id);
    if (!parent.ok) return redirectAreasError(res, parent.error);
    const manager = await parseAreaManager(req.body.manager_user_id);
    if (!manager.ok) return redirectAreasError(res, manager.error);

    // queryRetryIdCollision y no query: work_areas usa un id aleatorio de 4
    // dígitos y dos altas simultáneas pueden recibir el mismo candidato.
    await db.queryRetryIdCollision(
      `INSERT INTO work_areas (area_name, color, parent_area_id, manager_user_id, sort_order)
       VALUES ($1, $2, $3, $4, $5)`,
      [areaName, color, parent.parentId, manager.managerId, sortOrder],
    );
    invalidarCachesDeArea();
    return redirectAreasOk(
      res,
      manager.managerId
        ? "Área creada. Ahora asígnale colaboradores."
        : "Área creada. Asígnale colaboradores y designa a su jefe.",
    );
  } catch (err) {
    if (isUniqueViolation(err)) {
      return redirectAreasError(res, "Ya existe un área con ese nombre.");
    }
    console.error("Error creando área:", err);
    return redirectAreasError(res, "No se pudo crear el área.");
  }
});

router.post("/areas/:id", requireRrhhManager(), async (req, res) => {
  const areaId = parsePositiveInt(req.params.id);
  const areaName = parseAreaName(req.body.area_name);
  const color = parseAreaColor(req.body.color);
  const sortOrder = parseSortOrder(req.body.sort_order);
  if (!areaId) {
    return redirectAreasError(res, "Área inválida.");
  }
  if (!areaName) {
    return redirectAreasError(res, "El nombre del área es obligatorio.");
  }

  try {
    const manager = await parseAreaManager(req.body.manager_user_id);
    if (!manager.ok) return redirectAreasError(res, manager.error);
    const parent = await parseParentArea(req.body.parent_area_id, areaId);
    if (!parent.ok) return redirectAreasError(res, parent.error);

    const { rowCount } = await db.query(
      `UPDATE work_areas
          SET area_name = $1, color = $2, manager_user_id = $3, parent_area_id = $4, sort_order = $5
        WHERE id = $6`,
      [areaName, color, manager.managerId, parent.parentId, sortOrder, areaId],
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
  requireRrhhManager(),
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
      const { rows: hijas } = await db.query(
        "SELECT COUNT(*)::int AS n FROM work_areas WHERE parent_area_id = $1",
        [areaId],
      );
      if (hijas[0].n > 0) {
        return redirectAreasError(
          res,
          "No se puede eliminar un área de la que dependen otras. Primero cuélgalas de otra área superior.",
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
  requireRrhhManager(),
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
  requireRrhhManager(),
  async (req, res) => {
    const areaId = parsePositiveInt(req.params.id);
    const userId = parsePositiveInt(req.params.userId);
    if (!areaId || !userId) {
      return redirectAreasError(res, "Datos inválidos.");
    }

    try {
      const { rowCount } = await db.query(
        `UPDATE users
         SET work_area_id = NULL
         WHERE id = $1 AND work_area_id = $2`,
        [userId, areaId],
      );
      if (!rowCount) {
        return redirectAreasError(res, "Colaborador no encontrado en esta área.");
      }

      invalidarCachesDeArea();
      await refreshSessionIdentity(req, userId);
      const sigueJefe = await isAreaManager({ id: userId });
      return redirectAreasOk(
        res,
        sigueJefe
          ? "Colaborador quitado del área. Sigue siendo jefe de las áreas que dirige: cámbialo al editar cada área."
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
  requireRrhhManager(),
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

      await db.query("UPDATE users SET work_area_id = $1 WHERE id = $2", [
        targetAreaId,
        userId,
      ]);

      invalidarCachesDeArea();
      await refreshSessionIdentity(req, userId);
      const destName = targetResult.rows[0].area_name;
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

// Feriados: fuera de Vacaciones porque Soporte los usa para el horario hábil.
const holidaysRouter = require("./holidays");
router.use("/feriados", holidaysRouter);
router.get("/vacaciones/feriados", (req, res) => res.redirect(301, "/RRHH/feriados"));

// Vacaciones sólo donde el módulo existe (en Chile se solicitan en Rex+).
const vacationsRouter = require("./vacations");
router.use("/vacaciones", requireFeature("vacations"), vacationsRouter);

// Centros de costo sólo donde existen (hoy, Chile).
const costCentersRouter = require("./costCenters");
router.use("/centros-costo", requireFeature("expenseCenter"), requireRrhhManager(), costCentersRouter);

module.exports = router;
