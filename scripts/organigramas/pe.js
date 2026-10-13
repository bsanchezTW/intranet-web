/**
 * Organigrama de Transworld Perú. Lo carga scripts/cargar-organigrama.js
 * (ver su encabezado para el formato).
 *
 * Perú se armó primero con un área por cargo («Jefe de Finanzas», «Asistente
 * Logístico I»…). Aquí pasa a trabajar como Chile: un área por departamento,
 * con su jefe, y las personas como miembros. Cada área de cargo con jefe se
 * renombra a su departamento (conserva id, color y documentos) y los cargos
 * que colgaban de ella se eliminan: su gente pasa al departamento.
 */

const arbol = {
  area: "Gerencia",
  antes: "Country Manager Perú",
  jefe: "Gustavo Valenzuela",
  // Quienes estaban en «Country Manager Perú» sin departamento conocido
  // (Daniel Zavala, Jonathan Sehuincho, Meudy Marcano, Miriam Pio, Antony
  // Gonzales, Katy Soria y Gianella Villanueva) siguen en Gerencia hasta que
  // se sepa su departamento: basta agregarlos a la hija que corresponda.
  miembros: [],
  hijas: [
    {
      area: "Finanzas",
      antes: "Jefe de Finanzas",
      jefe: "Freddy Payano",
      miembros: ["Vilma Martos", "Astrid Ortiz", "Harold Ramos"],
    },
    {
      area: "Comercial",
      antes: "Sales Leader",
      jefe: "Ramon Cerna",
      miembros: ["Javier Ruiz", "Hesel López", "Melissa Villavicencio"],
    },
    {
      // Sin jefe por ahora: sus solicitudes las aprueba Gerencia.
      area: "Proyectos de Seguridad",
      antes: "Project Leader Seguridad",
      jefe: null,
      miembros: [],
    },
    {
      area: "Administración",
      antes: "Administradora",
      jefe: "Patricia Portillo",
      miembros: ["Rocio Rivera"],
    },
    {
      area: "Marketing y Comex",
      antes: "Supervisor MKTG / COMEX",
      jefe: null,
      miembros: [],
    },
    {
      area: "Logística",
      antes: "Coordinador Logístico",
      jefe: "Santiago Quispe",
      miembros: ["Jean Lara", "Juan Cotrina", "Miguel Armaulia"],
    },
    {
      area: "Informática",
      jefe: "Bastián Sánchez",
      miembros: [],
    },
  ],
};

// Cargos que colgaban de un área de cargo: su gente ya quedó en el
// departamento de arriba.
const eliminar = [
  "Asistente Contable · Facturación y Cobranza",
  "Asistente Contable · Pagos y Bancos",
  "Ejecutivo Comercial · Telecomunicaciones I",
  "Ejecutivo Comercial · Telecomunicaciones II",
  "Ejecutivo Comercial · Telecomunicaciones III",
  "KAM Conectividad",
  "KAM Electricidad",
  "PM Conectividad",
  "PM Equipamiento Activo",
  "Asistente Logístico I",
  "Asistente Logístico II",
  "Servicio General",
];

module.exports = { pais: "PE", arbol, eliminar };
