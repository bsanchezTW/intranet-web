const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { isRrhhAreaName } = require("../src/constants/rrhhArea");
const { accessProfile, canManageRrhh, isInformaticaAdmin } = require("../src/services/access/staffAccess");

describe("área de RRHH", () => {
  it("reconoce RRHH y Recursos Humanos escritos de distintas formas", () => {
    for (const name of ["RRHH", "rrhh", " Recursos Humanos ", "RECURSOS HUMANOS"]) {
      assert.equal(isRrhhAreaName(name), true, name);
    }
  });

  it("deja fuera al resto de las áreas y a los vacíos", () => {
    for (const name of ["Informática", "Finanzas", "", null, undefined]) {
      assert.equal(isRrhhAreaName(name), false, String(name));
    }
  });
});

describe("staffAccess — permisos por área y rol", () => {
  it("un administrador de Informática tiene acceso total", () => {
    const profile = accessProfile({ role: "Administrador", area_name: "Informática" });
    assert.equal(profile.informaticaAdmin, true);
    assert.equal(profile.canManageRrhh, true);
  });

  it("un administrador de RRHH gestiona RRHH, pero no es de Informática", () => {
    const profile = accessProfile({ role: "admin", area_name: "Recursos Humanos" });
    assert.equal(profile.rrhhAdmin, true);
    assert.equal(profile.informaticaAdmin, false);
    assert.equal(profile.canManageRrhh, true);
  });

  it("el área sola no basta: un Usuario de Informática o RRHH no gestiona", () => {
    assert.equal(accessProfile({ role: "Usuario", area_name: "TI" }).canManageRrhh, false);
    assert.equal(accessProfile({ role: "Usuario", area_name: "RRHH" }).canManageRrhh, false);
  });

  it("el rol solo tampoco: un administrador de otra área no gestiona RRHH", () => {
    const profile = accessProfile({ role: "Administrador", area_name: "Marketing" });
    assert.deepEqual(profile, { informaticaAdmin: false, rrhhAdmin: false, canManageRrhh: false });
  });

  it("el login de emergencia (id 0) conserva acceso total sin consultar la base", async () => {
    const master = { id: 0, role: "Administrador" };
    assert.equal(await canManageRrhh(master), true);
    assert.equal(await isInformaticaAdmin(master), true);
    assert.equal(await canManageRrhh(null), false);
  });
});
