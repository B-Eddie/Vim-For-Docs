document.addEventListener("DOMContentLoaded", async function () {
  // Load the browser API manager
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('browser-api.js');
  document.head.appendChild(script);

  const enableExtensionCheckbox = document.getElementById("switch1");
  const lineNumbersCheckbox = document.getElementById("lineNumbersSwitch");
  const themeDropdown = document.getElementById("dropdown");

  // List of available themes (could be extended later)
  const themes = [
    { value: "default", name: "Default" },
    { value: "vim", name: "Vim" },
  ];

  // Populate theme dropdown dynamically
  function populateThemeDropdown() {
    themeDropdown.innerHTML = "";
    themes.forEach((theme) => {
      let option = document.createElement("option");
      option.value = theme.value;
      option.textContent = theme.name;
      themeDropdown.appendChild(option);
    });
  }

  // Open the Motions Editor in a new tab (no tabs permission needed)
  const motionsBtn = document.getElementById('openMotionsEditor');
  if (motionsBtn) {
    motionsBtn.addEventListener('click', () => {
      const url = chrome.runtime.getURL('ui/motions.html');
      window.open(url, '_blank');
    });
  }
  populateThemeDropdown();

  // Wait for browser API script to load
  await new Promise(resolve => {
    script.onload = resolve;
  });

  // Load stored settings from browser storage
  try {
    const data = await window.browserAPI.storage.get(["enabled", "theme", "lineNumbersEnabled", "hideA11yWarning"]);
    enableExtensionCheckbox.checked = data.enabled ?? true;
    lineNumbersCheckbox.checked = data.lineNumbersEnabled ?? true;
    themeDropdown.value = data.theme ?? "default";
    
    // Show accessibility warning if not dismissed
    const a11yWarning = document.getElementById('a11yWarning');
    if (a11yWarning && !data.hideA11yWarning) {
      a11yWarning.style.display = 'block';
    }
  } catch (_) {}
  
  // Handle dismissing the accessibility warning
  const dismissBtn = document.getElementById('dismissA11yWarning');
  if (dismissBtn) {
    dismissBtn.addEventListener('click', async () => {
      try {
        await window.browserAPI.storage.set({ hideA11yWarning: true });
        const a11yWarning = document.getElementById('a11yWarning');
        if (a11yWarning) a11yWarning.style.display = 'none';
      } catch (_) {}
    });
  }

  // Save settings to browser storage when changed
  async function saveSettings() {
    const settings = {
      enabled: enableExtensionCheckbox.checked,
      lineNumbersEnabled: lineNumbersCheckbox.checked,
      theme: themeDropdown.value,
    };

    try {
      await window.browserAPI.storage.set(settings);
    } catch (_) {}
  }

  enableExtensionCheckbox.addEventListener("change", saveSettings);
  lineNumbersCheckbox.addEventListener("change", saveSettings);
  themeDropdown.addEventListener("change", saveSettings);

});
