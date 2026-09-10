// Destino post-login. Solo rutas internas relativas: un `returnTo` abierto
// (//evil.com, https://...) redirigiría al usuario fuera de la intranet.

const FALLBACK = "/";

function pathOnly(url) {
  return String(url).split("?")[0].split("#")[0];
}

function isBlockedAuthPath(pathname) {
  return (
    pathname === "/login" ||
    pathname === "/logout" ||
    pathname === "/register" ||
    pathname === "/forgot-password" ||
    pathname === "/verify-email" ||
    pathname.startsWith("/verify-email/") ||
    pathname === "/reset-password" ||
    pathname.startsWith("/auth/")
  );
}

/**
 * @param {unknown} value
 * @param {string | null} [fallback]
 * @returns {string | null}
 */
function safeReturnTo(value, fallback = FALLBACK) {
  if (typeof value !== "string") return fallback;
  const raw = value.trim();
  if (!raw || raw.length > 500) return fallback;
  if (!raw.startsWith("/")) return fallback;
  if (raw.startsWith("//") || raw.includes("://") || raw.includes("\\")) {
    return fallback;
  }
  if (/[\u0000-\u001F\s<>]/.test(raw)) return fallback;

  const pathname = pathOnly(raw);
  if (!pathname.startsWith("/") || pathname.startsWith("//")) return fallback;
  if (isBlockedAuthPath(pathname)) return fallback;
  return raw;
}

function rememberReturnTo(req) {
  if (!req?.session) return;
  if (req.method !== "GET" && req.method !== "HEAD") return;
  const dest = safeReturnTo(req.originalUrl, null);
  if (dest) req.session.returnTo = dest;
}

function consumeReturnTo(session, fallback = FALLBACK) {
  const dest = safeReturnTo(session?.returnTo, fallback);
  if (session) delete session.returnTo;
  return dest;
}

module.exports = { safeReturnTo, rememberReturnTo, consumeReturnTo };
