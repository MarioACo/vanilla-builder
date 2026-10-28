async function recogerResultados() {
  const caja = document.querySelector('.inline-box');
  const titulo = document.getElementById('titulo');
  const css = getComputedStyle(caja);
  document.getElementById('btn').click();
  const worker = new Worker('js/worker-classic.js');
  const respuestaWorker = await new Promise(function (resolve) {
    worker.onmessage = function (e) {
      resolve(e.data);
    };
    worker.postMessage('hola');
  });
  const datos = await fetch('data/config.json').then(function (r) {
    return r.json();
  });
  const foto = document.getElementById('foto');
  await new Promise(function (resolve) {
    if (foto.complete) resolve();
    else foto.onload = foto.onerror = resolve;
  });
  window.__results = {
    inlineOk: window.__inlineOk,
    iife: window.__iife,
    estricto: estricto,
    currentScript: window.__currentScript,
    lexicalShared: appState.listo === true,
    doble: appState.doble,
    contador: contador,
    contadorPrivado: elContador.sumar(),
    cierre: cierre,
    styleAttr: css.color,
    inlineStyleBg: css.backgroundImage,
    imageSet: css.backgroundImage.length > 0,
    padding: css.padding,
    bodyBg: getComputedStyle(document.body).backgroundColor,
    importedColor: getComputedStyle(titulo).color,
    importedBg: getComputedStyle(titulo).backgroundImage,
    titulo: titulo.innerText,
    pre: document.getElementById('pre').textContent,
    worker: respuestaWorker,
    json: datos,
    jsonGrande: JSON.stringify(datos),
    foto: foto.naturalWidth,
    tplImg: document.getElementById('tpl').content.querySelector('img').getAttribute('src'),
    ldjson: JSON.parse(document.querySelector('script[type="application/ld+json"]').textContent).name,
    nbsp: document.querySelector('.inline-box').textContent.indexOf(' ') !== -1,
  };
  window.__done = true;
}

if (document.readyState === 'complete') recogerResultados();
else window.addEventListener('load', recogerResultados);
