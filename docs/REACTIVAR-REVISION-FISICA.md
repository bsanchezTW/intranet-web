# Reactivar la revisión física y los daños (Logística)

Estado: **deshabilitada por completo desde 2026-11-10**. Sin interruptores: el código
está comentado y las dependencias cortadas. Los **checklist (revisión mecánica) siguen activos**.

Las tablas `vehicle_physical_reviews`, `vehicle_damages` y `vehicle_damage_photos`
(y sus fotos en el storage) **no se tocaron**: los datos están intactos.

## Cómo se comentó

| Tipo de archivo | Marca | Cómo deshacerlo |
| --- | --- | --- |
| Archivo completo `.js` | cada línea empieza con `//~ ` y la 1.ª línea es `// REVISIÓN FÍSICA DESHABILITADA…` | quitar la 1.ª línea y el prefijo `//~ ` |
| Archivo completo `.ejs` | `<%# REVISIÓN FÍSICA DESHABILITADA … %>` envolviendo todo; dentro, `%>` → `%_>` y `<%` → `<_%` | quitar el envoltorio y revertir `%_>` → `%>` y `<_%` → `<%` |
| Trozos dentro de archivos activos | líneas con `//~ ` (JS) o bloques `<%# REVISIÓN FÍSICA DESHABILITADA … %>` (EJS) | igual que arriba |
| SQL en `vehicleService.js` | bloques `/*~ … ~*/` | descomentar (ver notas) |

Para buscar todo lo deshabilitado:

```bash
grep -rn "REVISIÓN FÍSICA DESHABILITADA\|//~ \|/\*~" src test docs
```

## 1. Archivos enteros comentados (revertir con el script de abajo)

Servicios y constantes
- `src/services/logistics/physicalService.js`
- `src/services/logistics/physicalPdf.js`
- `src/services/logistics/damagePhotos.js`
- `src/constants/vehiclePhysical.js`
- `src/constants/vehicleZones.js`

Cliente
- `src/public/js/flota-fisica.js`, `flota-modelo.js`, `flota-fotos.js`

Vistas
- `src/views/logistica/flota/fisica.ejs`
- `src/views/logistica/flota/fisica/detalle.ejs`
- `src/views/logistica/flota/danio.ejs`
- `src/views/logistica/flota/partials/danios_lista.ejs`

Tests
- `test/vehicle-physical.test.js`, `test/vehicle-zones.test.js`

## 2. Trozos comentados dentro de archivos activos

- `src/routes/logistica.js`
  - `require` de `os`, `fs/promises`, `multer`, `physicalService`, `damagePhotos`, `physicalPdf`, `vehiclePhysical`, `vehicleZones`.
  - Constantes `FISICA`, `DANIOS`, `FOTOS` y sus entradas en `VIEW_HELPERS`.
  - Constantes de permisos `VER_FISICA`, `CREAR_FISICA`, `ANULAR_FISICA`, `REPARAR`; `fisicaScope`, `puedeVerFisica`, `puedeVerDanio`.
  - En `permisosFlota`: las claves `puedeRevisarFisica`, `puedeVerFisicas`, `puedeVerDanios`, `puedeReparar`.
  - **`accesoFlota`**: volver a `requireAnyPermission(VER_FLOTA, VER, CREAR, VER_FISICA, CREAR_FISICA, REPARAR)`.
  - **`puedeVerRevisiones`**: volver a `can(VER) || can(CREAR) || can(VER_FISICA) || can(CREAR_FISICA) || can(REPARAR)`.
  - `HISTORIAL_TABS`: restaurar `"fisicas"` y `"danios"`; en el filtro `visibles`, `tab === "danios" ? permisos.puedeVerDanios : …`.
  - En `GET /flota/:id/revisiones`: restaurar `fisicas` y `danios` en el `Promise.all`, en `datos` y en el render `parcial`.
  - Toda la sección «Revisión física y daños» (subida de fotos, `GET/POST /flota/:id/revision-fisica`, `/flota/fisica/*`, `/flota/danios/*`, `/flota/fotos/:id`).
- `src/services/permissions/catalog/logistica.js`: las 4 claves `logistica.fisica.ver|crear|anular` y `logistica.danio.reparar`.
  Al reactivarlas reaparecen en Gestión de permisos (nadie las tendrá asignadas hasta que se vuelvan a dar; las asignaciones antiguas en la BD siguen guardadas).
- `src/services/logistics/vehicleService.js`
  - `listVehicles`: subconsultas `last_physical_date` y `open_damages` (poner la coma tras `checklists_count`).
  - `listKmReadings`: el `UNION ALL` de `vehicle_physical_reviews`.
- `src/views/logistica/flota/index.ejs`: variables `fisicaPendiente`, `daniosAbiertos`, `avisoFisica`, `abiertos`; columnas «Revisión física» y «Daños» de la tarjeta; botón «Revisión física»; contadores del resumen; aviso de «tipo sin definir».
- `src/views/logistica/flota/revisiones.ejs`: variables de daños, pestañas `fisicas` y `danios` (TABS y cuerpo), botón del encabezado, ramas `fisica` en `filasRevision`, `FUENTES.fisica` y la fila de origen física en la tabla de kilometraje.
- `src/views/logistica/flota/partials/revisiones_listas.ejs`: lista «Físicas» y aviso de daños abiertos.
- Texto de la tarjeta Logística en `src/views/procesos/index.ejs` y de `index.ejs` de flota: vuelven a mencionar la revisión física.

Las ramas `filasRevision` de `revisiones.ejs` (enlace, fecha, estado, detalle) se simplificaron a sólo mecánica; el
código original está en `git log -p -- src/views/logistica/flota/revisiones.ejs`.

## 3. Script para revertir los archivos enteros

Guárdalo fuera del repo y ejecútalo desde la raíz (`node revertir.js <archivos>`):

```js
const fs = require("fs");
for (const f of process.argv.slice(2)) {
  let s = fs.readFileSync(f, "utf8");
  if (f.endsWith(".ejs")) {
    s = s.replace(/^<%# REVISIÓN FÍSICA DESHABILITADA[^\n]*\n/, "").replace(/\n%>\n$/, "\n")
         .replace(/%_>/g, "%>").replace(/<_%/g, "<%");
  } else {
    s = s.split("\n").slice(1).map((l) => l.replace(/^\/\/~ ?/, "")).join("\n");
  }
  fs.writeFileSync(f, s);
}
```

## 4. Después de reactivar

1. `COUNTRY=CL node --test test/*.test.js` (los tests de física vuelven a correr).
2. Entrar a Gestión de permisos y reasignar `logistica.fisica.*` / `logistica.danio.reparar`.
3. Verificar en `/logistica/flota`: botón «Revisión física», pestañas Físicas y Daños en el historial, PDF y fotos.
