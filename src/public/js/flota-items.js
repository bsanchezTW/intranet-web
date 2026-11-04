/**
 * Configurar ítems: al abrir "renombrar" o "editar" se enfoca su campo y se
 * cierra el que estaba abierto; Escape lo cierra. Sin JS los formularios
 * funcionan igual (son <details> nativos).
 */
(function () {
  const editores = [...document.querySelectorAll(".cfg-editar")];
  if (!editores.length) return;

  editores.forEach((d) => {
    d.addEventListener("toggle", () => {
      if (!d.open) return;
      editores.forEach((otro) => { if (otro !== d) otro.open = false; });
      const campo = d.querySelector('input[type="text"]');
      if (campo) {
        campo.focus();
        campo.select();
      }
    });
  });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const abierto = editores.find((d) => d.open);
    if (abierto) {
      abierto.open = false;
      abierto.querySelector("summary").focus();
    }
  });

  // Al volver de guardar, marca un momento la categoría tocada.
  const destino = window.location.hash && document.querySelector(window.location.hash);
  if (destino && destino.classList.contains("cfg-categoria")) {
    destino.classList.add("is-reciente");
    setTimeout(() => destino.classList.remove("is-reciente"), 1600);
  }
})();
