/*
 * Compass SPA — EDS entry point
 *
 * This is loaded by aem.js as the site's scripts.js.
 * It disables EDS block decoration (Compass is a SPA, not a content site)
 * and bootstraps the Compass app from app.js in the repo root.
 */

// Skip EDS decoration — Compass manages its own DOM
const LCP_BLOCKS = [];

function buildAutoBlocks() { /* no-op — Compass is a SPA */ }

function decorateBlock() { /* no-op */ }

async function loadLazy() { /* no-op */ }

async function loadDelayed() { /* no-op */ }

// Bootstrap Compass SPA
async function loadEager(doc) {
  // Import the Compass app module
  await import('../app.js');
}

export {
  buildAutoBlocks,
  decorateBlock,
  loadLazy,
  loadDelayed,
  loadEager,
  LCP_BLOCKS,
};
