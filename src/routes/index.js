const express = require("express");

/**
 * Rutas de la raíz que exigen sesión (app.js las monta tras requireAuth).
 * Antes era un archivo de ~1 900 líneas; cada parte vive ahora en su
 * módulo. El orden de montaje es el de antes.
 */

const home = require("./home");
const perfil = require("./perfil");
const cursos = require("./cursos");
const apps = require("./apps");

const router = express.Router();
router.use(home);
router.use(perfil);
router.use(cursos);
router.use(apps);

module.exports = router;
module.exports.startHomeBackgroundJobs = home.startHomeBackgroundJobs;
