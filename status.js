/**
 * status.js — Isolated-world content script
 *
 * Runs alongside apply.js but in the ISOLATED world (no access to page JS).
 * Its only job is to watch the DOM for the #fcevo panel that apply.js creates,
 * and report health state to the background service worker so the popup and
 * badge stay accurate.
 *
 * Drop in a new apply.js at any time — this file never needs to change.
 */

const STATUS_INTERVAL_MS = 1000; // poll frequency
const PANEL_ID = "fcevo";        // the id apply.js gives its root element

let lastState = null;

function detectState() {
  const panel = document.getElementById(PANEL_ID);
  // Match any variant of the EA ultimate-team web app URL
  // e.g. /ea-sports-fc/ultimate-team/web-app/ or /en-us/ultimate-team/web-app/
  const onEAPage = /ultimate-team\/web-app/.test(window.location.href);

  // apply.js sets window.FCEvo once it boots. We can't read window props from
  // the isolated world, but the #fcevo DOM element is enough of a signal.
  return {
    panelFound: !!panel,
    panelVisible: panel ? panel.style.display !== "none" : false,
    onEAPage,
    url: window.location.href,
    ts: Date.now(),
  };
}

function report(state) {
  chrome.runtime.sendMessage({ type: "FCEVO_STATUS", ...state }).catch(() => {
    // Extension context may have been invalidated (e.g. reload). Ignore.
  });
}

function tick() {
  const state = detectState();
  // Only send a message when something meaningful has changed (reduces noise).
  if (
    !lastState ||
    lastState.panelFound !== state.panelFound ||
    lastState.panelVisible !== state.panelVisible
  ) {
    report(state);
    lastState = state;
  }
}

// Initial check + periodic polling.
tick();
const poller = setInterval(tick, STATUS_INTERVAL_MS);

// Also fire on DOM mutations so we catch the panel appearing quickly.
const observer = new MutationObserver(() => tick());
observer.observe(document.body || document.documentElement, {
  childList: true,
  subtree: false,
});

// Clean up if the content script is ever unloaded (tab navigates away).
window.addEventListener("pagehide", () => {
  clearInterval(poller);
  observer.disconnect();
});
