const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

process.env.COUNTRY = process.env.COUNTRY || "PE";

const {
  buildWorkbook,
  readSheetRows,
  normalizeHeader,
} = require("../src/services/exports/excelWorkbook");
const importService = require("../src/services/vacations/vacationHistoryImportService");
const {
  normalizeHistoryInput,
  duplicateKey,
} = require("../src/services/vacations/vacationHistoryService");
const { parseMonth } = require("../src/constants/vacationHistory");

/** Construye un .xlsx en memoria con las columnas de la plantilla. */
async function excelDe(rows, columns = null) {
  const cols = columns || [
    { header: "documento", key: "documento" },
    { header: "nombre", key: "nombre" },
    { header: "anio", key: "anio" },
    { header: "mes", key: "mes" },
    { header: "dias", key: "dias" },
    { header: "observacion", key: "observacion" },
  ];
  return buildWorkbook([{ name: "Historial", columns: cols, rows }]);
}

describe("Excel — plantilla y lectura", () => {
  it("XLS-01: la plantilla se genera y trae las dos hojas", async () => {
    const buffer = await importService.buildTemplate();
    assert.ok(Buffer.isBuffer(buffer));
    assert.ok(buffer.length > 0);
    const leido = await readSheetRows(buffer);
    assert.equal(leido.ok, true);
    // Primera hoja: las dos filas de ejemplo.
    assert.equal(leido.rows.length, 2);
    assert.ok(leido.headers.includes("documento"));
    assert.ok(leido.headers.includes("dias"));
  });

  it("XLS-02: lo que se escribe es lo que se lee", async () => {
    const buffer = await excelDe([
      { documento: "00000001", nombre: "Ana Pérez", anio: 2019, mes: "Marzo", dias: 15, observacion: "Vacaciones" },
    ]);
    const leido = await readSheetRows(buffer);
    assert.equal(leido.ok, true);
    assert.equal(leido.rows.length, 1);
    const fila = leido.rows[0];
    assert.equal(fila.rowNumber, 2); // la 1 es la cabecera
    assert.equal(fila.data.documento, "00000001");
    assert.equal(fila.data.anio, 2019);
    assert.equal(fila.data.mes, "Marzo");
    assert.equal(fila.data.dias, 15);
  });

  it("XLS-03: las cabeceras se normalizan (tildes, mayúsculas, espacios)", () => {
    assert.equal(normalizeHeader("Días usados"), "dias_usados");
    assert.equal(normalizeHeader("  AÑO  "), "ano");
    assert.equal(normalizeHeader("Observación"), "observacion");
  });

  it("XLS-04: un archivo que no es Excel se rechaza sin romper", async () => {
    const leido = await readSheetRows(Buffer.from("esto no es un xlsx"));
    assert.equal(leido.ok, false);
    assert.equal(leido.error, "unreadable");
  });

  it("XLS-05: las filas totalmente vacías se descartan", async () => {
    const buffer = await excelDe([
      { documento: "00000001", anio: 2019, mes: "Marzo", dias: 15 },
      {},
      { documento: "00000001", anio: 2020, mes: "Abril", dias: 10 },
    ]);
    const leido = await readSheetRows(buffer);
    assert.equal(leido.rows.length, 2);
  });
});

describe("Documento del trabajador", () => {
  it("DOC-01: Excel se come los ceros a la izquierda y se reponen", () => {
    assert.equal(importService.normalizeDocument(1234567), "01234567");
    assert.equal(importService.normalizeDocument("1234567"), "01234567");
    assert.equal(importService.normalizeDocument("01234567"), "01234567");
  });

  it("DOC-02: puntos, guiones y espacios no cambian el documento", () => {
    assert.equal(importService.normalizeDocument(" 0123-4567 "), "01234567");
  });

  it("DOC-03: vacío → null, para poder marcar la fila", () => {
    assert.equal(importService.normalizeDocument(""), null);
    assert.equal(importService.normalizeDocument(null), null);
    assert.equal(importService.normalizeDocument("   "), null);
  });
});

describe("Fechas de una celda", () => {
  it("FEC-01: Date, ISO y dd/mm/aaaa", () => {
    assert.equal(importService.cellDate(new Date(Date.UTC(2019, 3, 5, 12))), "2019-04-05");
    assert.equal(importService.cellDate("2019-04-05"), "2019-04-05");
    assert.equal(importService.cellDate("5/4/2019"), "2019-04-05");
    assert.equal(importService.cellDate("05-04-2019"), "2019-04-05");
  });

  it("FEC-02: celda vacía o ilegible → null, no una fecha inventada", () => {
    assert.equal(importService.cellDate(""), null);
    assert.equal(importService.cellDate(null), null);
    assert.equal(importService.cellDate("marzo"), null);
  });
});

/**
 * Caso obligatorio del requerimiento: 100 filas, 94 válidas y 6 con error.
 *
 * Se ejercita el validador fila a fila —que es donde vive la decisión— con un
 * archivo real leído desde disco en memoria, sin tocar la base: la resolución
 * del trabajador por documento se simula con un mapa.
 */
describe("Importación de 100 filas", () => {
  const INGRESO = "2018-03-01";
  const TRABAJADORES = new Map([["00000001", { id: 100001, hire_date: INGRESO }]]);

  function construirFilas() {
    const filas = [];
    // 94 filas correctas: años 2019–2025, un mes distinto cada vez.
    for (let i = 0; i < 94; i += 1) {
      filas.push({
        documento: "00000001",
        nombre: "Ana Pérez",
        anio: 2019 + (i % 7),
        mes: (i % 12) + 1,
        // Días distintos para que no se marquen como duplicados entre sí.
        dias: (i % 20) + 1,
        observacion: "Vacaciones",
      });
    }
    // 6 filas con problemas, una por cada error que el requerimiento exige.
    filas.push({ documento: "", nombre: "Sin documento", anio: 2020, mes: 3, dias: 10 });
    filas.push({ documento: "00000999", nombre: "No existe", anio: 2020, mes: 3, dias: 10 });
    filas.push({ documento: "00000001", nombre: "Año inválido", anio: 1899, mes: 3, dias: 10 });
    filas.push({ documento: "00000001", nombre: "Mes inválido", anio: 2020, mes: "Marzoo", dias: 10 });
    filas.push({ documento: "00000001", nombre: "Días cero", anio: 2020, mes: 3, dias: 0 });
    filas.push({ documento: "00000001", nombre: "Días negativos", anio: 2020, mes: 3, dias: -5 });
    return filas;
  }

  /** Mismo recorrido que validateFile, con el lookup simulado. */
  function validar(filasLeidas) {
    const validas = [];
    const errores = [];
    const avisos = [];
    const vistas = new Set();

    for (const { rowNumber, data } of filasLeidas) {
      const documento = importService.normalizeDocument(data.documento);
      if (!documento) {
        errores.push({ row: rowNumber, error: "Falta el documento del trabajador" });
        continue;
      }
      const trabajador = TRABAJADORES.get(documento);
      if (!trabajador) {
        errores.push({ row: rowNumber, error: "Trabajador no encontrado" });
        continue;
      }
      const normalizado = normalizeHistoryInput(
        {
          periodYear: data.anio,
          periodMonth: data.mes,
          daysUsed: data.dias,
          observation: data.observacion,
        },
        { hireDate: trabajador.hire_date, referenceYear: 2026 },
      );
      if (!normalizado.valid) {
        errores.push({ row: rowNumber, error: normalizado.errors.join(" ") });
        continue;
      }
      const clave = duplicateKey({ userId: trabajador.id, ...normalizado.value });
      if (vistas.has(clave)) {
        avisos.push({ row: rowNumber, warning: "Fila duplicada dentro del archivo" });
      }
      vistas.add(clave);
      validas.push({ row: rowNumber, value: normalizado.value });
    }
    return { validas, errores, avisos };
  }

  it("IMP-01: 100 filas → 94 válidas y 6 con error", async () => {
    const buffer = await excelDe(construirFilas());
    const leido = await readSheetRows(buffer);
    assert.equal(leido.rows.length, 100);

    const { validas, errores } = validar(leido.rows);
    assert.equal(validas.length, 94);
    assert.equal(errores.length, 6);
  });

  it("IMP-02: cada fila con error dice cuál es y en qué línea", async () => {
    const buffer = await excelDe(construirFilas());
    const leido = await readSheetRows(buffer);
    const { errores } = validar(leido.rows);

    for (const e of errores) {
      assert.ok(Number.isInteger(e.row) && e.row > 1, "la fila tiene que estar identificada");
      assert.ok(e.error && e.error.length > 0, "el error tiene que explicarse");
    }
    assert.match(errores[0].error, /documento/i);
    assert.match(errores[1].error, /no encontrado/i);
  });

  it("IMP-03: filas idénticas se marcan como duplicadas, no se descartan solas", async () => {
    const repetida = {
      documento: "00000001",
      nombre: "Ana Pérez",
      anio: 2019,
      mes: "Marzo",
      dias: 15,
    };
    const buffer = await excelDe([repetida, { ...repetida }, { ...repetida, dias: 10 }]);
    const leido = await readSheetRows(buffer);
    const { validas, avisos } = validar(leido.rows);

    // Las tres siguen siendo válidas: se avisa, no se borra información.
    assert.equal(validas.length, 3);
    assert.equal(avisos.length, 1);
    assert.match(avisos[0].warning, /duplicada/i);
  });

  it("IMP-04: los meses escritos en palabras se entienden", async () => {
    const buffer = await excelDe([
      { documento: "00000001", anio: 2019, mes: "Marzo", dias: 15 },
      { documento: "00000001", anio: 2019, mes: "setiembre", dias: 10 },
      { documento: "00000001", anio: 2019, mes: "OCT", dias: 5 },
    ]);
    const leido = await readSheetRows(buffer);
    const { validas, errores } = validar(leido.rows);
    assert.equal(errores.length, 0);
    assert.deepEqual(
      validas.map((v) => v.value.periodMonth),
      [3, 9, 10],
    );
  });

  it("IMP-05: un archivo sin ninguna fila válida no deja nada que confirmar", async () => {
    const buffer = await excelDe([
      { documento: "00000999", anio: 2020, mes: 3, dias: 10 },
      { documento: "", anio: 2020, mes: 3, dias: 10 },
    ]);
    const leido = await readSheetRows(buffer);
    const { validas, errores } = validar(leido.rows);
    assert.equal(validas.length, 0);
    assert.equal(errores.length, 2);
  });
});

describe("Sinónimos de columnas del Excel de RR.HH.", () => {
  it("COL-01: la plantilla del requerimiento también se entiende", async () => {
    // employee_identifier / year / month / days_used, como en la spec.
    const buffer = await buildWorkbook([
      {
        name: "Historial",
        columns: [
          { header: "employee_identifier", key: "employee_identifier" },
          { header: "employee_name", key: "employee_name" },
          { header: "year", key: "year" },
          { header: "month", key: "month" },
          { header: "days_used", key: "days_used" },
        ],
        rows: [
          {
            employee_identifier: "00000001",
            employee_name: "Ana Pérez",
            year: 2018,
            month: "Marzo",
            days_used: 15,
          },
        ],
      },
    ]);
    const leido = await readSheetRows(buffer);
    const data = leido.rows[0].data;
    assert.equal(data.employee_identifier, "00000001");
    assert.equal(parseMonth(data.month), 3);
    assert.equal(data.days_used, 15);
  });
});
