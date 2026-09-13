document.addEventListener("DOMContentLoaded", async function () {
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('browser-api.js');
  document.head.appendChild(script);
  await new Promise(resolve => { script.onload = resolve; });

  const useDisplayLinesSwitch = document.getElementById('useDisplayLinesSwitch');

  try {
    const data = await window.browserAPI.storage.get(["useDisplayLines"]);
    useDisplayLinesSwitch.checked = data.useDisplayLines ?? false;
  } catch (_) {}

  async function save() {
    const settings = { useDisplayLines: useDisplayLinesSwitch.checked };
    try {
      await window.browserAPI.storage.set(settings);
    } catch (_) {}
  }

  useDisplayLinesSwitch.addEventListener('change', save);
});
