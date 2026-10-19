/* Gestión de Permisos: muestra en cada formulario sólo los campos que aplican.
   - Asignación (form[data-perm-form]): persona / área / jefes / todos,
     conjunto o permiso suelto, alcances que admite el permiso elegido y la
     lista de áreas cuando el alcance es «Áreas elegidas». Denegar no lleva
     alcance: quita el permiso entero.
   - Editor de conjunto ([data-perm-item]): la lista de áreas aparece al
     marcar «Áreas elegidas».
   Lo oculto se deshabilita para que no viaje en el formulario. */
(function () {
  "use strict";

  function ocultar(el, si) {
    if (!el) return;
    if (si) el.setAttribute("data-perm-hide", "");
    else el.removeAttribute("data-perm-hide");
    el.querySelectorAll("select, input").forEach(function (campo) {
      campo.disabled = si;
    });
  }

  function alcancesDe(form, objetivo) {
    if (objetivo !== "key") return [];
    var selector = form.querySelector("[data-perm-key]");
    var fuente = selector
      ? selector.options[selector.selectedIndex]
      : form.querySelector("input[name='permission_key'][data-perm-scopes]");
    var lista = fuente ? fuente.getAttribute("data-perm-scopes") || "" : "";
    return lista ? lista.split(",") : [];
  }

  function prepararAsignacion(form) {
    var principal = form.querySelector("[data-perm-principal]");
    var principalFijo = form.querySelector("input[type='hidden'][name='principal_type']");
    var objetivo = form.querySelector("[data-perm-target]");
    var campoAlcance = form.querySelector("[data-perm-scope-field]");
    var alcance = form.querySelector("[data-perm-scope]");
    var campoAreas = form.querySelector("[data-perm-areas-field]");
    var areaSelect = form.querySelector("select[name='area_id']");

    function actualizar() {
      var quien = principal ? principal.value : principalFijo ? principalFijo.value : "";
      form.querySelectorAll("[data-perm-show]").forEach(function (el) {
        ocultar(el, el.getAttribute("data-perm-show").split(" ").indexOf(quien) === -1);
      });

      // «Cualquier área» sólo tiene sentido para los jefes.
      if (areaSelect) {
        var cualquiera = areaSelect.querySelector("[data-perm-only='jefes']");
        if (cualquiera) {
          cualquiera.hidden = quien !== "jefes";
          cualquiera.disabled = quien !== "jefes";
          if (quien !== "jefes" && areaSelect.value === "" && areaSelect.options.length > 1) {
            areaSelect.selectedIndex = 1;
          }
        }
      }

      var que = objetivo ? objetivo.value : "key";
      form.querySelectorAll("[data-perm-show-target]").forEach(function (el) {
        ocultar(el, el.getAttribute("data-perm-show-target") !== que);
      });

      var permitidos = alcancesDe(form, que);
      // Conceder / Denegar son radios; antes era un select.
      var efecto = form.querySelector("[data-perm-effect]:checked") || form.querySelector("select[data-perm-effect]");
      var deniega = efecto && efecto.value === "deniega";
      ocultar(campoAlcance, !permitidos.length || deniega);
      if (alcance) {
        Array.prototype.forEach.call(alcance.options, function (op) {
          var vale = permitidos.indexOf(op.value) !== -1;
          op.hidden = !vale;
          op.disabled = !vale;
        });
        if (permitidos.length && permitidos.indexOf(alcance.value) === -1) alcance.value = permitidos[0];
      }
      ocultar(campoAreas, !permitidos.length || deniega || !alcance || alcance.value !== "areas");
    }

    form.addEventListener("change", actualizar);
    actualizar();
  }

  function prepararItem(item) {
    var marcaAreas = item.querySelector("input[type='checkbox'][value='areas']");
    var areas = item.querySelector("[data-perm-item-areas]");
    if (!marcaAreas || !areas) return;
    function actualizar() {
      ocultar(areas, !marcaAreas.checked);
    }
    marcaAreas.addEventListener("change", actualizar);
    actualizar();
  }

  /* Ficha de persona: filtra los permisos efectivos por texto y por «sólo lo
     que tiene». Un módulo sin filas visibles se esconde entero. */
  function prepararFiltro(caja) {
    var destino = document.querySelector(caja.getAttribute("data-perm-filtro"));
    if (!destino) return;
    var texto = caja.querySelector("input[type='search']");
    var soloTiene = caja.querySelector("input[type='checkbox']");
    var vacio = destino.querySelector("[data-perm-filtro-vacio]");

    function normalizar(s) {
      return String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
    }

    function actualizar() {
      var q = normalizar(texto && texto.value).trim();
      var solo = Boolean(soloTiene && soloTiene.checked);
      var algunModulo = false;
      destino.querySelectorAll("[data-perm-modulo]").forEach(function (modulo) {
        var visibles = 0;
        modulo.querySelectorAll("[data-perm-fila]").forEach(function (fila) {
          var pasa = (!q || normalizar(fila.getAttribute("data-perm-fila")).indexOf(q) !== -1)
            && (!solo || fila.hasAttribute("data-perm-tiene"));
          fila.hidden = !pasa;
          if (pasa) visibles++;
        });
        modulo.hidden = visibles === 0;
        if (visibles && q) modulo.open = true;
        if (visibles) algunModulo = true;
      });
      if (vacio) vacio.hidden = algunModulo;
    }

    caja.addEventListener("input", actualizar);
    caja.addEventListener("change", actualizar);
    actualizar();
  }

  /* Editar una asignación: «Editar» y «Cancelar» abren y cierran su formulario. */
  document.addEventListener("click", function (ev) {
    var boton = ev.target.closest("[data-perm-toggle]");
    if (!boton) return;
    var id = boton.getAttribute("data-perm-toggle");
    var form = document.getElementById(id);
    if (!form) return;
    form.hidden = !form.hidden;
    document.querySelectorAll("[data-perm-toggle='" + id + "'][aria-expanded]").forEach(function (b) {
      b.setAttribute("aria-expanded", String(!form.hidden));
    });
    if (!form.hidden) {
      var primero = form.querySelector("select, input:not([type='hidden'])");
      if (primero) primero.focus();
    }
  });

  // En el editor, la lista de áreas sólo con «Áreas elegidas».
  function prepararEdicion(form) {
    var alcance = form.querySelector("[data-perm-ed-scope]");
    var areas = form.querySelector("[data-perm-ed-areas]");
    if (!alcance || !areas) return;
    function actualizar() {
      ocultar(areas, alcance.value !== "areas");
    }
    alcance.addEventListener("change", actualizar);
    actualizar();
  }

  function normalizarTexto(s) {
    return String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  }

  // Buscar persona dentro de la lista de quienes tienen un permiso.
  function prepararBuscarLista(input) {
    var lista = document.querySelector(input.getAttribute("data-perm-buscar-lista"));
    if (!lista) return;
    input.addEventListener("input", function () {
      var q = normalizarTexto(input.value).trim();
      lista.querySelectorAll("[data-perm-texto]").forEach(function (fila) {
        fila.hidden = Boolean(q) && normalizarTexto(fila.getAttribute("data-perm-texto")).indexOf(q) === -1;
      });
    });
  }

  /* Organigrama: un área se ve si ella, su jefe o alguien de ella coincide, y
     entonces también se ven las áreas de arriba para no perder la rama. */
  function prepararBuscarOrg(input) {
    var arbol = document.querySelector(input.getAttribute("data-perm-buscar-org"));
    if (!arbol) return;
    var nodos = arbol.querySelectorAll(".perm-org__nodo");
    input.addEventListener("input", function () {
      var q = normalizarTexto(input.value).trim();
      nodos.forEach(function (n) { n.hidden = Boolean(q); });
      if (!q) return;
      nodos.forEach(function (n) {
        var propio = n.querySelector(":scope > .perm-org__area");
        // Busca también entre las personas que la tarjeta no alcanza a mostrar.
        var texto = propio ? propio.textContent + " " + (propio.getAttribute("data-perm-buscar-texto") || "") : "";
        if (!propio || normalizarTexto(texto).indexOf(q) === -1) return;
        for (var el = n; el && el !== arbol; el = el.parentElement) {
          if (el.classList && el.classList.contains("perm-org__nodo")) el.hidden = false;
        }
        n.querySelectorAll(".perm-org__nodo").forEach(function (d) { d.hidden = false; });
      });
    });
  }

  document.querySelectorAll("form[data-perm-form]").forEach(prepararAsignacion);
  document.querySelectorAll("[data-perm-item]").forEach(prepararItem);
  document.querySelectorAll("[data-perm-filtro]").forEach(prepararFiltro);
  document.querySelectorAll("form[data-perm-edit]").forEach(prepararEdicion);
  document.querySelectorAll("[data-perm-buscar-lista]").forEach(prepararBuscarLista);
  document.querySelectorAll("[data-perm-buscar-org]").forEach(prepararBuscarOrg);
})();
