'use strict';
// En modo estricto, `this` dentro de una función normal es undefined.
var estricto = (function () {
  return this === undefined;
})();
