const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

process.env.COUNTRY = process.env.COUNTRY || "CL";

const { getCatalog, allKeys } = require("../src/services/permissions/catalog");
const { computePermissions } = require("../src/services/permissions/resolver");
const { decide, scopeFilter, recentMismatches, resetMismatches } = require("../src/services/permissions/decide");
const { LEGACY_RULES, legacyContext, hasLegacyRule } = require("../src/services/permissions/legacyRules");

const CL = getCatalog("CL");

function perms({ userId = 8, grants = [], mode = "sombra", bootstrapped = true } = {}) {
  const snapshot = {
    users: new Map([[userId, { id: userId, role: "Usuario", work_area_id: 1 }]]),
    areas: [{ id: 1, parent_area_id: null, manager_user_id: null }],
    sets: new Map(),
    assignments: grants.map((key, i) => ({
      id: i + 1,
      principal_type: "user",
      user_id: userId,
      permission_key: key,
      scope: null,
      scope_area_ids: [],
      effect: "concede",
    })),
  };
  const p = computePermissions(snapshot, { id: userId }, { catalog: CL });
  p.mode = mode;
  p.bootstrapped = bootstrapped;
  return p;
}

const ADMIN = legacyContext({ id: 8, role: "Administrador" });
const USUARIO = legacyContext({ id: 8, role: "Usuario" });

describe("decide: sombra y aplicar", () => {
  beforeEach(() => resetMismatches());

  it("en sombra manda la regla antigua y se anota la diferencia una sola vez", () => {
    const p = perms({ grants: [] });
    assert.equal(decide(p, "noticias.noticia.crear", ADMIN, { path: "/noticias" }), true);
    assert.equal(decide(p, "noticias.noticia.crear", ADMIN, { path: "/noticias" }), true);
    const anotadas = recentMismatches();
    assert.equal(anotadas.length, 1);
    assert.deepEqual(
      { key: anotadas[0].key, legacy: anotadas[0].legacy, next: anotadas[0].next },
      { key: "noticias.noticia.crear", legacy: true, next: false },
    );
  });

  it("si coinciden no se anota nada", () => {
    const p = perms({ grants: ["noticias.noticia.crear"] });
    assert.equal(decide(p, "noticias.noticia.crear", ADMIN), true);
    assert.equal(decide(perms(), "noticias.noticia.crear", USUARIO), false);
    assert.equal(recentMismatches().length, 0);
  });

  it("antes del arranque no se anotan diferencias", () => {
    decide(perms({ bootstrapped: false }), "noticias.noticia.crear", ADMIN);
    assert.equal(recentMismatches().length, 0);
  });

  it("al aplicar manda Gestión de Permisos", () => {
    assert.equal(decide(perms({ mode: "aplicar" }), "noticias.noticia.crear", ADMIN), false);
    assert.equal(decide(perms({ mode: "aplicar", grants: ["noticias.noticia.crear"] }), "noticias.noticia.crear", USUARIO), true);
  });

  it("un permiso sin regla antigua decide con la nueva también en sombra", () => {
    assert.equal(hasLegacyRule("gastos.solicitud.aprobar_finanzas"), false);
    assert.equal(decide(perms({ grants: ["gastos.solicitud.aprobar_finanzas"] }), "gastos.solicitud.aprobar_finanzas", USUARIO), false, "sin alcance no vale");
  });

  it("el filtro de listados no cambia nada en sombra", () => {
    assert.deepEqual(scopeFilter(perms(), "cursos.avance.ver", { ownerColumn: "u.id", areaColumn: "u.work_area_id" }), {
      clause: "TRUE",
      params: [],
    });
    assert.equal(
      scopeFilter(perms({ mode: "aplicar" }), "cursos.avance.ver", { ownerColumn: "u.id", areaColumn: "u.work_area_id" }).clause,
      "FALSE",
    );
  });
});

describe("contexto antiguo", () => {
  it("rol activo y administrador", () => {
    assert.deepEqual(legacyContext({ role: "Administrador" }), { active: true, admin: true });
    assert.deepEqual(legacyContext({ role: "Usuario" }), { active: true, admin: false });
    assert.deepEqual(legacyContext({ role: "Deshabilitado" }), { active: false, admin: false });
    assert.deepEqual(legacyContext(null), { active: false, admin: false });
  });
});

describe("cobertura del modo sombra", () => {
  it("las reglas antiguas citan permisos que existen", () => {
    const conocidas = new Set(allKeys());
    for (const key of Object.keys(LEGACY_RULES)) assert.ok(conocidas.has(key), key);
  });

  /*
   * Mientras el modo sea 'sombra', un permiso usado en una ruta o una vista sin
   * regla antigua decidiría con la configuración nueva y le cambiaría algo a
   * alguien. Cada módulo que se migra suma sus reglas a legacyRules.js.
   */
  it("todo permiso usado en rutas y vistas tiene regla antigua", () => {
    const ROOT = path.join(__dirname, "..", "src");
    const USOS = [
      /require(?:Any)?Permission\(\s*((?:["'][^"']+["']\s*,?\s*)+)\)/g,
      /\bcan(?:\.field)?\(\s*["']([^"']+)["']/g,
      /\bdecide\([^,]+,\s*["']([^"']+)["']/g,
      /scopeFilter\([^,]+,\s*["']([^"']+)["']/g,
    ];
    const archivos = (dir) =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) return archivos(full);
        return /\.(js|ejs)$/.test(e.name) ? [full] : [];
      });
    const sinRegla = [];
    for (const file of archivos(ROOT)) {
      // El propio módulo y el middleware (sus comentarios traen ejemplos).
      if (file.includes(`${path.sep}permissions${path.sep}`) || file.endsWith("requirePermission.js")) continue;
      const texto = fs.readFileSync(file, "utf8");
      for (const patron of USOS) {
        for (const m of texto.matchAll(patron)) {
          for (const key of m[1].match(/[a-z_]+(?:\.[a-z_]+)+/g) || []) {
            if (!hasLegacyRule(key)) sinRegla.push(`${path.relative(ROOT, file)}: ${key}`);
          }
        }
      }
    }
    assert.deepEqual([...new Set(sinRegla)], []);
  });
});
