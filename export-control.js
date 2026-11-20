function connectBatchExport(button) {
  function update(label) {
    button.disabled = false;
    button.textContent = label ? 'Download Excel · ' + label : 'Excel downloads';
  }
  chrome.storage.local.get('diwanExportLabel').then(data => update(data.diwanExportLabel));
  chrome.storage.onChanged.addListener((changes,area) => {
    if (area === 'local' && changes.diwanExportLabel) update(changes.diwanExportLabel.newValue);
  });
  button.addEventListener('click', async () => {
    try {
      const result = await chrome.runtime.sendMessage({action:'EXPORT_DIWAN'});
      if (!result?.ok) throw new Error(result?.error || 'Refresh the Myntra tab and try again.');
    } catch (error) { button.textContent = 'Excel: '+error.message; }
  });
}
