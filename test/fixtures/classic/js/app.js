// Declaración léxica global compartida con app2.js
let appState = { listo: true, doble: MiniLib.doble(21) };

class Contador {
  #valor = 0;
  sumar() {
    this.#valor += 1;
    return this.#valor;
  }
}

const elContador = new Contador();
elContador.sumar();
