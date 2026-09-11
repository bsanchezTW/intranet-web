const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  DEFAULT_COLOR,
  WORK_AREA_ID_MIN,
  WORK_AREA_ID_MAX,
  isWorkAreaPublicId,
  WORK_AREA_COLORS,
  COLOR_PALETTE,
  hslToHex,
  hexToHsl,
  normalizeHex,
  resolveAreaColor,
  getWorkAreaPill,
  getWorkAreaPillClass,
  enrichAreaWithPill,
} = require("../src/constants/workAreas");

describe("workAreas — id de 4 dígitos", () => {
  it("acepta solo enteros entre 1111 y 9999", () => {
    assert.equal(WORK_AREA_ID_MIN, 1111);
    assert.equal(WORK_AREA_ID_MAX, 9999);
    assert.equal(isWorkAreaPublicId(1111), true);
    assert.equal(isWorkAreaPublicId(9999), true);
    assert.equal(isWorkAreaPublicId(4721), true);
    assert.equal(isWorkAreaPublicId(1), false);
    assert.equal(isWorkAreaPublicId(3), false);
    assert.equal(isWorkAreaPublicId(1110), false);
    assert.equal(isWorkAreaPublicId(10000), false);
    assert.equal(isWorkAreaPublicId("4820"), true);
  });
});

describe("workAreas — color persistido", () => {
  it("normaliza hex de 6 dígitos con o sin numeral", () => {
    assert.equal(normalizeHex("#AABBCC"), "#aabbcc");
    assert.equal(normalizeHex("aAbBcC"), "#aabbcc");
    assert.equal(normalizeHex("  #3cb371  "), "#3cb371");
    assert.equal(normalizeHex("#fff"), null);
    assert.equal(normalizeHex("not-a-color"), null);
    assert.equal(normalizeHex(""), null);
  });

  it("hslToHex / hexToHsl conservan el matiz de Informática", () => {
    const hex = hslToHex(142, 55);
    const { h, s } = hexToHsl(hex);
    assert.match(hex, /^#[0-9a-f]{6}$/);
    assert.ok(Math.abs(h - 142) <= 2, `h=${h}`);
    assert.ok(Math.abs(s - 55) <= 3, `s=${s}`);
  });

  it("usa el color guardado si no es el default", () => {
    assert.equal(resolveAreaColor("#c2410c", "Informática"), "#c2410c");
  });

  it("cae al color histórico por nombre si falta o es el default", () => {
    assert.equal(
      resolveAreaColor(DEFAULT_COLOR, "Informática"),
      WORK_AREA_COLORS.Informática,
    );
    assert.equal(resolveAreaColor(null, "Logística"), WORK_AREA_COLORS.Logística);
    assert.equal(resolveAreaColor(null, "ti"), WORK_AREA_COLORS.Informática);
    assert.equal(resolveAreaColor(null, "Área nueva"), DEFAULT_COLOR);
  });

  it("arma chip con clase genérica y variables CSS", () => {
    const pill = getWorkAreaPill("Marketing", "#0e7490");
    assert.equal(pill.pillClass, "pill pill-area");
    assert.match(pill.pillStyle, /--pill-h:\s*\d+/);
    assert.match(pill.pillStyle, /--pill-s:\s*\d+%/);
    assert.equal(pill.color, "#0e7490");
    assert.equal(getWorkAreaPillClass("Marketing", "#0e7490"), "pill pill-area");
  });

  it("sin nombre usa el chip por defecto", () => {
    const pill = getWorkAreaPill("-");
    assert.match(pill.pillClass, /pill-area-default/);
    assert.equal(pill.color, DEFAULT_COLOR);
  });

  it("enrichAreaWithPill rellena color, clase y estilo", () => {
    const area = enrichAreaWithPill({
      id: 1,
      area_name: "Gerencia",
      color: DEFAULT_COLOR,
    });
    assert.equal(area.color, WORK_AREA_COLORS.Gerencia);
    assert.equal(area.pillClass, "pill pill-area");
    assert.match(area.pillStyle, /--pill-h:/);
  });

  it("ofrece una paleta amplia, única y con los colores históricos", () => {
    const hexes = COLOR_PALETTE.map((c) => c.hex);
    assert.ok(COLOR_PALETTE.length >= 36, `size=${COLOR_PALETTE.length}`);
    assert.equal(new Set(hexes).size, hexes.length);
    assert.ok(hexes.every((hex) => /^#[0-9a-f]{6}$/.test(hex)));
    assert.ok(hexes.includes(DEFAULT_COLOR));
    Object.values(WORK_AREA_COLORS).forEach((hex) => {
      assert.ok(hexes.includes(hex), `falta ${hex}`);
    });
  });
});
