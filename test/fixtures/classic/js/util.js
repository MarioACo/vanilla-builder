(function () {
  // Si los archivos se unieran sin separador, esto llamaría al objeto MiniLib y fallaría.
  window.__iife = true;
})()

function sumar(a, b) {
  return a + b;
}

function saludar(nombre) {
  document.getElementById('titulo').textContent = 'Hola ' + nombre;
  return nombre;
}

var contador = 0
contador = contador + 1
