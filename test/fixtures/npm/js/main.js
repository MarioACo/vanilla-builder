import { libFn, contador } from 'fake-lib';
import { extra } from 'fake-lib/extra.js';

function calcularResultadosDeLaPagina() {
  return {
    lib: libFn(),
    extra: extra(),
    // Si helper.js quedara duplicado (dos instancias), este número no sería 3.
    compartido: contador(),
    clasico: window.resultadoClasico,
    mini: Mini.sumar(1, 1),
  };
}

window.__results = calcularResultadosDeLaPagina();
window.__done = true;
