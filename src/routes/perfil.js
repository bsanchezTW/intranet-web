/** Mi perfil: datos personales y foto. */
const express = require("express");
const db = require("../db");
const {
  validateNationalId,
  formatNationalId,
  nationalIdClientConfig,
} = require("../utils/nationalId");
const multer = require("multer");
const userPhotoStorage = require("../services/userPhotoStorage");
const { UPLOAD_LIMITS_BYTES } = require("../config/uploadLimits");
const { toTitleCase } = require("../utils/formatName");
const { applyIdentityToSession } = require("../utils/monogram");
const requirePermission = require("../middlewares/requirePermission");
const {
  toTelHref,
  formatPhoneForDisplay,
  validateMobilePhone,
} = require("../utils/phone");

const router = express.Router();

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


// ==========================================
// RUTAS DE PERFIL
// ==========================================
router.get("/perfil", requirePermission("perfil.acceso"), async (req, res) => {
  if (!req.session.user) return res.redirect("/login");
  const id = req.session.user.id;
  const { rows } = await db.query(
    `SELECT u.*, at.area_name AS area, at.color AS area_color
     FROM users u
     LEFT JOIN work_areas at ON at.id = u.work_area_id
     WHERE u.id = $1`,
    [id],
  );
  if (rows.length === 0) return res.redirect("/");
  const raw = rows[0];
  // El documento se puede completar una vez; corregirlo después es cosa de
  // RR.HH., porque es el dato con el que se emiten los reembolsos.
  const documentoBloqueado = Boolean(raw.national_id);

  res.render("perfil", {
    titulo: "Mi perfil",
    documentoConfig: nationalIdClientConfig(),
    documentoBloqueado,
    success: typeof req.query.ok === "string" ? req.query.ok : null,
    error: typeof req.query.error === "string" ? req.query.error : null,
    // Viene de la URL: la vista lo escapa, pero sólo se acepta texto.
    passwordError:
      typeof req.query.password_error === "string" ? req.query.password_error : null,
    openPasswordModal: req.query.openPasswordModal === "1",
    usuario: {
      ...raw,
      photo: raw.photo ?? raw.foto,
      birth_date_input: raw.birth_date
        ? new Date(raw.birth_date).toISOString().slice(0, 10)
        : "",
      phone: formatPhoneForDisplay(raw.phone) || raw.phone,
      telefonoHref: toTelHref(raw.phone),
      documento: formatNationalId(raw.national_id),
    },
  });
});

router.post("/perfil", requirePermission("perfil.propio.editar"), async (req, res) => {
  if (!req.session.user) return res.redirect("/login");

  const userId = req.session.user.id;
  const firstName = toTitleCase(req.body.first_name);
  const lastName = toTitleCase(req.body.last_name);
  const fechaNacimiento =
    String(req.body.birth_date || req.body.fecha_nacimiento || "").trim() || null;
  const telefonoCheck = validateMobilePhone(req.body.phone || req.body.telefono, {
    required: true,
  });

  if (!firstName || !lastName || !fechaNacimiento) {
    return res.redirect(
      `/perfil?error=${encodeURIComponent("Completa nombre, apellido y fecha de nacimiento.")}`,
    );
  }

  if (!telefonoCheck.valid) {
    return res.redirect(
      `/perfil?error=${encodeURIComponent(telefonoCheck.error)}`,
    );
  }

  const documentoCheck = validateNationalId(req.body.national_id);
  if (!documentoCheck.valid) {
    return res.redirect(`/perfil?error=${encodeURIComponent(documentoCheck.error)}`);
  }

  try {
    // COALESCE y no una asignación directa: si el colaborador ya tiene
    // documento, este formulario no lo puede cambiar. Un POST a mano tampoco.
    await db.query(
      `UPDATE users
       SET first_name = $1,
           last_name = $2,
           birth_date = $3,
           phone = $4,
           national_id = COALESCE(national_id, $5)
       WHERE id = $6`,
      [
        firstName,
        lastName,
        fechaNacimiento,
        telefonoCheck.storageValue,
        documentoCheck.storageValue,
        userId,
      ],
    );

    applyIdentityToSession(req.session.user, {
      first_name: firstName,
      last_name: lastName,
    });
    req.session.user.telefono = telefonoCheck.storageValue;
    req.session.user.fecha_nacimiento = fechaNacimiento;

    res.redirect("/perfil?ok=Perfil+actualizado");
  } catch (err) {
    if (err && err.code === "23505" && String(err.constraint || "").includes("national_id")) {
      return res.redirect(
        `/perfil?error=${encodeURIComponent("Ese documento ya está registrado en otra ficha. Avísale a RRHH.")}`,
      );
    }
    console.error("Error actualizando perfil:", err);
    res.redirect(
      `/perfil?error=${encodeURIComponent("No se pudo actualizar el perfil. Intenta nuevamente.")}`,
    );
  }
});

router.post("/perfil/foto", requirePermission("perfil.propio.editar"), uploadProfilePhoto.single("foto_perfil"), async (req, res) => {
  if (!req.session.user || !req.file) return res.redirect("/perfil");
  try {
    const userId = req.session.user.id;
    const { rows } = await db.query("SELECT photo AS foto FROM users WHERE id = $1", [
      userId,
    ]);
    const previousUrl = rows[0]?.foto || null;
    const fotoUrl = await userPhotoStorage.saveUserPhotoReplacing(
      userId,
      req.file.buffer,
      previousUrl,
    );
    await db.query("UPDATE users SET photo = $1 WHERE id = $2", [
      fotoUrl,
      userId,
    ]);
    req.session.user.foto = fotoUrl;
    req.session.user.photo = fotoUrl;
    res.redirect("/perfil");
  } catch (err) {
    console.error(err);
    res.status(500).send("Error");
  }
});

router.post("/perfil/foto/eliminar", requirePermission("perfil.propio.editar"), async (req, res) => {
  if (!req.session.user) return res.redirect("/login");
  try {
    const userId = req.session.user.id;
    const { rows } = await db.query("SELECT photo AS foto FROM users WHERE id = $1", [
      userId,
    ]);
    const previousUrl = rows[0]?.foto || null;
    await userPhotoStorage.removeUserPhoto(userId, previousUrl);
    await db.query("UPDATE users SET photo = NULL WHERE id = $1", [userId]);
    req.session.user.foto = null;
    req.session.user.photo = null;
    res.redirect("/perfil");
  } catch (err) {
    console.error(err);
    res.status(500).send("Error");
  }
});

module.exports = router;
