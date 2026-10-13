const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  resolveHomeQuickAccess,
  sanitizeHomeQuickAccess,
} = require("../src/services/homeQuickAccess");

const FEATURES_CL = {
  chileHrPortals: true,
  supportTickets: true,
  vacations: false,
  expenseRequests: true,
};
const FEATURES_PE = {
  chileHrPortals: false,
  supportTickets: false,
  vacations: true,
};

const SITE_CL = "https://www.transworld.cl/";
const SITE_PE = "https://transworld.pe/";

function ids(items) {
  return items.map((item) => item.id);
}

function resolve(countryCode, features, preference, corporateSite) {
  return resolveHomeQuickAccess({
    countryCode,
    features,
    preference,
    corporateSite,
  });
}

describe("accesos rápidos del home", () => {
  it("Chile muestra el orden de hoy y Perú el conjunto propio", () => {
    const cl = resolve("CL", FEATURES_CL, null, SITE_CL);
    const pe = resolve("PE", FEATURES_PE, null, SITE_PE);

    assert.deepEqual(ids(cl.visible), [
      "site",
      "academy",
      "rex",
      "achs",
      "caja",
      "soporte",
    ]);
    assert.deepEqual(ids(cl.hidden), [
      "organigrama",
      "noticias",
      "galeria",
      "apps",
      "rendiciones",
    ]);
    assert.equal(
      cl.hidden.find((item) => item.id === "rendiciones").href,
      "/gastos/nueva/rendicion",
    );
    assert.equal(cl.visible[0].label, "transworld.cl");
    assert.equal(cl.visible[0].external, true);
    assert.equal(cl.visible[1].href, "/cursos");
    assert.equal(cl.visible.find((item) => item.id === "soporte").notif, true);

    assert.deepEqual(ids(pe.visible), [
      "site",
      "academy",
      "vacaciones",
      "organigrama",
      "noticias",
      "galeria",
    ]);
    assert.deepEqual(ids(pe.hidden), ["apps"]);
    assert.equal(pe.visible.length, 6);
    assert.equal(pe.visible[0].label, "transworld.pe");
    assert.equal(pe.visible[0].href, SITE_PE);
    assert.equal(
      pe.visible.find((item) => item.id === "vacaciones").href,
      "/RRHH/vacaciones",
    );
  });

  it("un ítem con la feature apagada no entra en la lista", () => {
    const pe = resolve(
      "PE",
      { ...FEATURES_PE, vacations: false },
      null,
      SITE_PE,
    );
    assert.ok(!ids(pe.visible).includes("vacaciones"));
    assert.ok(!ids(pe.visible).includes("soporte"));
    assert.ok(!ids(pe.visible).includes("rex"));
  });

  it("oculta, reordena y descarta ids de otro país", () => {
    const pe = resolve(
      "PE",
      FEATURES_PE,
      {
        order: ["rex", "academy", "site", "no-existe"],
        hidden: ["galeria", "soporte"],
      },
      SITE_PE,
    );

    assert.deepEqual(ids(pe.visible), [
      "academy",
      "site",
      "vacaciones",
      "organigrama",
      "noticias",
      "apps",
    ]);
    assert.deepEqual(ids(pe.hidden), ["galeria"]);
  });

  it("un id nuevo queda al final si hay cupo, y oculto si la barra ya tiene 6", () => {
    const conCupo = resolve(
      "PE",
      FEATURES_PE,
      {
        order: ["site", "academy"],
        hidden: ["galeria", "noticias", "apps"],
      },
      SITE_PE,
    );
    assert.deepEqual(ids(conCupo.visible), [
      "site",
      "academy",
      "vacaciones",
      "organigrama",
    ]);

    const llena = resolve(
      "PE",
      FEATURES_PE,
      {
        order: ["site", "academy", "vacaciones", "organigrama", "noticias", "galeria"],
        hidden: [],
      },
      SITE_PE,
    );
    assert.equal(llena.visible.length, 6);
    assert.deepEqual(ids(llena.hidden), ["apps"]);
  });

  it("acepta la preferencia guardada como JSON", () => {
    const cl = resolve(
      "CL",
      FEATURES_CL,
      JSON.stringify({ order: ["soporte", "academy"], hidden: ["caja"] }),
      SITE_CL,
    );
    assert.equal(cl.visible[0].id, "soporte");
    assert.equal(cl.visible[1].id, "academy");
    assert.equal(cl.visible.length, 6);
    assert.ok(ids(cl.hidden).includes("caja"));
    assert.ok(ids(cl.visible).includes("site"));
  });

  it("sanitize deja sólo ids del país y NULL si no hay cambios", () => {
    const defaults = resolve("PE", FEATURES_PE, null, SITE_PE).defaults;

    assert.equal(sanitizeHomeQuickAccess({ reset: true }, defaults), null);
    assert.equal(
      sanitizeHomeQuickAccess({ order: defaults, hidden: [] }, defaults),
      null,
    );

    assert.deepEqual(
      sanitizeHomeQuickAccess(
        { order: ["academy", "rex", "site"], hidden: ["galeria", "soporte"] },
        defaults,
      ),
      { order: ["academy", "site"], hidden: ["galeria"] },
    );
  });
});
