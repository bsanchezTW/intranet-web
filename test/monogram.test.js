const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  monogramInitials,
  getMonogram,
  applyIdentityToSession,
} = require("../src/utils/monogram");
const {
  DEFAULT_COLOR,
  WORK_AREA_COLORS,
  hexToHsl,
} = require("../src/constants/workAreas");

describe("monogramInitials", () => {
  it("usa la primera letra del nombre y del apellido", () => {
    assert.equal(
      monogramInitials({ first_name: "Babar", last_name: "Sanchez" }),
      "BS",
    );
  });

  it("toma la primera palabra de cada campo", () => {
    assert.equal(
      monogramInitials({
        first_name: "Juan Carlos",
        last_name: "Pérez Soto",
      }),
      "JP",
    );
  });

  it("con un solo nombre usa esa letra", () => {
    assert.equal(monogramInitials({ first_name: "Ana" }), "A");
    assert.equal(monogramInitials({ last_name: "Silva" }), "S");
  });

  it("si sólo hay un string, usa primera y última palabra", () => {
    assert.equal(monogramInitials({ nombre: "Babar Sanchez" }), "BS");
    assert.equal(monogramInitials({ name: "María José Soto" }), "MS");
  });

  it("cae al usuario o al correo", () => {
    assert.equal(monogramInitials({ username: "bsanchez" }), "B");
    assert.equal(monogramInitials({ email: "ana@transworld.cl" }), "A");
  });

  it("sin datos devuelve ?", () => {
    assert.equal(monogramInitials({}), "?");
    assert.equal(monogramInitials(), "?");
  });
});

describe("getMonogram", () => {
  it("colorea con el hex del área y expone variables CSS", () => {
    const m = getMonogram({
      first_name: "Babar",
      last_name: "Sanchez",
      area: "Marketing",
      area_color: "#0e7490",
    });
    assert.equal(m.initials, "BS");
    assert.equal(m.color, "#0e7490");
    const { h, s } = hexToHsl("#0e7490");
    assert.equal(m.style, `--mono-h: ${h}; --mono-s: ${s}%;`);
  });

  it("sin área usa el gris por defecto", () => {
    const m = getMonogram({ first_name: "Ana", last_name: "Silva" });
    assert.equal(m.initials, "AS");
    assert.equal(m.color, DEFAULT_COLOR);
  });

  it("si el color guardado es el default, cae al histórico por nombre", () => {
    const m = getMonogram({
      first_name: "Luis",
      last_name: "Rojas",
      area: "Gerencia",
      area_color: DEFAULT_COLOR,
    });
    assert.equal(m.color, WORK_AREA_COLORS.Gerencia);
  });
});

describe("applyIdentityToSession", () => {
  it("rellena nombre, foto y área, incluyendo color null", () => {
    const session = { id: 1 };
    applyIdentityToSession(session, {
      first_name: "Babar",
      last_name: "Sanchez",
      photo: "/p.jpg",
      work_area_id: 2001,
      area_name: "Informática",
      area_color: null,
    });
    assert.equal(session.nombre, "Babar Sanchez");
    assert.equal(session.photo, "/p.jpg");
    assert.equal(session.foto, "/p.jpg");
    assert.equal(session.work_area_id, 2001);
    assert.equal(session.area, "Informática");
    assert.equal(session.area_color, null);
  });
});
