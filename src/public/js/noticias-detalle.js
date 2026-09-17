/* ==========================================================================
   Noticias — detalle: selector de destinatarios y confirmaciones
   ========================================================================== */
(function () {
  "use strict";

  function abrirModal(id) {
    var modal = document.getElementById(id);
    if (!modal) return;
    if (window.IntranetModal) {
      window.IntranetModal.open(id);
    } else {
      modal.classList.add("is-open");
      modal.style.display = "flex";
    }
  }

  function cerrarModal(id) {
    var modal = document.getElementById(id);
    if (!modal) return;
    if (window.IntranetModal) {
      window.IntranetModal.close(id);
    } else {
      modal.classList.remove("is-open");
      modal.style.display = "none";
    }
  }

  /* Quita ?publicada=1 para que recargar no vuelva a abrir el modal. */
  function limpiarParametro(nombre) {
    if (!window.history || !window.history.replaceState) return;
    var url = new URL(window.location.href);
    url.searchParams.delete(nombre);
    window.history.replaceState({}, "", url.pathname + url.search);
  }

  /* Las confirmaciones (destacar, eliminar) van con data-confirm en el <form>
     y las atiende IntranetDialog en modal.js. */

  /* ======================================================================
     Selector de destinatarios
     ====================================================================== */
  function iniciarSelectorCorreo() {
    var form = document.getElementById("form-correo-destinatarios");
    if (!form) return;

    var checkTodos = document.getElementById("correo-enviar-todos");
    var checkVisibles = document.getElementById("correo-seleccionar-visibles");
    var buscador = document.getElementById("correo-buscar");
    var lista = document.getElementById("correo-lista-usuarios");
    var contador = document.getElementById("correo-contador");
    var botonEnviar = document.getElementById("correo-btn-enviar");

    function items() {
      return lista ? Array.prototype.slice.call(lista.querySelectorAll(".correo-item")) : [];
    }

    function visibles() {
      return items().filter(function (item) { return item.style.display !== "none"; });
    }

    function seleccionados() {
      return lista ? lista.querySelectorAll(".correo-usuario-check:checked").length : 0;
    }

    function actualizar() {
      var todos = checkTodos && checkTodos.checked;
      var total = seleccionados();

      if (lista) lista.classList.toggle("is-disabled", todos);
      if (buscador) buscador.disabled = todos;
      if (checkVisibles) checkVisibles.disabled = todos;

      if (contador) {
        contador.textContent = todos
          ? "Se enviará a todos"
          : total + " seleccionado" + (total === 1 ? "" : "s");
      }

      if (botonEnviar) {
        botonEnviar.disabled = !todos && total === 0;
        botonEnviar.textContent = todos ? "Enviar a todos" : "Enviar";
      }

      items().forEach(function (item) {
        var check = item.querySelector(".correo-usuario-check");
        item.classList.toggle("is-selected", Boolean(check && check.checked && !todos));
      });
    }

    function filtrar() {
      var termino = ((buscador && buscador.value) || "").trim().toLowerCase();
      items().forEach(function (item) {
        var texto = item.getAttribute("data-search") || "";
        item.style.display = !termino || texto.indexOf(termino) !== -1 ? "" : "none";
      });
      if (checkVisibles) checkVisibles.checked = false;
      actualizar();
    }

    if (checkTodos) {
      checkTodos.addEventListener("change", function () {
        if (checkTodos.checked && lista) {
          lista.querySelectorAll(".correo-usuario-check").forEach(function (check) {
            check.checked = false;
          });
          if (checkVisibles) checkVisibles.checked = false;
        }
        actualizar();
      });
    }

    if (checkVisibles) {
      checkVisibles.addEventListener("change", function () {
        if (checkTodos && checkTodos.checked) return;
        visibles().forEach(function (item) {
          var check = item.querySelector(".correo-usuario-check");
          if (check) check.checked = checkVisibles.checked;
        });
        actualizar();
      });
    }

    if (buscador) buscador.addEventListener("input", filtrar);

    if (lista) {
      lista.addEventListener("change", function (event) {
        if (!event.target.classList.contains("correo-usuario-check")) return;
        if (checkTodos && checkTodos.checked) checkTodos.checked = false;
        actualizar();
      });
    }

    form.addEventListener("submit", function (event) {
      var todos = checkTodos && checkTodos.checked;
      if (!todos && seleccionados() === 0) {
        event.preventDefault();
        actualizar();
        return;
      }
    });

    window.abrirModalDestinatarios = function () {
      abrirModal("modal-correo-destinatarios");
    };

    actualizar();
  }

  /* ======================================================================
     Flujo posterior a publicar
     ====================================================================== */
  function iniciarPostPublicacion() {
    var flags = window.NoticiaDetalleFlags || {};

    if (flags.publicada && document.getElementById("modal-correo-publicada")) {
      abrirModal("modal-correo-publicada");

      var boton = document.getElementById("btn-elegir-destinatarios");
      if (boton) {
        boton.addEventListener("click", function () {
          cerrarModal("modal-correo-publicada");
          limpiarParametro("publicada");
          abrirModal("modal-correo-destinatarios");
        });
      }

      var modal = document.getElementById("modal-correo-publicada");
      modal.addEventListener("click", function (event) {
        if (event.target.hasAttribute("data-modal-close")) limpiarParametro("publicada");
      });
    }

    if (flags.editar && typeof window.abrirModalEditarNoticia === "function") {
      window.abrirModalEditarNoticia(window.NoticiaDetalleData);
    }
  }

  function iniciar() {
    iniciarSelectorCorreo();
    iniciarPostPublicacion();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", iniciar);
  } else {
    iniciar();
  }
})();
