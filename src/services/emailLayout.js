/**
 * Plantilla HTML común de todos los correos: cabecera azul, filete verde,
 * titular, botón y pie de no responder. Noticias usa el mismo marco y sólo
 * agrega portada, fecha y subtítulo.
 */

const fs = require("fs");
const path = require("path");
const ejs = require("ejs");
const { MAIL_SENDERS, MAIL_AREAS, areaFromSender } = require("../constants/mailSenders");

const TEMPLATE_PATH = path.join(__dirname, "..", "views", "emails", "layout.ejs");
const LOGO_WHITE_PATH = path.join(__dirname, "..", "public", "img", "logotw_white.png");
const MAX_LOGO_BYTES = 400 * 1024;

let cachedTemplate = null;
let cachedLogo = null;

function appBaseUrl() {
  return String(process.env.APP_BASE_URL || "").replace(/\/+$/, "") || "http://localhost:3000";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function textToHtml(text) {
  const escaped = escapeHtml(text).replace(/\r\n/g, "\n").replace(/\n/g, "<br>");
  return `<p style="margin:0 0 16px 0; color:#334155; font-size:16px; line-height:1.7;">${escaped}</p>`;
}

/**
 * Recuadro gris para lo que el usuario tiene que copiar (contraseña temporal,
 * código de verificación). Tabla y estilos en línea para Outlook.
 */
function secretBox(value, { label = "", letterSpacing = "0.12em" } = {}) {
  const caption = label
    ? `<p style="margin:0 0 8px 0; color:#51637a; font-size:13px; font-weight:700; letter-spacing:0.06em; text-transform:uppercase;">${escapeHtml(label)}</p>`
    : "";
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%; margin:8px 0 20px 0;">
  <tr>
    <td align="center" style="background-color:#eef2f7; border:1px solid #d9e1ea; border-radius:12px; padding:20px 16px;">
      ${caption}<p style="margin:0; color:#0b3a63; font-size:28px; font-weight:800; letter-spacing:${letterSpacing}; font-family:Consolas,'Courier New',monospace; line-height:1.3;">${escapeHtml(value)}</p>
    </td>
  </tr>
</table>`;
}

function absoluteUrl(pathOrUrl) {
  const raw = String(pathOrUrl || "").trim();
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) return raw;
  const base = appBaseUrl();
  return `${base}${raw.startsWith("/") ? "" : "/"}${raw}`;
}

function isPublicBaseUrl(base) {
  return /^https?:\/\//i.test(base) && !/\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:|\/|$)/i.test(base);
}

/**
 * Gmail bloquea las imágenes data:, así que el logo va por URL pública:
 * MAIL_LOGO_URL si está definida, si no el archivo estático de la intranet.
 * Sólo en local (APP_BASE_URL con localhost) se incrusta en base64, porque
 * ningún cliente de correo puede leer localhost.
 */
function logoUrl() {
  if (cachedLogo) return cachedLogo;
  const override = String(process.env.MAIL_LOGO_URL || "").trim();
  if (override) {
    cachedLogo = override;
    return cachedLogo;
  }
  if (isPublicBaseUrl(appBaseUrl())) {
    cachedLogo = `${appBaseUrl()}/img/logotw_white.png`;
    return cachedLogo;
  }
  try {
    if (fs.existsSync(LOGO_WHITE_PATH)) {
      const buffer = fs.readFileSync(LOGO_WHITE_PATH);
      if (buffer.length && buffer.length <= MAX_LOGO_BYTES) {
        cachedLogo = `data:image/png;base64,${buffer.toString("base64")}`;
        return cachedLogo;
      }
    }
  } catch {
    // Si no se puede embeber, el cliente carga el archivo de la intranet.
  }
  cachedLogo = `${appBaseUrl()}/img/logotw_white.png`;
  return cachedLogo;
}

function templateSource() {
  if (!cachedTemplate) {
    cachedTemplate = fs.readFileSync(TEMPLATE_PATH, "utf8");
  }
  return cachedTemplate;
}

function areaBadge(senderNameOrArea) {
  const raw = String(senderNameOrArea || "").trim();
  if (Object.values(MAIL_AREAS).includes(raw)) return raw;
  return areaFromSender(raw || MAIL_SENDERS.intranet);
}

function renderEmailLayout({
  area = MAIL_SENDERS.intranet,
  heading = "",
  bodyHtml = "",
  cta = null,
  preheader = "",
  eyebrow = "",
  subheading = "",
  cover = null,
} = {}) {
  return ejs.render(
    templateSource(),
    {
      area: areaBadge(area),
      heading: heading || "",
      bodyHtml: bodyHtml || "",
      cta:
        cta && cta.href && cta.label
          ? { href: absoluteUrl(cta.href), label: cta.label }
          : null,
      preheader: preheader || heading || "",
      eyebrow: eyebrow || "",
      subheading: subheading || "",
      cover:
        cover && cover.src
          ? {
              src: cover.src,
              alt: cover.alt || heading || "",
              href: cover.href ? absoluteUrl(cover.href) : "",
            }
          : null,
      logoUrl: logoUrl(),
    },
    { filename: TEMPLATE_PATH },
  );
}

function wrapTransactionalHtml({
  html,
  text,
  senderName,
  heading,
  cta,
  preheader,
  skipLayout = false,
}) {
  if (skipLayout) return html || null;

  const bodyHtml = html || (text ? textToHtml(text) : "");
  if (!bodyHtml) return null;

  return renderEmailLayout({
    area: senderName || MAIL_SENDERS.intranet,
    heading,
    bodyHtml,
    cta,
    preheader: preheader || heading || "",
  });
}

module.exports = {
  escapeHtml,
  textToHtml,
  secretBox,
  absoluteUrl,
  renderEmailLayout,
  wrapTransactionalHtml,
};
