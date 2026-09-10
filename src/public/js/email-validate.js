(function (global) {
  const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i;
  const ERROR_MSG = "Correo incorrecto";

  function isValidEmail(email) {
    return EMAIL_PATTERN.test(String(email || "").trim());
  }

  function initField(input) {
    if (!input) return null;

    function sync() {
      const value = input.value.trim();
      input.setCustomValidity(
        value && !isValidEmail(value) ? ERROR_MSG : "",
      );
    }

    input.addEventListener("input", sync);
    input.addEventListener("blur", sync);
    return input;
  }

  function isEmpty(input) {
    return !String(input?.value || "").trim();
  }

  function isValid(input) {
    const value = String(input?.value || "").trim();
    return !value || isValidEmail(value);
  }

  global.EmailValidate = {
    initField,
    isEmpty,
    isValid,
    isValidEmail,
    ERROR_MSG,
  };
})(window);
