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

Los cambios de esquema se aplican a mano a partir de `supabase/`; la app no migra al arrancar.

## Seguridad

Si encuentras un problema de seguridad, avísale directamente al equipo de Informática en vez de abrir un issue.
