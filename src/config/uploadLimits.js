const MEBIBYTE = 1024 * 1024;

// Límites funcionales del servidor. El bucket se provisiona a 250 MiB para
// dejar margen sobre el objeto más grande admitido hoy (video de noticia).
// Mantener estos valores por debajo de STORAGE_OBJECT_MB.
const UPLOAD_LIMITS_MB = Object.freeze({
  PROFILE_PHOTO: 5,
  EVENT_IMAGE: 10,
  EVENT_VIDEO: 100,
  EVENT_MEDIA: 100,
  PROCESS_DOCUMENT: 20,
  COURSE_MATERIAL: 40,
  TICKET_ATTACHMENT: 40,
  NEWS_ATTACHMENT: 200,
  STORAGE_OBJECT: 250,
});

function toBytes(mebibytes) {
  return mebibytes * MEBIBYTE;
}

const UPLOAD_LIMITS_BYTES = Object.freeze(
  Object.fromEntries(
    Object.entries(UPLOAD_LIMITS_MB).map(([key, value]) => [key, toBytes(value)]),
  ),
);

module.exports = {
  MEBIBYTE,
  UPLOAD_LIMITS_MB,
  UPLOAD_LIMITS_BYTES,
  toBytes,
};
