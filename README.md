# Intranet Transworld

Intranet corporativa de Transworld. Un mismo código se despliega como dos instancias independientes, **Chile** y **Perú**, elegidas con la variable `COUNTRY` (`CL` / `PE`). Si `COUNTRY` falta o no es válida, la app no arranca.

<p align="center">
  <img alt="Node.js" src="https://img.shields.io/badge/Node.js-22+-339933?style=flat-square&logo=nodedotjs&logoColor=white">
  <img alt="Express" src="https://img.shields.io/badge/Express-5-000000?style=flat-square&logo=express&logoColor=white">
  <img alt="PostgreSQL" src="https://img.shields.io/badge/PostgreSQL-4169E1?style=flat-square&logo=postgresql&logoColor=white">
</p>

## Módulos

| Módulo | Chile | Perú |
|--------|:-----:|:----:|
| Noticias, Academy, RRHH, procesos, perfil, marketing, documentos | sí | sí |
| Aplicaciones | sí | sí |
| Gestión de permisos (`/permisos`, solo el superadmin) | sí | sí |
| Logística: hojas de ruta y revisión mecánica de la flota | sí | sí |
| Asistente IA | sí | sí |
| Vacaciones en la intranet | no (se piden en Rex+) | sí |
| Letras de cambio | no | sí |
| Centros de costo, rendiciones y solicitudes de fondos | sí | no |
| Soporte TI | sí | no |
| Contenido de portada (feed de LinkedIn, indicador UF, menú del casino, portales RRHH) | sí | no |

Qué existe en cada país lo decide la matriz de `src/config/features.js`; una capacidad apagada también bloquea su ruta y su operación de backend (`requireFeature`). Vacaciones usa las reglas legales de cada país. Logística está en desarrollo: sin permisos asignados no aparece a nadie, y la revisión física de la flota (modelo 3D y captura de daños) está deshabilitada a propósito; para reactivarla ver `docs/REACTIVAR-REVISION-FISICA.md`.

Los permisos se conceden por módulo desde Gestión de permisos (catálogo en `src/services/permissions/catalog/`); no hay roles fijos.

## Stack

| Capa | Tecnología |
|------|------------|
| Runtime | Node.js 22+ (CommonJS) |
| Servidor | Express 5, EJS |
| Base de datos | PostgreSQL |
| Archivos | Almacenamiento privado de objetos |
| Correo | Proveedor transaccional |

## Desarrollo local

```bash
npm install
# crear .env con las variables del equipo (pedirlas a Informática)

npm run dev:cl   # instancia Chile
npm run dev:pe   # instancia Perú (puede correr a la vez)
```

El lanzador fija `COUNTRY`, el puerto y la configuración propia del país. Ninguna credencial va en el repositorio.

| Script | Qué hace |
|--------|----------|
| `npm run dev:cl` / `dev:pe` | Instancia del país |
| `npm start` | Arranca con el `.env` de la raíz |
| `npm test` | Suite de pruebas |
| `npm run demo:pe` / `demo:pe:estado` / `demo:pe:limpiar` | Datos ficticios para probar vacaciones de Perú |
| `npm run email-listener` | Ingreso opcional de tickets por correo |
| `node scripts/migrar.js --pais CL` | Aplica las migraciones pendientes antes de desplegar |
| `node scripts/tareas.js --pais CL` | Corre las tareas programadas una vez (ver más abajo) |
| `node scripts/permisos-arranque.js --pais CL` | Arranque único de Gestión de permisos en un país (sin `--aplicar` solo muestra el plan) |
| `node scripts/superadmin.js --pais CL --correo <correo>` | Marca a una persona como superadmin |
| `node scripts/vaciar-galerias.js` | Vacía las galerías de eventos en Storage para liberar cuota (sin `--confirmar` solo muestra lo que borraría) |

Los datos de demostración usan correos `@demo.invalid` y el comando de limpieza borra sólo lo que creó.

## Estructura

```text
src/           app, config (país y features), middlewares, migraciones, rutas, servicios, vistas EJS
supabase/      SQL de referencia: chile/, peru/ y shared/ (incluye galeria_web.sql y vaciar_galerias.sql)
scripts/       lanzador por país, migraciones, tareas, permisos, demo y utilidades
docs/          notas operativas (REACTIVAR-REVISION-FISICA.md)
test/          pruebas con node:test
```

**Tareas programadas** (cierre de tickets, limpieza de historial, purga de gastos, vacaciones): la app las revisa cada 5 minutos y `<schema>.job_runs` decide que corran una sola vez por periodo. Para no depender de que Passenger mantenga vivo el proceso, programa en cPanel → Cron Jobs, cada 15 minutos y por país, `node scripts/tareas.js --pais CL` (y `--pais PE`), y define `IN_PROCESS_JOBS=false` en la app.

**Correo de soporte** (`npm run email-listener`): procesa todos los correos nuevos por UID (el último procesado queda en `<schema>.email_intake_state`; la primera vez parte del final del buzón), reconecta solo si IMAP se corta e ignora respuestas automáticas, rebotes y correos de la propia casilla.

El test de integración con Postgres (`test/pg-integration.test.js`) corre sólo con `INTEGRATION_PG_URL` apuntando a una base desechable.

Los esquemas de referencia están en `supabase/`. Los cambios nuevos van como migración en `src/migrations/` (`NNN_nombre.js`, al final de `index.js`; una ya publicada no se edita). Se aplican al arrancar y quedan anotados en `<schema>.schema_migrations`; para correrlas antes de desplegar: `node scripts/migrar.js --pais CL`. Las `ensure*Schema` de cada módulo siguen corriendo al arrancar mientras se pasan a migraciones.

## Seguridad

- **Pantallas sin sesión** (login, registro, código, recuperar contraseña): tope por IP (`AUTH_IP_RATE_LIMIT`, 300 por 15 min por defecto), 5 contraseñas erradas por cuenta cada 15 min, 5 intentos por código de verificación (contados en la base) y 3 reenvíos o enlaces por cuenta. Los topes por IP y por cuenta viven en memoria de cada proceso.
- **La IP real** sólo se conoce si `trust proxy` está activo (`NODE_ENV=production` o `TRUST_PROXY=true`). Sin eso, todos comparten la IP del proxy y el tope por IP se vuelve global.
- **Olvidé mi contraseña** manda un enlace de un solo uso (30 min). No cambia la contraseña actual.
- **CSRF**: toda petición que cambia algo (POST, PUT, PATCH, DELETE) debe venir de la propia intranet según `Sec-Fetch-Site` u `Origin` (`src/middlewares/crossOriginProtection.js`). Vale el host de la petición y el de `APP_BASE_URL`; otro dominio legítimo va en `CSRF_TRUSTED_ORIGINS` (separados por coma).
- **Sesiones**: en `<schema del país>.sessions` (Postgres), cookie `HttpOnly`, `SameSite=Lax` y `Secure` cuando la petición llega por HTTPS.
- **Cabeceras** (`src/middlewares/securityHeaders.js`): `nosniff`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`, HSTS por HTTPS y una CSP mínima aplicada (`frame-ancestors`, `base-uri`, `object-src`). La CSP estricta (scripts sólo propios, de los CDN de la lista o inline con el nonce de la petición; sin `onclick`/`onerror`: van como `data-accion`, ver `public/js/acciones.js`) va en `Content-Security-Policy-Report-Only` y lo que bloquearía aparece en el log `csp`. Con el log limpio en staging, `CSP_ENFORCE=true` la aplica. Un `<script>` inline nuevo lleva `nonce="<%= locals.cspNonce %>"`.

- **TLS hacia Postgres**: con `DB_SSL_CA` (ruta al `.crt` de Supabase, Database Settings → SSL Configuration, o el PEM en la variable) se verifica el certificado del pooler. Sin ella la conexión se cifra pero no se verifica, y el log lo advierte al arrancar.
- **Asistente**: cupo por persona de `ASSISTANT_DAILY_TURNS` consultas al día (50) y `ASSISTANT_TURNS_PER_MINUTE` por minuto (6), contado en `<schema>.assistant_usage` junto con los tokens.
- **Recuperar acceso**: no hay login de emergencia por la web (`AUTH_USER`/`AUTH_PASS` se eliminaron). Si nadie puede entrar a Gestión de Permisos: `node scripts/superadmin.js --pais CL --correo persona@transworld.cl` desde el servidor (queda en `perm_audit`).

Si encuentras un problema de seguridad, avísale directamente al equipo de Informática en vez de abrir un issue.
