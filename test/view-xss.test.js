const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ejs = require("ejs");

process.env.COUNTRY = process.env.COUNTRY || "CL";

/*
  XSS en vistas: datos de la URL o de la base que terminan dentro de un
  <script>. JSON.stringify no escapa "</script>", así que un nombre o un
  parámetro con esa secuencia cerraba el script y abría otro.
*/

const SRC = path.join(__dirname, "..", "src");
const VIEWS = path.join(SRC, "views");
const { getCountryConfig } = require(path.join(SRC, "config/country"));
const { phoneClientConfig } = require(path.join(SRC, "utils/phone"));
const { getMonogram } = require(path.join(SRC, "utils/monogram"));

const PAYLOAD = "</script><script>alert(document.domain)</script>";
const BASE = {
  countryConfig: getCountryConfig(),
  phoneClientConfig,
  getMonogram,
  can: { field: () => true },
};

function render(view, locals) {
  return ejs.renderFile(path.join(VIEWS, view), { ...BASE, ...locals });
}

function viewFiles(dir = VIEWS) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return viewFiles(full);
    return entry.name.endsWith(".ejs") ? [full] : [];
  });
}

describe("XSS · datos dentro de <script>", () => {
  it("perfil: password_error de la URL no cierra el script", async () => {
    const html = await render("perfil.ejs", {
      passwordError: PAYLOAD,
      openPasswordModal: true,
      documentoConfig: {},
      documentoBloqueado: false,
      usuario: { first_name: "Ana" },
    });
    assert.ok(!html.includes(PAYLOAD), "el payload sale literal en el HTML");
    // El mensaje sigue llegando intacto al modal.
    const literal = html.match(/initialError: (.*),\n/)[1];
    assert.equal(JSON.parse(literal), PAYLOAD);
  });

  it("KPI de cursos: un nombre de colaborador no cierra el script", async () => {
    const fila = { usuario_id: 7, nombre_usuario: PAYLOAD, email: null, puntaje_total: 90 };
    const html = await render("kpi-cursos.ejs", {
      todosLosRanking: [fila],
      top10Ranking: [fila],
      catalogoCursos: [{ id: 1, title: PAYLOAD, section: null, subsection: null }],
      kpiPorCurso: [{ course_id: 1, curso_titulo: PAYLOAD, top10: [{ nombre_usuario: PAYLOAD, score: 90 }] }],
      stats: {},
    });
    assert.ok(!html.includes(PAYLOAD), "el payload sale literal en el HTML");
    const literal = html.match(/const top10Data = (.*);\n/)[1];
    assert.equal(JSON.parse(literal)[0].nombre_usuario, PAYLOAD);
  });

  it("ninguna vista mete JSON.stringify en el HTML sin escapar '<'", () => {
    const sinEscapar = [];
    for (const file of viewFiles()) {
      const source = fs.readFileSync(file, "utf8");
      for (const match of source.matchAll(/<%-([\s\S]*?)%>/g)) {
        if (match[1].includes("JSON.stringify") && !match[1].includes("replace(/</g")) {
          const line = source.slice(0, match.index).split("\n").length;
          sinEscapar.push(`${path.relative(VIEWS, file)}:${line}`);
        }
      }
    }
    assert.deepEqual(sinEscapar, []);
  });
});

describe("XSS · innerHTML del KPI de cursos", () => {
  const source = fs.readFileSync(path.join(VIEWS, "kpi-cursos.ejs"), "utf8");

  it("escapa el nombre, el correo y el título antes de usar innerHTML", () => {
    for (const campo of [
      "u.nombre_usuario",
      "u.email",
      "user.name",
      "user.email",
      "user.id",
      "course.title",
      "course.status_label",
    ]) {
      const crudo = new RegExp(`\\$\\{\\s*${campo.replace(".", "\\.")}\\b`);
      assert.doesNotMatch(source, crudo, `${campo} entra sin escapeHtml`);
    }
  });

  it("escapeHtml neutraliza las etiquetas y las comillas", () => {
    const definicion = source.match(/function escapeHtml\(value\) \{[\s\S]*?\n {2}\}/)[0];
    // eslint-disable-next-line no-new-func
    const escapeHtml = new Function(`${definicion}; return escapeHtml;`)();
    assert.equal(
      escapeHtml(`<img src=x onerror="a('b')">&`),
      "&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt;&amp;",
    );
    assert.equal(escapeHtml(null), "");
    assert.equal(escapeHtml(0), "0");
  });
});
