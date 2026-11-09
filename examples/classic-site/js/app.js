// Uses the global from state.js and the third-party MiniTabs library.
function updateClicks() {
  document.getElementById('clicks').textContent = String(appState.increment());
}

document.getElementById('counter').addEventListener('click', updateClicks);
MiniTabs.init();
