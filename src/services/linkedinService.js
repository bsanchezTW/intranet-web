const axios = require("axios");
const db = require("../db");
const qs = require("querystring");
const fileStorage = require("./fileStorage");
const logger = require("../utils/logger");

const linkedInHttp = axios.create({ timeout: 15000 });

const CLIENT_ID = process.env.LINKEDIN_CLIENT_ID;
const CLIENT_SECRET = process.env.LINKEDIN_CLIENT_SECRET;
const ORG_ID = process.env.LINKEDIN_ORG_ID;
const LINKEDIN_IMAGES_FOLDER = "linkedin_posts";
const FALLBACK_IMAGE = "/img/fondo-home.png";
const LINKEDIN_PLACEHOLDER_IMAGE = "/img/linkedin_off.jpg";
const LINKEDIN_COMPANY_URL =
  "https://www.linkedin.com/company/transworldpowerandtelecom";
function isLinkedInExplicitlyDisabled() {
  return process.env.LINKEDIN_ENABLED === "false";
}

function isLinkedInConfigured() {
  return Boolean(CLIENT_ID && CLIENT_SECRET && ORG_ID);
}
const LINKEDIN_API_VERSION =
  process.env.LINKEDIN_API_VERSION?.trim() || "202601";

function getPlaceholderPosts() {
  return [
    {
      text: "Síguenos en LinkedIn",
      image_url: LINKEDIN_PLACEHOLDER_IMAGE,
      link_url: LINKEDIN_COMPANY_URL,
    },
  ];
}

function stripTrailingSlash(value) {
  return String(value || "").replace(/\/$/, "");
}

function resolveBaseUrl(req) {
  const callbackUrl = process.env.LINKEDIN_CALLBACK_URL?.trim();
  if (callbackUrl) {
    return stripTrailingSlash(
      callbackUrl.replace(/\/auth\/linkedin\/callback\/?$/i, ""),
    );
  }

  const appBaseUrl = process.env.APP_BASE_URL?.trim();
  if (appBaseUrl) return stripTrailingSlash(appBaseUrl);

  if (req) {
    return stripTrailingSlash(`${req.protocol}://${req.get("host")}`);
  }

  return stripTrailingSlash(
    `http://localhost:${process.env.PORT || 3000}`,
  );
}

function getRedirectUri(req) {
  const explicit = process.env.LINKEDIN_CALLBACK_URL?.trim();
  if (explicit) return stripTrailingSlash(explicit);
  return `${resolveBaseUrl(req)}/auth/linkedin/callback`;
}

function getReauthUrl(req) {
  return `${resolveBaseUrl(req)}/auth/linkedin/login`;
}

function isStoredImageUrl(url) {
  return Boolean(url && String(url).startsWith("/content/"));
}

function isLegacyExternalImageUrl(url) {
  if (!url) return true;
  const value = String(url);
  return (
    value.includes("licdn.com") ||
    value.startsWith("http://") ||
    value.startsWith("https://")
  );
}

const TOKEN_KEY = "linkedin_token";
const REFRESH_KEY = "linkedin_refresh_token";
const EXPIRES_KEY = "linkedin_token_expires_at";
const TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken";

/** Evita seguir golpeando /rest/images tras un 429 APPLICATION DAY. */
let imagesApiBlockedUntil = 0;

function markImagesApiThrottled(error) {
  const retryAfterSec = Number(error.response?.headers?.["retry-after"]);
  const cooldownMs = Number.isFinite(retryAfterSec) && retryAfterSec > 0
    ? retryAfterSec * 1000
    : 6 * 60 * 60 * 1000; // 6h por defecto (límite diario LinkedIn)
  imagesApiBlockedUntil = Date.now() + cooldownMs;
  logger.warn(
    "linkedin",
    `images API 429; sin más llamadas hasta ${new Date(imagesApiBlockedUntil).toISOString()}`,
  );
}

function isUsableCachedImage(url) {
  if (!url || url === FALLBACK_IMAGE || url === LINKEDIN_PLACEHOLDER_IMAGE) {
    return false;
  }
  return isStoredImageUrl(url) || String(url).startsWith("/");
}

function getLinkedInHeaders(accessToken) {
  return {
    Authorization: `Bearer ${accessToken}`,
    "X-Restli-Protocol-Version": "2.0.0",
    "LinkedIn-Version": LINKEDIN_API_VERSION,
  };
}

function assertLinkedInConfig() {
  if (!CLIENT_ID || !CLIENT_SECRET || !ORG_ID) {
    throw new Error(
      "Faltan LINKEDIN_CLIENT_ID, LINKEDIN_CLIENT_SECRET o LINKEDIN_ORG_ID en .env",
    );
  }
}

function logLinkedInError(context, error) {
  const details = error.response?.data;
  const status = error.response?.status;
  let detailStr;
  if (status === 429 || details?.code === "TOO_MANY_REQUESTS") {
    detailStr = `429 límite diario${details?.message ? `: ${details.message}` : ""}`;
  } else if (typeof details === "object" && details) {
    detailStr = details.message || details.code || JSON.stringify(details);
  } else {
    detailStr = details || error.message;
  }
  logger.warn("linkedin", `${context}: ${detailStr}`);
  return detailStr;
}

async function saveConfigValue(key, value) {
  await db.query(
    `INSERT INTO system_config (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
    [key, value],
  );
}

async function saveTokens(accessToken, refreshToken, expiresIn) {
  await saveConfigValue(TOKEN_KEY, accessToken);

  if (refreshToken) {
    await saveConfigValue(REFRESH_KEY, refreshToken);
  }

  if (expiresIn) {
    const expiresAt = Date.now() + Number(expiresIn) * 1000;
    await saveConfigValue(EXPIRES_KEY, String(expiresAt));
  }
}

async function getAccessToken() {
  const { rows } = await db.query(
    "SELECT value FROM system_config WHERE key = $1",
    [TOKEN_KEY],
  );
  return rows.length > 0 ? rows[0].value : null;
}

async function getRefreshToken() {
  const { rows } = await db.query(
    "SELECT value FROM system_config WHERE key = $1",
    [REFRESH_KEY],
  );
  return rows.length > 0 ? rows[0].value : null;
}

function getAuthorizationUrl(req) {
  assertLinkedInConfig();
  const redirectUri = getRedirectUri(req);
  const scope = "r_organization_social";
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    scope,
    prompt: "consent",
  });
  return `https://www.linkedin.com/oauth/v2/authorization?${params.toString()}`;
}

async function exchangeCodeForToken(code, req) {
  const redirectUri = getRedirectUri(req);
  const values = {
    grant_type: "authorization_code",
    code: code,
    redirect_uri: redirectUri,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
  };

  try {
    const response = await linkedInHttp.post(TOKEN_URL, qs.stringify(values), {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });

    const { access_token, refresh_token, expires_in } = response.data;
    await saveTokens(access_token, refresh_token, expires_in);

    if (!refresh_token) {
      console.warn(
        "[LINKEDIN] No se recibió refresh_token. El token dura ~60 días; vuelva a autorizar en",
        getReauthUrl(req),
        "antes de que expire.",
      );
    }

    return access_token;
  } catch (error) {
    const detail = logLinkedInError("Error autenticando", error);
    throw new Error(`Error autenticando con LinkedIn: ${detail}`);
  }
}

async function refreshAccessToken(req) {
  const refreshToken = await getRefreshToken();
  if (!refreshToken) {
    throw new Error(
      `No hay refresh token guardado. Visite ${getReauthUrl(req)} para reautorizar.`,
    );
  }

  const values = {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
  };

  try {
    const response = await linkedInHttp.post(TOKEN_URL, qs.stringify(values), {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });

    const { access_token, refresh_token, expires_in } = response.data;
    await saveTokens(access_token, refresh_token || refreshToken, expires_in);
    return access_token;
  } catch (error) {
    logLinkedInError("Error renovando token", error);
    throw error;
  }
}

function postImageKey(enlaceUrl) {
  return (
    String(enlaceUrl || "post")
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(-60) || "post"
  );
}

async function persistImageToStorage(imageUrl, enlaceUrl) {
  if (isStoredImageUrl(imageUrl)) return imageUrl;
  if (!imageUrl || imageUrl === FALLBACK_IMAGE) return FALLBACK_IMAGE;
  if (!isLegacyExternalImageUrl(imageUrl)) {
    return String(imageUrl).startsWith("/") ? imageUrl : FALLBACK_IMAGE;
  }

  try {
    const response = await axios.get(imageUrl, {
      responseType: "arraybuffer",
      timeout: 30000,
      headers: { "User-Agent": "Transworld-Intranet/1.0" },
    });
    const buffer = Buffer.from(response.data);
    if (!buffer.length) return FALLBACK_IMAGE;

    const ext = imageUrl.toLowerCase().includes(".png") ? ".png" : ".jpg";
    const saved = await fileStorage.saveFile(
      buffer,
      LINKEDIN_IMAGES_FOLDER,
      `${postImageKey(enlaceUrl)}${ext}`,
    );
    return saved.url;
  } catch (error) {
    logger.warn("linkedin", error);
    return FALLBACK_IMAGE;
  }
}

function stripLittleTextFormat(commentary) {
  if (!commentary) return "";
  return String(commentary)
    .replace(/@\[[^\]]+\]\([^)]+\)/g, (match) => {
      const nameMatch = match.match(/^@\[([^\]]+)\]/);
      return nameMatch ? nameMatch[1] : match;
    })
    .replace(/\{hashtag\|[^|]+\|([^}]+)\}/g, "#$1")
    .replace(/\\(.)/g, "$1")
    .trim();
}

function extractPostCommentary(post) {
  const text = stripLittleTextFormat(post?.commentary);
  return text || "Publicación de Transworld";
}

function buildPostLink(postId) {
  return `https://www.linkedin.com/feed/update/${encodeURIComponent(postId)}`;
}

function normalizeLinkedInPost(post) {
  return {
    text: post.text ?? post.texto ?? "Publicación de Transworld",
    image_url: post.image_url ?? post.imagen_url ?? FALLBACK_IMAGE,
    link_url: post.link_url ?? post.enlace_url ?? "#",
  };
}

let linkedinPostsSchemaEnsured = false;

async function ensureLinkedInPostsSchema() {
  if (linkedinPostsSchemaEnsured) return;
  try {
    await db.query(
      "ALTER TABLE linkedin_posts ADD COLUMN IF NOT EXISTS text TEXT",
    );
    linkedinPostsSchemaEnsured = true;
  } catch (error) {
    console.warn(
      "[LINKEDIN] No se pudo asegurar columna text en linkedin_posts:",
      error.message,
    );
  }
}

function getPublishedApiElements(apiElements) {
  return (apiElements || [])
    .filter((post) => post.lifecycleState === "PUBLISHED")
    .slice(0, 3);
}

function mergeCachedWithApiText(cached, apiElements) {
  const published = getPublishedApiElements(apiElements);
  return cached.map((cachedPost, index) => {
    const apiPost = published[index];
    return normalizeLinkedInPost({
      ...cachedPost,
      text: apiPost
        ? extractPostCommentary(apiPost)
        : cachedPost.text ?? cachedPost.texto,
      link_url:
        cachedPost.link_url ??
        cachedPost.enlace_url ??
        (apiPost ? buildPostLink(apiPost.id) : "#"),
    });
  });
}

async function enrichPostsWithStoredImages(posts) {
  const enriched = [];
  for (const post of posts) {
    const image_url = await persistImageToStorage(
      post.image_url ?? post.imagen_url,
      post.link_url ?? post.enlace_url,
    );
    enriched.push(normalizeLinkedInPost({ ...post, image_url }));
  }
  return enriched;
}

function extractImageUrns(post) {
  const urns = [];
  const content = post.content || {};

  if (content.media?.id?.startsWith("urn:li:image:")) {
    urns.push(content.media.id);
  }
  if (content.article?.thumbnail?.startsWith("urn:li:image:")) {
    urns.push(content.article.thumbnail);
  }
  if (Array.isArray(content.multiImage?.images)) {
    for (const image of content.multiImage.images) {
      if (image.id?.startsWith("urn:li:image:")) urns.push(image.id);
    }
  }

  return urns;
}

async function fetchImageDownloadUrls(accessToken, imageUrns) {
  const uniqueUrns = [...new Set(imageUrns)].slice(0, 5);
  if (!uniqueUrns.length) return {};

  if (Date.now() < imagesApiBlockedUntil) {
    console.warn(
      "[LINKEDIN] Saltando resolución de imágenes (throttle diario activo).",
    );
    return {};
  }

  const idsParam = `List(${uniqueUrns.map((urn) => encodeURIComponent(urn)).join(",")})`;

  try {
    const response = await linkedInHttp.get(
      `https://api.linkedin.com/rest/images?ids=${idsParam}`,
      { headers: getLinkedInHeaders(accessToken) },
    );

    const map = {};
    const results = response.data.results || {};
    for (const [urn, info] of Object.entries(results)) {
      if (info?.downloadUrl) map[urn] = info.downloadUrl;
    }
    return map;
  } catch (error) {
    if (error.response?.status === 429) {
      markImagesApiThrottled(error);
    }
    logLinkedInError("Error resolviendo imágenes", error);
    return {};
  }
}

async function parsePosts(response, accessToken) {
  if (!response.data?.elements) return [];

  const published = response.data.elements.filter(
    (post) => post.lifecycleState === "PUBLISHED",
  );
  const imageUrlMap = await fetchImageDownloadUrls(
    accessToken,
    published.flatMap(extractImageUrns),
  );

  const posts = [];
  for (const post of published) {
    try {
      const text = extractPostCommentary(post);
      let imageUrl = FALLBACK_IMAGE;
      const postUrl = buildPostLink(post.id);

      const imageUrns = extractImageUrns(post);
      if (imageUrns.length > 0 && imageUrlMap[imageUrns[0]]) {
        imageUrl = imageUrlMap[imageUrns[0]];
      } else {
        const contentStr = JSON.stringify(post.content || {});
        const urlsMatch = contentStr.match(
          /https:\/\/media\.licdn[^\s"\\]+/g,
        );
        if (urlsMatch?.length) imageUrl = urlsMatch[0];
      }

      posts.push({ text, image_url: imageUrl, link_url: postUrl });
    } catch (parseError) {
      logger.warn("linkedin", parseError);
    }
  }

  return posts.slice(0, 3);
}

async function fetchPostByUrn(accessToken, urn) {
  const response = await linkedInHttp.get(
    `https://api.linkedin.com/rest/posts/${encodeURIComponent(urn)}`,
    { headers: getLinkedInHeaders(accessToken) },
  );
  return response.data;
}

function extractPostUrnFromLink(linkUrl) {
  try {
    const match = String(linkUrl).match(/feed\/update\/([^/?#]+)/);
    if (!match) return null;
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

function postsNeedTextBackfill(posts) {
  return posts.some(
    (post) =>
      !post.text || post.text === "Publicación de Transworld",
  );
}

async function backfillMissingTextFromApi(accessToken, posts) {
  const filled = [];
  for (const post of posts) {
    const normalized = normalizeLinkedInPost(post);
    if (
      normalized.text &&
      normalized.text !== "Publicación de Transworld"
    ) {
      filled.push(normalized);
      continue;
    }

    const urn = extractPostUrnFromLink(normalized.link_url);
    if (!urn) {
      filled.push(normalized);
      continue;
    }

    try {
      const apiPost = await fetchPostByUrn(accessToken, urn);
      filled.push(
        normalizeLinkedInPost({
          ...normalized,
          text: extractPostCommentary(apiPost),
        }),
      );
    } catch (error) {
      if (error.response?.status === 429) {
        console.warn(
          "[LINKEDIN] Throttle al rellenar texto; usando caché parcial.",
        );
        filled.push(normalized, ...posts.slice(filled.length + 1).map(normalizeLinkedInPost));
        break;
      }
      logLinkedInError(`Error leyendo post ${urn}`, error);
      filled.push(normalized);
    }
  }
  return filled;
}

async function fetchOrganizationPosts(accessToken) {
  assertLinkedInConfig();
  const organizationUrn = `urn:li:organization:${ORG_ID}`;
  const author = encodeURIComponent(organizationUrn);
  return linkedInHttp.get(
    `https://api.linkedin.com/rest/posts?author=${author}&q=author&count=5&sortBy=LAST_MODIFIED`,
    { headers: getLinkedInHeaders(accessToken) },
  );
}

async function getPostsFromDb() {
  try {
    await ensureLinkedInPostsSchema();
    const { rows } = await db.query(
      `SELECT text, image_url, link_url
       FROM linkedin_posts
       ORDER BY created_at DESC
       LIMIT 3`,
    );

    return rows
      .filter((row) => row.image_url && row.link_url)
      .map((row) => normalizeLinkedInPost(row));
  } catch (error) {
    logger.warn("linkedin", error);
    return [];
  }
}

async function syncPostsToDb(posts) {
  if (!posts.length) return;

  try {
    await ensureLinkedInPostsSchema();
    await db.query("DELETE FROM linkedin_posts");
    for (const post of posts.slice(0, 3)) {
      const normalized = normalizeLinkedInPost(post);
      await db.query(
        `INSERT INTO linkedin_posts (text, image_url, link_url, created_at)
         VALUES ($1, $2, $3, NOW())`,
        [normalized.text, normalized.image_url, normalized.link_url],
      );
    }
  } catch (error) {
    logger.warn("linkedin", error);
  }
}

function postFingerprint(posts) {
  return posts
    .map((post) => post.link_url || post.enlace_url || "")
    .filter(Boolean)
    .join("|");
}

/**
 * Si los posts de la API coinciden con el caché local y ya tienen imagen
 * usable en el storage, no vuelve a llamar Images API ni re-sube archivos.
 */
function reuseCachedPostsIfUnchanged(parsed, cached) {
  if (!parsed.length || !cached.length) return null;
  if (postFingerprint(parsed) !== postFingerprint(cached)) return null;
  if (!cached.every((post) => isUsableCachedImage(post.image_url))) return null;
  return parsed.map((parsedPost, index) => {
    const cachedPost = cached[index];
    if (!cachedPost || !isUsableCachedImage(cachedPost.image_url)) {
      return normalizeLinkedInPost(parsedPost);
    }
    return normalizeLinkedInPost({
      text: parsedPost.text ?? parsedPost.texto,
      image_url: cachedPost.image_url ?? cachedPost.imagen_url,
      link_url: parsedPost.link_url ?? parsedPost.enlace_url ?? cachedPost.link_url,
    });
  });
}

async function fetchPostsFromApi(accessToken) {
  const response = await fetchOrganizationPosts(accessToken);
  const cached = await getPostsFromDb();

  // Resolver imágenes solo si hay posts nuevos/cambiados o el caché no sirve.
  // parsePosts llama a Images API; si el fingerprint coincide, lo evitamos.
  const published = getPublishedApiElements(response.data?.elements);
  const previewFingerprint = published
    .map((post) => buildPostLink(post.id))
    .join("|");
  const cachedFingerprint = postFingerprint(cached);

  if (
    previewFingerprint &&
    previewFingerprint === cachedFingerprint &&
    cached.every((post) => isUsableCachedImage(post.image_url))
  ) {
    const merged = mergeCachedWithApiText(cached, response.data?.elements);
    await syncPostsToDb(merged);
    return merged;
  }

  const parsed = await parsePosts(response, accessToken);
  if (!parsed.length) return [];

  const reused = reuseCachedPostsIfUnchanged(parsed, cached);
  if (reused) {
    return reused;
  }

  const posts = await enrichPostsWithStoredImages(parsed);
  const hasUsableImages = posts.some((post) =>
    isUsableCachedImage(post.image_url),
  );

  // No pisar un buen caché con placeholders si LinkedIn no entregó imágenes.
  if (!hasUsableImages && cached.some((post) => isUsableCachedImage(post.image_url))) {
    console.warn(
      "[LINKEDIN] Sin imágenes nuevas (posible throttle); manteniendo caché local.",
    );
    const merged = mergeCachedWithApiText(cached, response.data?.elements);
    await syncPostsToDb(merged);
    return merged;
  }

  await syncPostsToDb(posts);
  return posts;
}

async function resolvePostsFallback(accessToken = null) {
  const cached = await getPostsFromDb();
  if (!cached.length) return getPlaceholderPosts();

  if (accessToken && postsNeedTextBackfill(cached)) {
    const backfilled = await backfillMissingTextFromApi(accessToken, cached);
    const hasRealText = backfilled.some(
      (post) =>
        post.text && post.text !== "Publicación de Transworld",
    );
    if (hasRealText) {
      await syncPostsToDb(backfilled);
      return backfilled;
    }
  }

  return cached;
}

async function getCompanyPosts() {
  if (isLinkedInExplicitlyDisabled()) {
    return getPlaceholderPosts();
  }

  if (!isLinkedInConfigured()) {
    return resolvePostsFallback();
  }

  let accessToken = await getAccessToken();
  if (!accessToken) {
    const cached = await getPostsFromDb();
    if (cached.length) {
      return cached;
    }
    return getPlaceholderPosts();
  }

  try {
    const posts = await fetchPostsFromApi(accessToken);
    if (posts.length) return posts;
    return resolvePostsFallback(accessToken);
  } catch (error) {
    if (error.response?.status !== 401) {
      logLinkedInError("Error obteniendo posts", error);
      return resolvePostsFallback(accessToken);
    }

    const refreshToken = await getRefreshToken();
    if (!refreshToken) {
      console.warn(
        `[LINKEDIN] Token expirado y sin refresh token. Reautorice en ${getReauthUrl()}.`,
      );
      return resolvePostsFallback(accessToken);
    }

    try {
      accessToken = await refreshAccessToken();
      const posts = await fetchPostsFromApi(accessToken);
      if (posts.length) return posts;
      return resolvePostsFallback(accessToken);
    } catch (refreshError) {
      logLinkedInError("Renovación automática fallida", refreshError);
      console.warn(
        `[LINKEDIN] Token inválido; mostrando caché local. Reautorice en ${getReauthUrl()}.`,
      );
      return resolvePostsFallback(accessToken);
    }
  }
}

module.exports = {
  getAuthorizationUrl,
  exchangeCodeForToken,
  getCompanyPosts,
  getPlaceholderPosts,
};
