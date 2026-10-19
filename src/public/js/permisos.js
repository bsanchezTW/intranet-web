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
    var efecto = form.querySelector("[data-perm-effect]");
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

  document.querySelectorAll("form[data-perm-form]").forEach(prepararAsignacion);
  document.querySelectorAll("[data-perm-item]").forEach(prepararItem);
})();
