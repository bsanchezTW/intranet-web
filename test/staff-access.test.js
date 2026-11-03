const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { isRrhhAreaName } = require("../src/constants/rrhhArea");
const { accessProfile, canManageRrhh, isInformaticaAdmin } = require("../src/services/access/staffAccess");

describe("área de RRHH", () => {
  it("reconoce RRHH y Recursos Humanos escritos de distintas formas", () => {
    for (const country of ["CL", "PE"]) {
      for (const name of ["RRHH", "rrhh", " Recursos Humanos ", "RECURSOS HUMANOS"]) {
        assert.equal(isRrhhAreaName(name, country), true, `${country} ${name}`);
      }
    }
  });

  it("deja fuera al resto de las áreas y a los vacíos", () => {
    for (const name of ["Informática", "Finanzas", "", null, undefined]) {
      assert.equal(isRrhhAreaName(name, "CL"), false, String(name));
    }
  });

  it("en Perú el área de la Administradora también es RRHH; en Chile no", () => {
    for (const name of ["Administradora", "Administración", "administracion"]) {
      assert.equal(isRrhhAreaName(name, "PE"), true, name);
      assert.equal(isRrhhAreaName(name, "CL"), false, name);
    }
  });
});

describe("staffAccess — permisos por área y rol", () => {
  it("un administrador de Informática tiene acceso total", () => {
    const profile = accessProfile({ role: "Administrador", area_name: "Informática" }, "CL");
    assert.equal(profile.informaticaAdmin, true);
    assert.equal(profile.canManageRrhh, true);
  });

  it("un administrador de RRHH gestiona RRHH, pero no es de Informática", () => {
    const profile = accessProfile({ role: "admin", area_name: "Recursos Humanos" }, "CL");
    assert.equal(profile.rrhhAdmin, true);
    assert.equal(profile.informaticaAdmin, false);
    assert.equal(profile.canManageRrhh, true);
  });

  it("el área sola no basta: un Usuario de Informática o RRHH no gestiona", () => {
    assert.equal(accessProfile({ role: "Usuario", area_name: "TI" }, "CL").canManageRrhh, false);
    assert.equal(accessProfile({ role: "Usuario", area_name: "RRHH" }, "CL").canManageRrhh, false);
  });

  it("el rol solo tampoco: un administrador de otra área no gestiona RRHH", () => {
    const profile = accessProfile({ role: "Administrador", area_name: "Marketing" }, "CL");
    assert.deepEqual(profile, { informaticaAdmin: false, rrhhAdmin: false, canManageRrhh: false });
  });

  it("quien dirige el área de RRHH la gestiona aunque trabaje en otra área", () => {
    const jefa = { role: "Administrador", area_name: "Country Manager Perú", managed_area_names: ["Administradora"] };
    assert.equal(accessProfile(jefa, "PE").canManageRrhh, true);
    assert.equal(accessProfile(jefa, "PE").informaticaAdmin, false);
    // Dirigir el área no reemplaza al rol.
    assert.equal(accessProfile({ ...jefa, role: "Usuario" }, "PE").canManageRrhh, false);
    // Dirigir otra área no da nada.
    assert.equal(
      accessProfile({ role: "Administrador", area_name: "Ventas", managed_area_names: ["Sales Leader"] }, "PE").canManageRrhh,
      false,
    );
  });

  it("id 0 con rol Administrador (el login de emergencia que ya no existe) no tiene acceso", async () => {
    // staffAccess con una base que no tiene a nadie con id 0.
    const dbId = require.resolve("../src/db");
    const staffId = require.resolve("../src/services/access/staffAccess");
    const prevDb = require.cache[dbId];
    const prevStaff = require.cache[staffId];
    require.cache[dbId] = {
      id: dbId,
      filename: dbId,
      loaded: true,
      exports: { query: async () => ({ rows: [{ id: 5, role: "Administrador", area_name: "Informática", managed_area_names: [] }] }) },
    };
    delete require.cache[staffId];
    try {
      const fresh = require("../src/services/access/staffAccess");
      const master = { id: 0, role: "Administrador" };
      assert.equal(await fresh.canManageRrhh(master), false);
      assert.equal(await fresh.isInformaticaAdmin(master), false);
      assert.equal(await fresh.canManageRrhh({ id: 5, role: "Administrador" }), true);
      assert.equal(await fresh.canManageRrhh(null), false);
    } finally {
      if (prevDb) require.cache[dbId] = prevDb;
      else delete require.cache[dbId];
      require.cache[staffId] = prevStaff;
    }
  });
});
