// background.js

// Listen for messages from popup/content script
browser.runtime.onMessage.addListener(async (message, sender) => {
  try {
    if (message && message.action === "downloadUrl") {
      // For normal http(s) or data: URLs, ask browser to download directly
      const { url, filename, saveAs = true } = message;
      const downloadOptions = { url, filename, saveAs };
      const id = await browser.downloads.download(downloadOptions);
      return { success: true, id };
    }

    if (message && message.action === "downloadBlob") {
      // The content script sends a Blob (structured-cloneable)
      // Create object URL in the background context and trigger download
      const { blob, filename, saveAs = true } = message;
      const extUrl = URL.createObjectURL(blob);
      try {
        const id = await browser.downloads.download({ url: extUrl, filename, saveAs });
        // release object URL after a short delay (gives download time to start)
        setTimeout(() => URL.revokeObjectURL(extUrl), 10000);
        return { success: true, id };
      } catch (err) {
        URL.revokeObjectURL(extUrl);
        throw err;
      }
    }
  } catch (err) {
    console.error("background error:", err);
    return { success: false, error: String(err) };
  }
});

