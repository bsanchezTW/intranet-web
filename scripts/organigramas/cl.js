/**
 * Organigrama oficial de Transworld Chile. Lo carga scripts/cargar-organigrama.js
 * (ver su encabezado para el formato).
 */

const arbol = {
  area: "Gerencia",
  jefe: "Luciano Fernández",
  miembros: [
    "Teresa Garretón",
    // Asesores y prevención de riesgos: dependen de la gerencia sin área propia.
    "Miguel Salcedo",
    "Fernando Abud",
    "Marcelo Quijada",
  ],
  hijas: [
    {
      area: "Finanzas",
      jefe: "Pablo Soto",
      miembros: ["Fernanda Contreras"],
      hijas: [
        {
          // Tesorería y RRHH. El nombre se mantiene: es el que habilita la
          // Administración de RRHH a sus administradores.
          area: "Recursos Humanos",
          jefe: "Marcela Manzano",
          miembros: [
            "Francisco Aguilera",
            "María Marcatinco",
            "Claudia Valderrama",
            "Elizabeth Nuñez",
          ],
        },
        {
          area: "Contabilidad",
          jefe: "Paula Serrano",
          miembros: ["Eduardo Zamora", "Nicolás Flores", "Javier Poveda", "Jessica Ibaceta"],
        },
        {
          area: "Logística",
          jefe: "Loreto Carvallo",
          miembros: [],
          hijas: [
            {
              area: "Bodega",
              jefe: "Carlos Fuentes",
              miembros: [
                "Angelo Molina",
                "Ricardo Pérez",
                "Freddy Panicide",
                "Gino Moyano",
                "Richard Gómez",
                "Marco Cartes",
                "Carlos Becerra",
                "Alejandro Meneses",
                "Henry González",
              ],
            },
            {
              area: "Operaciones Logísticas",
              antes: "Operaciones y Facturación",
              jefe: "Corina Pino",
              miembros: [],
            },
          ],
        },
        {
          area: "Informática",
          jefe: "Sebastián Quiroga",
          miembros: ["Bastián Sánchez"],
        },
        {
          area: "Control y Gestión",
          jefe: "Rubén Haro",
          miembros: ["Sofía Garrido"],
        },
      ],
    },
    {
      area: "Eléctrica",
      jefe: "Jorge De Geyter",
      miembros: ["Alexander Medina", "Santiago Lozada"],
    },
    {
      area: "Comercial",
      jefe: "Vicente Fernández",
      miembros: [],
      hijas: [
        {
          area: "Infraestructura",
          jefe: "Leonardo Muñoz",
          miembros: [],
        },
        {
          area: "Cableado y Conectividad",
          jefe: "Sandra Dittmar",
          miembros: ["Luis Torres", "Cristofer Velásquez", "Rosa Valdés"],
        },
        {
          area: "Ventas",
          jefe: "Ledwin Pacheco",
          miembros: [
            "Alan Cerda",
            "Andrés Freire",
            "Hernán Sánchez",
            "Hernán Avendaño",
            "Nicolás González",
            "Marisol Martel",
            "Angelo Crisóstomo",
            "Michel Azoaje",
          ],
        },
        {
          area: "Tecnología",
          jefe: "Williams Araya",
          miembros: ["Javier Salgado", "Álvaro Alzola", "Ignacio Catalán"],
        },
        {
          area: "Marketing",
          jefe: "Erick Novoa",
          miembros: ["Fermín Varas", "Felipe Reyes"],
        },
      ],
    },
    {
      area: "Seguridad Industrial",
      jefe: "Andrea Fernández",
      miembros: ["Fausto Tanzella", "Sergio Temperoni"],
    },
  ],
};

module.exports = { pais: "CL", arbol, eliminar: [] };
