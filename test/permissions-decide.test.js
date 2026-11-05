const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

process.env.COUNTRY = process.env.COUNTRY || "CL";

const { getCatalog, allKeys } = require("../src/services/permissions/catalog");
const { computePermissions } = require("../src/services/permissions/resolver");
const { decide, scopeFilter } = require("../src/services/permissions/decide");

/*
  Sin modo sombra: decide Gestión de Permisos, siempre.
*/

const CL = getCatalog("CL");

function perms({ userId = 8, grants = [] } = {}) {
  const snapshot = {
    users: new Map([[userId, { id: userId, role: "Administrador", work_area_id: 1 }]]),
    areas: [{ id: 1, parent_area_id: null, manager_user_id: null }],
    sets: new Map(),
    assignments: grants.map((g, i) => ({
      id: i + 1,
      principal_type: "user",
      user_id: userId,
      permission_key: typeof g === "string" ? g : g.key,
      scope: typeof g === "string" ? null : g.scope,
      scope_area_ids: [],
      effect: "concede",
    })),
  };
  return computePermissions(snapshot, { id: userId }, { catalog: CL });
}

describe("decide", () => {
  it("manda la configuración, aunque el rol antiguo fuera Administrador", () => {
    assert.equal(decide(perms(), "noticias.noticia.crear"), false);
    assert.equal(decide(perms({ grants: ["noticias.noticia.crear"] }), "noticias.noticia.crear"), true);
  });

  it("sobre un registro respeta el alcance", () => {
    const p = perms({ grants: [{ key: "cursos.avance.ver", scope: "mi_area" }] });
    assert.equal(decide(p, "cursos.avance.ver", { record: { areaId: 1 } }), true);
    assert.equal(decide(p, "cursos.avance.ver", { record: { areaId: 2 } }), false);
  });

  it("sin permisos resueltos, no", () => {
    assert.equal(decide(null, "noticias.noticia.crear"), false);
  });

  it("el filtro de listados aplica el alcance", () => {
    const cols = { ownerColumn: "u.id", areaColumn: "u.work_area_id" };
    assert.equal(scopeFilter(perms(), "cursos.avance.ver", cols).clause, "FALSE");
    assert.deepEqual(scopeFilter(perms({ grants: [{ key: "cursos.avance.ver", scope: "mi_area" }] }), "cursos.avance.ver", cols), {
      clause: "(u.work_area_id = ANY($1::int[]))",
      params: [[1]],
    });
  });

  it("guarda el área propia de la persona (para Procesos)", () => {
    assert.equal(perms().ownAreaId, 1);
  });
});

describe("claves usadas en rutas y vistas", () => {
  it("existen todas en el catálogo de algún país", () => {
    const conocidas = new Set([...allKeys("CL"), ...allKeys("PE")]);
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
    const desconocidas = [];
    for (const file of archivos(ROOT)) {
      if (file.includes(`${path.sep}permissions${path.sep}`) || file.endsWith("requirePermission.js")) continue;
      const texto = fs.readFileSync(file, "utf8");
      for (const patron of USOS) {
        for (const m of texto.matchAll(patron)) {
          for (const key of m[1].match(/[a-z_]+(?:\.[a-z_]+)+/g) || []) {
            if (!conocidas.has(key)) desconocidas.push(`${path.relative(ROOT, file)}: ${key}`);
          }
        }
      }
    }
    assert.deepEqual([...new Set(desconocidas)], []);
  });
});
