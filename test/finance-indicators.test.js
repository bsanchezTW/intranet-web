const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const logger = require("../src/utils/logger");
const {
  fetchIndicadores,
  parseBcrp,
  parseOpenEr,
  bcrpUrl,
} = require("../src/services/usdService");

const NOW = Date.parse("2026-10-22T15:00:00Z");

function bcrpBody(values) {
  return { periods: values.map((v, i) => ({ name: `${i}.Oct.26`, values: [v] })) };
}

function mindicadorBody(hoy, ayer) {
  return { serie: [{ valor: hoy }, { valor: ayer }] };
}

const OPEN_ER = {
  result: "success",
  rates: { USD: 1, CLP: 975, EUR: 0.89, CLF: 0.0246 },
};

/** fetchJson falso: responde por URL y anota lo que se pidió. */
function fakeFetch(routes) {
  const calls = [];
  const fetchJson = async (url) => {
    calls.push(url);
    const match = Object.keys(routes).find((prefix) => url.startsWith(prefix));
    const answer = match ? routes[match] : new Error(`sin ruta: ${url}`);
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { fetchJson, calls };
}

describe("indicadores financieros", () => {
  beforeEach(() => logger.reset());

  describe("parseBcrp", () => {
    it("toma los dos últimos días con dato y salta los n.d.", () => {
      assert.deepEqual(parseBcrp(bcrpBody(["3.44", "3.447", "n.d.", "3.436", "n.d."])), {
        valor: 3.436,
        valorAyer: 3.447,
      });
    });

    it("sin ningún dato devuelve null", () => {
      assert.equal(parseBcrp(bcrpBody(["n.d.", "n.d."])), null);
      assert.equal(parseBcrp({}), null);
    });
  });

  describe("parseOpenEr", () => {
    it("convierte la base USD a pesos chilenos y no inventa la UF", () => {
      const parsed = parseOpenEr(OPEN_ER);
      assert.deepEqual(parsed.dolar, { valor: 975, valorAyer: null });
      assert.equal(parsed.euro.valor, 1095.51);
      assert.equal(parsed.uf, undefined);
    });

    it("una respuesta de error no aporta nada", () => {
      assert.deepEqual(parseOpenEr({ result: "error" }), {});
    });
  });

  it("la URL del BCRP pide las últimas tres semanas", () => {
    assert.equal(
      bcrpUrl("PD04640PD", NOW),
      "https://estadisticas.bcrp.gob.pe/estadisticas/series/api/PD04640PD/json/2026-10-01/2026-10-22",
    );
  });

  describe("Perú", () => {
    it("lee dólar y euro en soles del BCRP y no pide UF ni mindicador", async () => {
      const { fetchJson, calls } = fakeFetch({
        "https://estadisticas.bcrp.gob.pe/estadisticas/series/api/PD04640PD/": bcrpBody(["3.447", "3.436"]),
        "https://estadisticas.bcrp.gob.pe/estadisticas/series/api/PD04648PD/": bcrpBody(["4.045", "3.995"]),
      });
      const result = await fetchIndicadores({ country: "PE", includeUf: true, fetchJson, now: NOW });
      assert.deepEqual(result, {
        dolar: { valor: 3.436, valorAyer: 3.447 },
        euro: { valor: 3.995, valorAyer: 4.045 },
      });
      assert.equal(calls.length, 2);
      assert.ok(calls.every((url) => url.includes("bcrp.gob.pe")));
    });

    it("si el BCRP no responde queda sin datos", async () => {
      const { fetchJson } = fakeFetch({});
      const result = await fetchIndicadores({ country: "PE", includeUf: false, fetchJson, now: NOW });
      assert.deepEqual(result, {});
    });
  });

  describe("Chile", () => {
    it("con mindicador al día no consulta el respaldo", async () => {
      const { fetchJson, calls } = fakeFetch({
        "https://mindicador.cl/api/dolar": mindicadorBody(975.1, 970),
        "https://mindicador.cl/api/euro": mindicadorBody(1095, 1100),
        "https://mindicador.cl/api/uf": mindicadorBody(39600, 39590),
      });
      const result = await fetchIndicadores({ country: "CL", includeUf: true, fetchJson, now: NOW });
      assert.deepEqual(result.dolar, { valor: 975.1, valorAyer: 970 });
      assert.deepEqual(result.uf, { valor: 39600, valorAyer: 39590 });
      assert.ok(!calls.some((url) => url.includes("open.er-api")));
    });

    it("lo que mindicador no entrega sale de open.er-api", async () => {
      const { fetchJson } = fakeFetch({
        "https://mindicador.cl/api/dolar": new Error("Timeout obteniendo https://mindicador.cl/api/dolar"),
        "https://mindicador.cl/api/euro": mindicadorBody(1095, 1100),
        "https://open.er-api.com/": OPEN_ER,
      });
      const result = await fetchIndicadores({ country: "CL", includeUf: false, fetchJson, now: NOW });
      assert.deepEqual(result, {
        dolar: { valor: 975, valorAyer: null },
        euro: { valor: 1095, valorAyer: 1100 },
      });
      const lines = logger.recentEntries("finanzas");
      assert.equal(lines.length, 1);
      assert.match(lines[0].message, /dolar timeout.*dolar desde open\.er-api/);
    });

    it("la UF sin mindicador queda sin dato aunque responda el respaldo", async () => {
      const { fetchJson } = fakeFetch({
        "https://mindicador.cl/api/dolar": mindicadorBody(975.1, 970),
        "https://mindicador.cl/api/euro": mindicadorBody(1095, 1100),
        "https://open.er-api.com/": OPEN_ER,
      });
      const result = await fetchIndicadores({ country: "CL", includeUf: true, fetchJson, now: NOW });
      assert.equal(result.uf, undefined);
      assert.match(logger.recentEntries("finanzas")[0].message, /uf sin dato/);
    });

    it("si caen las dos fuentes deja una sola línea en el log", async () => {
      const { fetchJson } = fakeFetch({});
      const result = await fetchIndicadores({ country: "CL", includeUf: true, fetchJson, now: NOW });
      assert.deepEqual(result, {});
      assert.equal(logger.recentEntries("finanzas").length, 1);
    });
  });
});
