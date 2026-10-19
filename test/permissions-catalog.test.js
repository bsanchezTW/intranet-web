const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  MODULES,
  validateCatalog,
  getCatalog,
  getPermission,
  allKeys,
  isFieldKey,
} = require("../src/services/permissions/catalog");
const { DDL_STATEMENTS } = require("../src/services/permissions/permissionSchema");

describe("catálogo de permisos", () => {
  it("está bien formado", () => {
    assert.deepEqual(validateCatalog(), []);
  });

  it("detecta claves repetidas, ajenas al módulo y alcances inventados", () => {
    const errores = validateCatalog([
      {
        module: "demo",
        label: "Demo",
        permissions: [
          { key: "demo.acceso", label: "Entrar" },
          { key: "demo.cosa.ver", label: "Ver" },
          { key: "demo.cosa.ver", label: "Ver otra vez" },
          { key: "otro.cosa.ver", label: "Ajena" },
          { key: "demo.cosa.aprobar", label: "Aprobar", scopes: ["galaxia"] },
          { key: "demo.cosa.campo.rut", label: "RUT", scopes: ["todo"] },
        ],
      },
    ]);
    assert.ok(errores.some((e) => e.includes("Clave repetida: demo.cosa.ver")));
    assert.ok(errores.some((e) => e.includes("no pertenece al módulo demo")));
    assert.ok(errores.some((e) => e.includes('alcance desconocido "galaxia"')));
    assert.ok(errores.some((e) => e.includes("un campo sensible no lleva alcance")));
  });

  it("cada módulo tiene su permiso de acceso", () => {
    for (const mod of MODULES) {
      assert.ok(mod.permissions.some((p) => p.key === `${mod.module}.acceso`), mod.module);
    }
  });

  it("reconoce los campos sensibles", () => {
    assert.equal(isFieldKey("gastos.solicitud.campo.cuenta_bancaria"), true);
    assert.equal(isFieldKey("gastos.solicitud.ver"), false);
  });
});

describe("catálogo por país", () => {
  it("Chile tiene sus módulos y no los de Perú", () => {
    assert.ok(getPermission("gastos.solicitud.aprobar_finanzas", "CL"));
    assert.ok(getPermission("soporte.ticket.gestionar", "CL"));
    assert.ok(getPermission("inicio.indicador_uf.ver", "CL"));
    assert.equal(getPermission("vacaciones.solicitud.aprobar", "CL"), null);
    assert.equal(getPermission("letras.letra.crear", "CL"), null);
  });

  it("Perú tiene vacaciones y letras, y no lo de Chile", () => {
    assert.ok(getPermission("vacaciones.solicitud.aprobar", "PE"));
    assert.ok(getPermission("letras.letra.marcar_pagada", "PE"));
    assert.equal(getPermission("gastos.solicitud.ver", "PE"), null);
    assert.equal(getPermission("casino.menu.editar", "PE"), null);
    assert.equal(getPermission("inicio.indicador_uf.ver", "PE"), null);
  });

  it("los módulos comunes existen en los dos", () => {
    for (const key of ["noticias.noticia.crear", "procesos.procedimientos.ver", "organigrama.area.designar_jefe"]) {
      assert.ok(getPermission(key, "CL"), `CL ${key}`);
      assert.ok(getPermission(key, "PE"), `PE ${key}`);
    }
  });

  it("describe objeto, alcances y tipo de cada permiso", () => {
    const p = getPermission("vacaciones.solicitud.aprobar", "PE");
    assert.equal(p.module, "vacaciones");
    assert.equal(p.object, "solicitud");
    assert.deepEqual([...p.scopes], ["mi_area", "a_cargo", "areas", "todo"]);
    assert.equal(getPermission("vacaciones.acceso", "PE").isModuleAccess, true);
  });

  it("un módulo de un solo país no deja módulos vacíos en el otro", () => {
    for (const country of ["CL", "PE"]) {
      for (const mod of getCatalog(country).modules) {
        assert.ok(mod.permissions.length > 0, `${country} ${mod.module}`);
      }
    }
  });
});

describe("las claves usadas en el código existen en el catálogo", () => {
  const ROOT = path.join(__dirname, "..", "src");
  const USOS = [
    /require(?:Any)?Permission\(\s*((?:["'][^"']+["']\s*,?\s*)+)\)/g,
    /\bcan(?:\.field)?\(\s*["']([^"']+)["']/g,
    /perms\.(?:can|canOnRecord|canSeeField|coverage|sqlFilter)\(\s*["']([^"']+)["']/g,
  ];

  function archivos(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) return archivos(full);
      return /\.(js|ejs)$/.test(e.name) ? [full] : [];
    });
  }

  it("requirePermission, can() y req.perms sólo citan claves reales", () => {
    const conocidas = new Set(allKeys());
    const desconocidas = [];
    for (const file of archivos(ROOT)) {
      if (file.includes(`${path.sep}permissions${path.sep}`)) continue;
      const texto = fs.readFileSync(file, "utf8");
      for (const patron of USOS) {
        for (const m of texto.matchAll(patron)) {
          for (const key of m[1].match(/[a-z_]+(?:\.[a-z_]+)+/g) || []) {
            if (!conocidas.has(key)) desconocidas.push(`${path.relative(ROOT, file)}: ${key}`);
          }
        }
      }
    }
    assert.deepEqual(desconocidas, []);
  });
});

describe("schema de permisos", () => {
  const sql = DDL_STATEMENTS.join("\n");

  it("crea las tablas y la fila de versión", () => {
    for (const tabla of ["perm_sets", "perm_set_items", "perm_assignments", "perm_audit", "perm_meta"]) {
      assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${tabla}`));
    }
    assert.match(sql, /INSERT INTO perm_meta \(id\) VALUES \(1\) ON CONFLICT/);
    assert.match(sql, /ADD COLUMN IF NOT EXISTS is_superadmin/);
  });

  it("restringe destinatario, efecto y alcance", () => {
    assert.match(sql, /principal_type IN \('global', 'area', 'jefes', 'user'\)/);
    assert.match(sql, /effect IN \('concede', 'deniega'\)/);
    assert.match(sql, /\(set_id IS NULL\) <> \(permission_key IS NULL\)/);
    assert.match(sql, /'propio', 'mi_area', 'a_cargo', 'areas', 'todo'/);
  });

  it("los schema.sql de Chile y Perú traen las mismas tablas con RLS", () => {
    for (const pais of ["chile", "peru"]) {
      const archivo = fs.readFileSync(path.join(__dirname, "..", "supabase", pais, "schema.sql"), "utf8");
      for (const tabla of ["perm_sets", "perm_set_items", "perm_assignments", "perm_audit", "perm_meta"]) {
        assert.match(archivo, new RegExp(`CREATE TABLE IF NOT EXISTS ${pais}\\.${tabla}`), `${pais} ${tabla}`);
        assert.match(archivo, new RegExp(`ALTER TABLE ${pais}\\.${tabla} ENABLE ROW LEVEL SECURITY`), `${pais} ${tabla} RLS`);
      }
    }
  });
});
