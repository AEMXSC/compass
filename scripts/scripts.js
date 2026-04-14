/*
 * Compass — EDS Bootstrap (scripts.js)
 *
 * Architecture:
 * 1. EDS serves DA content (minimal — just an Experience Workspace block table)
 * 2. This script fetches the Compass SPA shell HTML from /scripts/compass-shell.html
 * 3. Replaces the page body with the SPA shell
 * 4. Loads app.css and app.js which wire up all interactivity
 *
 * This pattern lets the SPA HTML stay version-controlled in the code repo
 * while DA content acts as the page trigger. Auth works natively on *.aem.page
 * because imslib's darkalley redirect_uri includes aem.page origins.
 */

async function bootstrap() {
  try {
    // Fetch the SPA shell HTML from the code bus
    const resp = await fetch('/scripts/compass-shell.html');
    if (!resp.ok) throw new Error(`Shell fetch failed: ${resp.status}`);
    const shellHTML = await resp.text();

    // Replace body content with the SPA shell
    document.body.innerHTML = shellHTML;

    // CSS: app.css is already loaded via styles.css @import (from head.html)
    // No need to inject a second <link> — would cause duplicate CSS load.

    // Load external libraries (PDF.js, Mammoth) — same as index.html
    const pdfScript = document.createElement('script');
    pdfScript.async = true;
    pdfScript.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
    pdfScript.integrity = 'sha384-/1qUCSGwTur9vjf/z9lmu/eCUYbpOTgSjmpbMQZ1/CtX2v/WcAIKqRv+U1DUCG6e';
    pdfScript.crossOrigin = 'anonymous';
    pdfScript.onload = () => {
      if (window.pdfjsLib) {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
      }
    };
    document.body.appendChild(pdfScript);

    const mammothScript = document.createElement('script');
    mammothScript.async = true;
    mammothScript.src = 'https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js';
    mammothScript.integrity = 'sha384-nFoSjZIoH3CCp8W639jJyQkuPHinJ2NHe7on1xvlUA7SuGfJAfvMldrsoAVm6ECz';
    mammothScript.crossOrigin = 'anonymous';
    document.body.appendChild(mammothScript);

    // Load the Compass app module
    const appScript = document.createElement('script');
    appScript.type = 'module';
    appScript.src = '/scripts/app.js';
    document.body.appendChild(appScript);

    console.log('[Compass] SPA shell loaded, app.js bootstrapping on EDS');
  } catch (err) {
    console.error('[Compass] Bootstrap failed:', err);
    document.body.innerHTML = `
      <div style="font-family:system-ui;color:#e34850;display:flex;align-items:center;justify-content:center;height:100vh;background:#1a1a1a">
        <div style="text-align:center">
          <h2>Compass failed to load</h2>
          <p style="color:#888">${err.message}</p>
        </div>
      </div>`;
  }
}

// Auto-execute after DOM is ready (ensures aem.js has finished decorating)
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap);
} else {
  bootstrap();
}
