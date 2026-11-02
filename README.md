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
| Noticias, Academy, RRHH, vacaciones, procesos, perfil | sí | sí |
| Aplicaciones | sí | sí |
| Asistente IA | sí | sí |
| Soporte TI | sí | no |
| Contenido de portada (feed, indicadores, menú) | sí | no |

Vacaciones comparte pantallas entre países, con las reglas legales de cada uno.

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

Los datos de demostración usan correos `@demo.invalid` y el comando de limpieza borra sólo lo que creó.

## Estructura

```text
src/           app, rutas, servicios, vistas
supabase/      SQL de referencia por país y compartido
scripts/       lanzador por país y utilidades
test/
```

Los cambios de esquema se aplican a mano a partir de `supabase/`. Algunas columnas nuevas también se aseguran al arrancar (`asegurar*` en `src/app.js`), por ejemplo las de autenticación (`confirm_attempts`, `password_reset_token_hash`, `password_reset_expires`).

## Seguridad

- **Pantallas sin sesión** (login, registro, código, recuperar contraseña): tope por IP (`AUTH_IP_RATE_LIMIT`, 300 por 15 min por defecto), 5 contraseñas erradas por cuenta cada 15 min, 5 intentos por código de verificación (contados en la base) y 3 reenvíos o enlaces por cuenta. Los topes por IP y por cuenta viven en memoria de cada proceso.
- **La IP real** sólo se conoce si `trust proxy` está activo (`NODE_ENV=production` o `TRUST_PROXY=true`). Sin eso, todos comparten la IP del proxy y el tope por IP se vuelve global.
- **Olvidé mi contraseña** manda un enlace de un solo uso (30 min). No cambia la contraseña actual.
- **CSRF**: toda petición que cambia algo (POST, PUT, PATCH, DELETE) debe venir de la propia intranet según `Sec-Fetch-Site` u `Origin` (`src/middlewares/crossOriginProtection.js`). Vale el host de la petición y el de `APP_BASE_URL`; otro dominio legítimo va en `CSRF_TRUSTED_ORIGINS` (separados por coma).
- **Sesiones**: en `<schema del país>.sessions` (Postgres), cookie `HttpOnly`, `SameSite=Lax` y `Secure` cuando la petición llega por HTTPS.

Si encuentras un problema de seguridad, avísale directamente al equipo de Informática en vez de abrir un issue.
