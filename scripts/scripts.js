/*
 * Compass SPA — EDS scripts.js
 *
 * The Compass SPA HTML is authored in DA (index page).
 * EDS renders it into the page, then this script loads app.js
 * which wires up all the interactivity.
 *
 * We disable EDS block decoration since Compass is a SPA.
 */

const LCP_BLOCKS = [];

function buildAutoBlocks() { }
function decorateBlock() { }

async function loadEager(doc) {
  // Remove default EDS header/footer (Compass has its own)
  const header = doc.querySelector('header');
  const footer = doc.querySelector('footer');
  if (header) header.remove();
  if (footer) footer.remove();

  // Unwrap <main> — Compass expects body-level elements
  const main = doc.querySelector('main');
  if (main) {
    const parent = main.parentElement;
    while (main.firstChild) parent.insertBefore(main.firstChild, main);
    main.remove();
  }

  // Load the Compass app CSS
  const css = document.createElement('link');
  css.rel = 'stylesheet';
  css.href = '/styles/app.css';
  document.head.appendChild(css);

  // Load the Compass app module
  const script = document.createElement('script');
  script.type = 'module';
  script.src = '/scripts/app.js';
  document.body.appendChild(script);

  console.log('[Compass] SPA bootstrapped on EDS *.aem.page');
}

async function loadLazy() { }
async function loadDelayed() { }

// Auto-execute on load
loadEager(document).catch(console.error);

export {
  buildAutoBlocks,
  decorateBlock,
  loadLazy,
  loadDelayed,
  loadEager,
  LCP_BLOCKS,
};
