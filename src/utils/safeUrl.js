/**
 * Enlaces que se guardan para pintarse en un href.
 *
 * EJS escapa el HTML de un href, no su esquema: `javascript:` o `data:`
 * dentro de un <a> sigue ejecutando código al hacer clic. Sólo se aceptan
 * http(s) absolutos y rutas internas ("/algo", no "//host").
 */

function isSafeLinkUrl(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return false;
  if (/[\u0000-\u001F\s]/.test(raw)) return false;
  if (/^\/(?![/\\])/.test(raw)) return true;
  if (!/^https?:\/\//i.test(raw)) return false;
  try {
    const url = new URL(raw);
    return (url.protocol === "http:" || url.protocol === "https:") && Boolean(url.hostname);
  } catch {
    return false;
  }
}

/**
 * Valor opcional de un formulario: "" → null, enlace válido → el mismo
 * recortado, cualquier otra cosa → error 400 con `campo` en el mensaje.
 */
function optionalLinkUrl(value, campo = "El enlace") {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  if (isSafeLinkUrl(raw)) return raw;
  const error = new Error(`${campo} debe empezar con http:// o https://.`);
  error.statusCode = 400;
  throw error;
}

module.exports = { isSafeLinkUrl, optionalLinkUrl };
