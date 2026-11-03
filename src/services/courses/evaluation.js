/**
 * Evaluación de un curso, sin base de datos: lo usan las rutas de Cursos
 * (routes/index.js) y los tests.
 */

/** Nota mínima para ver las respuestas correctas. */
const FEEDBACK_MIN_SCORE = 80;

/**
 * Corrige las respuestas. `correctas` son filas { pregunta_id, alternativa_id }
 * (una por pregunta) y `respuestas` el cuerpo del formulario (preg_<id>).
 *
 * Sin preguntas no hay nota: antes salía NaN y el UPDATE fallaba con 500.
 * @returns {{ ok: false, error } | { ok: true, porcentaje, buenas, total, mostrarFeedback, mapeoCorrectas }}
 */
function gradeEvaluation(correctas = [], respuestas = {}) {
  const total = correctas.length;
  if (total === 0) {
    return { ok: false, error: "Este curso todavía no tiene una evaluación." };
  }
  const mapeoCorrectas = {};
  let buenas = 0;
  for (const c of correctas) {
    mapeoCorrectas[c.pregunta_id] = c.alternativa_id;
    const respuesta = respuestas && respuestas[`preg_${c.pregunta_id}`];
    if (respuesta != null && String(respuesta) === String(c.alternativa_id)) buenas += 1;
  }
  const porcentaje = Math.round((buenas / total) * 100);
  return {
    ok: true,
    porcentaje,
    buenas,
    total,
    mostrarFeedback: porcentaje >= FEEDBACK_MIN_SCORE,
    mapeoCorrectas,
  };
}

/**
 * Reparte las alternativas (una sola consulta) entre sus preguntas, en el
 * orden en que vienen. Los ids son bigint: pg los entrega como texto.
 */
function attachOptions(preguntas = [], alternativas = []) {
  const porPregunta = new Map(preguntas.map((p) => [String(p.id), []]));
  for (const alt of alternativas) {
    const lista = porPregunta.get(String(alt.question_id));
    if (lista) lista.push({ id: alt.id, text: alt.text });
  }
  return preguntas.map((p) => ({ ...p, alternativas: porPregunta.get(String(p.id)) || [] }));
}

module.exports = { gradeEvaluation, attachOptions, FEEDBACK_MIN_SCORE };
