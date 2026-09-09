const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  APP_CATALOGS,
  APP_CATALOG_VALUES,
  DEFAULT_APP_CATALOG,
  normalizeAppCatalog,
  appCatalogPath,
} = require("../src/constants/appCatalogs");

describe("catálogos de aplicaciones", () => {
  it("separa el catálogo comercial del de soporte", () => {
    assert.deepEqual(APP_CATALOG_VALUES, ["corporate", "support"]);
    assert.equal(DEFAULT_APP_CATALOG, APP_CATALOGS.CORPORATE);
  });

  it("normaliza mayúsculas y espacios", () => {
    assert.equal(normalizeAppCatalog("SUPPORT"), APP_CATALOGS.SUPPORT);
    assert.equal(normalizeAppCatalog("  support  "), APP_CATALOGS.SUPPORT);
    assert.equal(normalizeAppCatalog("Corporate"), APP_CATALOGS.CORPORATE);
  });

  it("cae al catálogo corporativo ante valores desconocidos o vacíos", () => {
    // Un catálogo inválido no puede mandar una app a la vista de Soporte ni
    // romper el CHECK de la tabla: siempre aterriza en el catálogo por defecto.
    assert.equal(normalizeAppCatalog("support_apps"), APP_CATALOGS.CORPORATE);
    assert.equal(normalizeAppCatalog(""), APP_CATALOGS.CORPORATE);
    assert.equal(normalizeAppCatalog(null), APP_CATALOGS.CORPORATE);
    assert.equal(normalizeAppCatalog(undefined), APP_CATALOGS.CORPORATE);
    assert.equal(normalizeAppCatalog(42), APP_CATALOGS.CORPORATE);
  });

  it("cada catálogo redirige a la vista que lo lista", () => {
    assert.equal(appCatalogPath(APP_CATALOGS.CORPORATE), "/apps");
    assert.equal(appCatalogPath(APP_CATALOGS.SUPPORT), "/sistemas/tickets");
    assert.equal(appCatalogPath("desconocido"), "/apps");
  });
});

describe("orden de aplicaciones", () => {
  const { reorderAppsInCatalog } = require("../src/services/appCatalogService");
  const db = require("../src/db");

  /** Sustituye db.query y devuelve lo que recibió la última llamada. */
  function espiarQuery(resultado = { rowCount: 0 }) {
    const original = db.query;
    const llamadas = [];
    db.query = async (sql, params) => {
      llamadas.push({ sql, params });
      return resultado;
    };
    return {
      llamadas,
      restaurar() {
        db.query = original;
      },
    };
  }

  it("descarta ids no numéricos y conserva el orden recibido", async () => {
    const espia = espiarQuery({ rowCount: 2 });
    try {
      await reorderAppsInCatalog("support", ["3", 1, "x", null, "2"]);
      const { params } = espia.llamadas[0];
      assert.deepEqual(params[0], [3, 1, 2]);
      assert.equal(params[1], "support");
    } finally {
      espia.restaurar();
    }
  });

  it("acota el movimiento al catálogo indicado", async () => {
    const espia = espiarQuery({ rowCount: 1 });
    try {
      // Un catálogo inválido no puede reordenar el catálogo corporativo por
      // accidente: normalizeAppCatalog lo lleva al valor por defecto.
      await reorderAppsInCatalog("inventado", [1]);
      const { sql, params } = espia.llamadas[0];
      assert.match(sql, /a\.catalog = \$2/);
      assert.equal(params[1], "corporate");
    } finally {
      espia.restaurar();
    }
  });

  it("no consulta la base si no llegan ids utilizables", async () => {
    const espia = espiarQuery();
    try {
      assert.equal(await reorderAppsInCatalog("support", []), 0);
      assert.equal(await reorderAppsInCatalog("support", ["a", null]), 0);
      assert.equal(await reorderAppsInCatalog("support", null), 0);
      assert.equal(espia.llamadas.length, 0);
    } finally {
      espia.restaurar();
    }
  });
});
