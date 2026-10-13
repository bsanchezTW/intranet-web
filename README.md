# Intranet Transworld

Un repositorio, dos instancias: **Chile** (`COUNTRY=CL`) y **Perú** (`COUNTRY=PE`). Cada proceso tiene su zona horaria, dominio de correo, cookie de sesión y datos. No hay un “modo Chile por defecto”: si `COUNTRY` falta o no es `CL`/`PE`, la app no arranca.

Auth es propia (sesiones + PBKDF2). No se usa Supabase Auth.

<p align="center">
  <img alt="Node.js" src="https://img.shields.io/badge/Node.js-22+-339933?style=flat-square&logo=nodedotjs&logoColor=white">
  <img alt="Express" src="https://img.shields.io/badge/Express-5-000000?style=flat-square&logo=express&logoColor=white">
  <img alt="PostgreSQL" src="https://img.shields.io/badge/PostgreSQL-pg-4169E1?style=flat-square&logo=postgresql&logoColor=white">
  <img alt="Supabase" src="https://img.shields.io/badge/Supabase-3FCF8E?style=flat-square&logo=supabase&logoColor=white">
</p>

## Qué hay en cada instancia

| Módulo | Chile | Perú |
|--------|:-----:|:----:|
| Noticias, Academy, RRHH, vacaciones, procesos, perfil | sí | sí |
| Apps (un solo catálogo para ambos países) | sí | sí |
| Tickets / soporte TI | sí | no |
| Asistente Claude | sí | sí |
| Feed LinkedIn, UF, menú de almuerzo | sí | no |

Vacaciones usan la misma pantalla con reglas distintas (estrategias Chile / Perú). El login solo acepta el TLD del país de la instancia (`.cl` no entra en Perú y al revés).

## Un repo, dos dominios, una base

El mismo código se despliega dos veces (`COUNTRY=CL` y `COUNTRY=PE`). Comparten el proyecto Supabase `INTRANET - TW_P&T` (`dgadjvptxhotjylwsglx`) y la misma Postgres. Lo que cambia es el **schema** (`chile` / `peru`), el bucket y las variables de cada proceso. Node fija `search_path` según `COUNTRY`; no hay dos bases.

| | Chile | Perú |
| --- | --- | --- |
| Dominio | `transworld.cl` | `transworld.pe` |
| Schema | `chile` | `peru` |
| Login pooler | `intranet_chile.<ref>` | `intranet_peru.<ref>` |
| Bucket | `intranet-content` | `intranet-content-pe` |
| Cookie | `tw_sid_cl` | `tw_sid_pe` |

No añadir `chile`, `peru` ni `shared` a Extra Schemas de PostgREST. El SQL de referencia está en `supabase/chile/`, `supabase/peru/` y `supabase/shared/` (`schema.sql` + `storage.sql`).

El catálogo de Aplicaciones vive en `shared.applications`. `chile.applications` y `peru.applications` son vistas: crear, editar o borrar una app en cualquier instancia se refleja en las dos. Los iconos e instructivos se guardan en ambos buckets.

Los archivos se sirven por `/content` (sesión) o `/media/<firma>/...` (imágenes de correo). El navegador no recibe claves Supabase.

## Stack

| Capa | Tecnología |
|------|------------|
| Runtime | Node.js 22+ (CommonJS) |
| Servidor | Express 5, EJS |
| Base | PostgreSQL (`pg`) |
| Archivos | Supabase Storage privado |
| Correo | Brevo |
| IA | Anthropic Claude |

## Cómo levantarlo

```bash
npm install
cp .env.example .env   # credenciales compartidas (BD, Supabase, Brevo)

npm run dev:cl   # http://localhost:3000  Chile
npm run dev:pe   # http://localhost:3001  Perú (puede correr a la vez)
```

El lanzador pone `COUNTRY`, puerto, `APP_BASE_URL`, bucket y el usuario de Postgres del país. En cPanel / Render cada dominio declara `COUNTRY`, `APP_BASE_URL`, el bucket y `DB_USER` del país (`intranet_chile.<ref>` / `intranet_peru.<ref>`). El resto (host, password de cada rol, Supabase, Brevo) puede ser el mismo archivo como base.

| Script | Qué hace |
|--------|----------|
| `npm run dev:cl` / `dev:pe` | Instancia del país |
| `npm start` | `src/app.js` con el `.env` de la raíz |
| `npm test` | Suite Node |
| `npm run email-listener` | IMAP opcional (tickets por correo) |

Admin bootstrap de Perú (cambiar al entrar): `admin@transworld.pe` / `ChangeMe!Intranet`. Chile usa las cuentas ya existentes.

## Identificadores

La misma taxonomía aplica a los schemas `chile` y `peru`. El formato depende de si el `id` se cita y del volumen de la tabla:

| Formato | Tablas |
|---------|--------|
| **6 dígitos aleatorios** (100000–999999) | `users`, `vacation_requests` |
| **8 dígitos aleatorios** (10000000–99999999) | `expense_requests` (solicitudes de fondos y rendiciones comparten numeración) |
| **4 dígitos aleatorios** (1111–9999) | `work_areas`, `support_tickets` |
| **integer IDENTITY** (1, 2, 3…) | `news_articles`, `events`, `shared.applications`, `courses`, `vacation_periods`, `vacation_balance_adjustments`, `lunch_menu`, `public_holidays`, `documents`, `other_documents`, `study_materials`, `linkedin_posts`, `user_course_progress`, `cost_centers`, `claude_conversations` |
| **bigint IDENTITY** (1, 2, 3…) | `questions`, `question_options`, `change_log`, `expense_request_items`, `expense_request_attachments`, `claude_messages` |
| **correlativo por padre** (1, 2, 3… en cada ticket) | `ticket_replies` (`PRIMARY KEY (ticket_id, id)`) |

El trigger `BEFORE INSERT` `trg_six_digit_id` asigna el número en `users` y `vacation_requests`, y `trg_eight_digit_id` en `expense_requests`, si el `INSERT` no trae `id`. `work_areas` y `support_tickets` usan `trg_four_digit_id`. El catálogo usa `GENERATED BY DEFAULT AS IDENTITY`. Las respuestas de un ticket (`ticket_replies`) usan `trg_ticket_reply_id`: correlativo 1, 2, 3… por `ticket_id`. No hay generador de IDs de usuario en Node: el registro y RRHH hacen `INSERT … RETURNING id`.

`SELECT chile.ensure_id_strategy()` / `peru.ensure_id_strategy()` (al final de `schema.sql`) remapea filas existentes, actualiza FKs, `period_allocations` y `change_log.link_path`, y deja el trigger o IDENTITY. **Ejecutarlo una vez por schema** en Supabase; no corre en cada arranque de Node (bloquea todo el schema). Un chat Claude abierto puede quedar con un `conversationId` viejo hasta recargar. Las fotos de usuario (`user/{id}.jpg`) no cambian. Enlaces viejos a tickets o noticias por `id` numérico dejan de aplicar tras el remapeo.

Las noticias también se pueden abrir por slug. Tras aplicar el SQL, conviene comprobar: `users`/`vacation_requests` con `MIN(id) >= 100000`; `work_areas` y `support_tickets` en 1111–9999 con `trg_four_digit_id`; catálogo e hijas con IDENTITY (bigint en quiz/logs); `ticket_replies` con PK `(ticket_id, id)` y correlativo por ticket; FKs (`work_area_id`, `ticket_id`, `course_id`, `question_id`, `vacation_period_id`) coherentes en ambos schemas.

## Vacaciones (Perú)

Perú cuenta en **días calendario**: 30 por cada año de servicio **cumplido**
(D.L. 713). El año en curso devenga proporcional, pero eso es **trunco** —sirve
para una liquidación, no habilita a pedir días— y por eso no suma al saldo
disponible. Los días no gozados **no caducan**: se acumulan hasta que el
colaborador los tome o se le liquiden.

El saldo no se guarda en ninguna columna: se deriva.

```text
saldo = derecho de años cumplidos
      + ajustes de RR.HH.
      − días gozados antes de la intranet   (vacation_history)
      − solicitudes aprobadas aquí          (vacation_requests)
```

Sólo `approved`, `in_progress` y `completed` descuentan. `pending`, `rejected`
y `cancelled` no tocan el saldo.

### Historial anterior a la intranet

RR.HH. llevaba las vacaciones en Excel. Ese pasado entra como **historial**, no
como solicitudes inventadas: una fila por salida en `vacation_history`, con año,
mes y días. Las fechas exactas son opcionales —el Excel casi nunca las tiene— y
nunca se rellenan con un rango ficticio.

Se carga **a mano, desde la ficha de cada colaborador** («Cargar salidas»): una
tabla de filas mes + días que el servidor revisa mientras se escribe
(`historial/lote/previsualizar`) mostrando a qué período irá cada salida y
cómo queda el saldo. Se guarda todo el lote o nada. No hay importador de Excel:
la planilla de RR.HH. tiene fórmulas con rangos rotos, fechas de ingreso que no
coinciden entre hojas y columnas por período corridas, y leerla automáticamente
arrastraba esos errores.

| Tabla | Qué guarda |
|-------|------------|
| `vacation_history` | Una fila por salida previa. Borrado lógico (`deleted_at`). |
| `vacation_history_audit` | Bitácora: historial, fecha de ingreso/documento y referencias, con el valor anterior. |
| `vacation_reference_balances` | Saldo que RR.HH. tenía anotado a una fecha, para conciliar. |
| `vacation_settings` | Fecha de corte: hasta cuándo mandó el Excel. |
| `vacation_history_imports` | Lotes del importador retirado; se conserva por los datos ya cargados. |

`vacation_periods.historical_used_days` guarda cuántos de esos días cayeron en
cada período. Se calcula **imputando FIFO** (del período más antiguo al más
nuevo) y se reconstruye entero con
`vacationBalanceService.reimputeHistoricalDays(userId)`: el mismo historial
siempre da el mismo saldo, sin importar en qué orden se cargó ni cuántas veces
se corrigió. `ensureHistoryImputed(userId)` lo comprueba con dos `SUM` al abrir
la ficha y sólo reimputa si dejó de cuadrar.

Los registros históricos no validan el fraccionamiento del art. 17: son hechos
ya ocurridos, muchos anteriores al D. Leg. 1405. Las solicitudes nuevas sí.

**Saldo de referencia.** RR.HH. anota el saldo de su planilla a una fecha y la
ficha lo compara con `balanceAt`: años cumplidos × 30 (más ajustes) menos lo
gozado hasta ese mes, la misma cuenta que la hoja «Agendas». Muestra «Cuadra» o
la diferencia; no mueve el saldo.

**Plazo de goce.** Cada período cerrado se debe gozar dentro del año siguiente
(art. 23 D.L. 713). Pasado ese plazo con saldo, la ficha y el resumen lo marcan
como vencido (indemnización). Los días no caducan.

**Fecha de ingreso.** Se corrige desde la ficha con motivo obligatorio. Los
períodos se realinean en su lugar (`planPeriodRealignment`): el k-ésimo año de
servicio sigue siendo el mismo registro, con lo consumido y los ajustes, en vez
de sumarse a los períodos de la fecha anterior.

### Probar el flujo completo

`scripts/demo-vacaciones.js` siembra un elenco ficticio elegido para que cada
caso del módulo se vea en pantalla, con su historial y saldos de referencia.

```bash
npm run demo:pe            # crea 5 colaboradores de prueba
npm run demo:pe:estado     # imprime el saldo de cada uno
npm run demo:pe:limpiar    # borra todo lo que creó
```

| Quién | Qué demuestra |
|-------|---------------|
| Ana Pérez | Mucha antigüedad y casi todo gozado: el caso de la reunión |
| Luis Quispe | 2 años y 3 meses, 60 días; su historial se carga a mano para probar el lote |
| Rosa Ccahuana | Sin historial: estado vacío y saldo completo |
| Jorge Medina | Todavía no cumple el año: solo acumula trunco |
| Elena Vargas | Más historial del que generó: alerta y referencia que no cuadra |

Todo queda marcado —correo `demo.*@demo.invalid`, documentos `9000xxxx`— y
`--limpiar` lo borra entero sin tocar una fila que no haya creado él.

### Rutas de RR.HH.

| Ruta | Qué hace |
|------|----------|
| `/RRHH/vacaciones/gestion/resumen` | Saldo de cada colaborador, liquidación, plazos, referencias y fecha de corte |
| `/RRHH/vacaciones/gestion/:userId` | Ficha: datos del cálculo, carga del historial, referencia, períodos, ajustes |

Las exportaciones usan `services/exports/excelWorkbook.js` (exceljs). Es el
primer exportador del proyecto y vive fuera de vacaciones a propósito: el
siguiente módulo que necesite «descargar en Excel» debe reutilizarlo.

## Roles

| Rol | Acceso |
|-----|--------|
| `Usuario` | Colaborador |
| `Administrador` | Escritura en módulos |
| `Deshabilitado` | Sin login |

Los roles viejos por área (`rrhh`, `marketing`, …) se tratan como administrador. Cualquier usuario activo puede pedir vacaciones; la gestión RRHH es de administrador.

## Rutas

| Prefijo | Módulo |
|---------|--------|
| `/` | Auth, home, Academy, apps, perfil |
| `/procesos` | Documentos internos |
| `/RRHH` | Personal, organigrama, vacaciones |
| `/soporte` | Tickets (Chile) |
| `/marketing` | Eventos |
| `/noticias` | Noticias |
| `/claude` | Asistente (Chile) |

## Entorno (núcleo)

```env
SESSION_SECRET=

DB_HOST=aws-1-us-west-2.pooler.supabase.com
DB_PORT=5432
DB_USER=intranet_chile.dgadjvptxhotjylwsglx
DB_PASSWORD=
DB_NAME=postgres
DB_SSL=true

SUPABASE_URL=https://dgadjvptxhotjylwsglx.supabase.co
SUPABASE_SECRET_KEY=

BREVO_API_KEY=

ANTHROPIC_API_KEY=

LINKEDIN_CLIENT_ID=
LINKEDIN_CLIENT_SECRET=
LINKEDIN_ORG_ID=
LINKEDIN_CALLBACK_URL=
```

`COUNTRY`, puerto, `APP_BASE_URL` y bucket los pone `dev:cl` / `dev:pe` (o el panel en cPanel). El remitente es el `noreply` del país (`noreply@transworld.cl` / `.pe`).

## Estructura

```text
src/           app, rutas, servicios, vistas
supabase/      chile|peru → schema.sql + storage.sql
scripts/       dev.js (lanzador por país)
test/
```

## Jobs al arrancar

Cierre de tickets (1 h, Chile), limpieza de `change_log` (12 h), transiciones de vacaciones (12 h), caché de home —divisas, clima, LinkedIn en Chile— (15 min).
