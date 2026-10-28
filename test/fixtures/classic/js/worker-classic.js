importScripts('worker-helper.js');

onmessage = function (e) {
  postMessage(ayudar(e.data));
};
