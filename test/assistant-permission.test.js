const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ejs = require("ejs");

process.env.COUNTRY = process.env.COUNTRY || "CL";

const { getCountryConfig } = require("../src/config/country");
const { getFeatures } = require("../src/config/features");
const { getMonogram } = require("../src/utils/monogram");
const { getCatalog } = require("../src/services/permissions/catalog");
const { computePermissions, emptyPermissions } = require("../src/services/permissions/resolver");
const { buildViewCan } = require("../src/services/permissions/viewCan");

/*
  «Usar el asistente de la intranet» (asistente.acceso): sin él no se ve el
  botón de Luna ni responde /claude. Antes el permiso existía en el catálogo
  pero nada lo revisaba: con o sin él, todos lo veían.
*/

const SRC = path.join(__dirname, "..", "src");
const CL = getCatalog("CL");

function permisos(keys) {
  const snapshot = {
    users: new Map([[8, { id: 8, role: "Usuario", work_area_id: 1 }]]),
    areas: [{ id: 1, parent_area_id: null, manager_user_id: null }],
    assignments: keys.map((key, i) => ({ id: i + 1, principal_type: "user", user_id: 8, permission_key: key, scope_area_ids: [], effect: "concede" })),
  };
  return computePermissions(snapshot, { id: 8 }, { catalog: CL });
}

async function layout(perms) {
  const usuario = { id: 8, nombre: "Ana Pérez", first_name: "Ana", last_name: "Pérez", area_color: null };
  return ejs.renderFile(path.join(SRC, "views", "layout.ejs"), {
    body: "<p>contenido</p>",
    titulo: "Inicio",
    formatPageTitle: (t) => t,
    getMonogram,
    country: "CL",
    countryConfig: getCountryConfig("CL"),
    features: { ...getFeatures("CL"), claudeAssistant: true, supportTickets: false },
    esqueletoPagina: null,
    usuario,
    perms,
    can: buildViewCan(perms),
    canManageRrhh: false,
    isAreaManager: false,
    canIssueBills: false,
    veListadoCarpetas: false,
    unreadTickets: 0,
    cspNonce: "",
    suplantacion: null,
    maxTicketAttachmentMb: 10,
  }, { async: false });
}

describe("permiso del asistente", () => {
  it("sin el permiso no se carga el asistente", async () => {
    const html = await layout(permisos([]));
    assert.doesNotMatch(html, /claude-assistant\.js/);
    assert.doesNotMatch(html, /claude-assistant\.css/);
    assert.match(html, /contenido/);
  });

  it("con el permiso sí", async () => {
    const html = await layout(permisos(["asistente.acceso"]));
    assert.match(html, /claude-assistant\.js/);
    assert.match(html, /claude-assistant\.css/);
  });

  it("el superadmin lo tiene", async () => {
    const sa = emptyPermissions(CL, 1);
    sa.superadmin = true;
    assert.match(await layout(sa), /claude-assistant\.js/);
  });

  it("/claude exige el permiso, no sólo que el módulo esté encendido", () => {
    const app = fs.readFileSync(path.join(SRC, "app.js"), "utf8");
    const montaje = app.split("\n").find((l) => l.includes('app.use("/claude"'));
    assert.ok(montaje, "no encontré el montaje de /claude");
    assert.match(montaje, /requirePermission\("asistente\.acceso"\)/);
  });
});
