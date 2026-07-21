/**
 * background.js — Service Worker
 *
 * Receives health pings from status.js (one per tab) and:
 *  - Keeps a per-tab status record readable by popup.js
 *  - Updates the action badge so you can see at a glance whether the helper
 *    is running on the active tab (green ✓ = active, no badge = not on EA page)
 */

const tabStatus = {}; // tabId -> { panelFound, panelVisible, onEAPage, url, ts }

// ── Receive status pings from the isolated-world content script ────────────
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type !== "FCEVO_STATUS") return;
  const tabId = sender.tab && sender.tab.id;
  if (!tabId) return;

  tabStatus[tabId] = {
    panelFound:   msg.panelFound,
    panelVisible: msg.panelVisible,
    onEAPage:     msg.onEAPage,
    url:          msg.url,
    ts:           msg.ts,
  };

  // Badge: green ✓ when the panel is live, orange ! when on EA page but not
  // yet loaded, nothing on any other page.
  if (msg.panelFound) {
    chrome.action.setBadgeText({ text: "✓", tabId });
    chrome.action.setBadgeBackgroundColor({ color: "#00C853", tabId });
  } else if (msg.onEAPage) {
    chrome.action.setBadgeText({ text: "…", tabId });
    chrome.action.setBadgeBackgroundColor({ color: "#FF8F00", tabId });
  } else {
    chrome.action.setBadgeText({ text: "", tabId });
  }
});

// ── Popup asks for the current tab's status ────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== "GET_STATUS") return false;
  sendResponse(tabStatus[msg.tabId] || null);
  return true;
});

// ── Clean up stale entries when a tab closes ──────────────────────────────
chrome.tabs.onRemoved.addListener((tabId) => {
  delete tabStatus[tabId];
});
