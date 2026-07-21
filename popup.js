/**
 * popup.js — Extension popup logic
 *
 * 1. Asks the background worker for the cached status of the active tab.
 * 2. Falls back to injecting a quick check via chrome.scripting if the cached
 *    data is stale or missing (e.g. popup opened before status.js fired).
 * 3. Renders the health state in the UI.
 */

const EL = (id) => document.getElementById(id);

// ── Helpers ───────────────────────────────────────────────────────────────
function timeAgo(ts) {
  if (!ts) return "never";
  const secs = Math.round((Date.now() - ts) / 1000);
  if (secs < 5)  return "just now";
  if (secs < 60) return secs + "s ago";
  return Math.round(secs / 60) + "m ago";
}

function setStatus(state) {
  const card   = EL("status-card");
  const label  = EL("status-label");
  const icon   = EL("status-icon");
  const body   = EL("status-body");
  const page   = EL("info-page");
  const panel  = EL("info-panel");
  const script = EL("info-script");
  const ts     = EL("info-ts");
  const tip    = EL("tip-box");

  // Remove all state classes, add the new one.
  card.className = "status-card";

  if (!state) {
    // No data at all — popup opened on a non-EA page with no history.
    card.classList.add("inactive");
    label.textContent  = "Not active on this tab";
    icon.textContent   = "💤";
    body.textContent   = "Navigate to the EA FC 26 web app to use the Evo Helper.";
    page.textContent   = "Not an EA web app page";
    page.className     = "info-val warn";
    panel.textContent  = "N/A";
    panel.className    = "info-val";
    script.textContent = "Not injected";
    script.className   = "info-val warn";
    ts.textContent     = "—";
    tip.innerHTML = "<b>Open the EA web app</b> and navigate to the Evolutions (Academy) hub — the floating panel will appear automatically.";
    return;
  }

  const { panelFound, panelVisible, onEAPage, url, ts: stamp } = state;

  // Page row
  page.textContent = onEAPage ? "EA FC 26 Web App ✓" : (url ? new URL(url).hostname : "Unknown");
  page.className   = "info-val " + (onEAPage ? "ok" : "warn");

  // Panel row
  if (!onEAPage) {
    panel.textContent = "N/A";
    panel.className   = "info-val";
  } else if (panelFound) {
    panel.textContent = panelVisible ? "Visible" : "Minimised";
    panel.className   = "info-val ok";
  } else {
    panel.textContent = "Not found (still loading?)";
    panel.className   = "info-val warn";
  }

  // Script row
  script.textContent = panelFound ? "apply.js loaded ✓" : onEAPage ? "Waiting for Academy hub…" : "Not on EA page";
  script.className   = "info-val " + (panelFound ? "ok" : onEAPage ? "warn" : "");

  // Timestamp
  ts.textContent = timeAgo(stamp);
  ts.className   = "info-val";

  // Overall card state
  if (panelFound) {
    card.classList.add("active");
    label.textContent = "Evo Helper is ACTIVE";
    icon.textContent  = "✅";
    body.textContent  = "The floating panel is running on the EA web app. Select a player and apply evolutions.";
    tip.innerHTML = "<b>Panel loaded.</b> Go to the Evolutions hub, pick a player, choose a role, hit <b>✨ Suggest</b>, then <b>Apply selected</b>.";
  } else if (onEAPage) {
    card.classList.add("pending");
    label.textContent = "Waiting for panel…";
    icon.textContent  = "⏳";
    body.textContent  = "On the EA web app but the panel hasn't appeared yet. Open the Evolutions (Academy) hub to trigger it.";
    tip.innerHTML = "<b>Tip:</b> Navigate to <b>Evolutions → Academy</b> in the EA web app. The panel boots once <code>services.Academy</code> is ready.";
  } else {
    card.classList.add("inactive");
    label.textContent = "Not on EA Web App";
    icon.textContent  = "💤";
    body.textContent  = "Switch to the EA FC 26 web app tab to use the Evo Helper.";
    tip.innerHTML = "<b>Open the EA web app</b> and navigate to the Evolutions (Academy) hub — the floating panel will appear automatically.";
  }
}

// ── Fallback: directly query the page via scripting API ──────────────────
// Used when background has no cached data for this tab (e.g. first open).
async function liveCheck(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => ({
        panelFound:   !!document.getElementById("fcevo"),
        panelVisible: (() => { const el = document.getElementById("fcevo"); return el ? el.style.display !== "none" : false; })(),
        fcEvoReady:   typeof window.FCEvo !== "undefined",
        onEAPage:     /ultimate-team\/web-app/.test(window.location.href),
        url:          window.location.href,
        ts:           Date.now(),
      }),
    });
    return results && results[0] && results[0].result;
  } catch (_) {
    return null;
  }
}

// ── Main refresh ──────────────────────────────────────────────────────────
async function refresh() {
  // Show a spinner while we're working.
  EL("status-icon").innerHTML = '<span class="spin">◌</span>';

  let tab;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch (_) {
    setStatus(null);
    return;
  }

  if (!tab) { setStatus(null); return; }

  // Ask background for cached status (cheap).
  let status = await new Promise((res) =>
    chrome.runtime.sendMessage({ type: "GET_STATUS", tabId: tab.id }, (r) => res(r || null))
  );

  // If no cached data or it's very stale (>10s), run a live DOM check.
  if (!status || (Date.now() - status.ts) > 10_000) {
    const live = await liveCheck(tab.id);
    if (live) status = live;
  }

  setStatus(status);
}

// ── Init ──────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  // Show extension version from manifest.
  try {
    const v = chrome.runtime.getManifest().version;
    if (v) EL("ext-version").textContent = "v" + v;
  } catch (_) {}

  refresh();

  EL("btn-refresh").addEventListener("click", () => {
    EL("btn-refresh").textContent = "⟳ Refreshing…";
    EL("btn-refresh").disabled = true;
    refresh().finally(() => {
      EL("btn-refresh").textContent = "⟳ Refresh";
      EL("btn-refresh").disabled = false;
    });
  });

  // ── Export buttons ─────────────────────────────────────────────────────
  const exportStatus = EL("export-status");

  function setExportStatus(msg, cls = "") {
    exportStatus.textContent = msg;
    exportStatus.className = "export-status" + (cls ? " " + cls : "");
  }

  function setExportBtnsDisabled(on) {
    ["btn-export-both", "btn-export-json", "btn-export-csv"].forEach(id => {
      EL(id).disabled = on;
    });
  }

  async function runExport(format) {
    // 1. Get the active tab
    let tab;
    try { [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); }
    catch (_) { setExportStatus("Could not query active tab.", "err"); return; }

    if (!tab) { setExportStatus("No active tab found.", "err"); return; }

    // 2. Check it's the EA web app
    if (!tab.url || !tab.url.includes("ultimate-team/web-app")) {
      setExportStatus("⚠ Not on the EA FC 26 web app. Open it first.", "err");
      return;
    }

    setExportBtnsDisabled(true);
    setExportStatus("⟳ Injecting export module…", "load");

    try {
      // 3. Call FCEvoExport.run(format) in MAIN world.
      // If window.FCEvoExport isn't loaded yet (e.g. tab loaded before extension update), inject panel_extras.js.
      let results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: "MAIN",
        func: async (fmt) => {
          if (!window.FCEvoExport) return null;
          return await window.FCEvoExport.run(fmt);
        },
        args: [format],
      });

      let result = results && results[0] && results[0].result;

      // If FCEvoExport was missing, inject panel_extras.js as fallback and retry
      if (result === null) {
        setExportStatus("⟳ Injecting export module…", "load");
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          world: "MAIN",
          files: ["panel_extras.js"],
        });

        results = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          world: "MAIN",
          func: async (fmt) => {
            if (!window.FCEvoExport) return { ok: false, error: "FCEvoExport could not be loaded." };
            return await window.FCEvoExport.run(fmt);
          },
          args: [format],
        });
        result = results && results[0] && results[0].result;
      }

      if (!result) {
        setExportStatus("Export returned no response. Is the EA app logged in?", "err");
      } else if (!result.ok) {
        setExportStatus("✗ " + (result.error || "Export failed."), "err");
      } else {
        const fmts = result.formats.join(" + ").toUpperCase();
        setExportStatus(
          `✅ ${result.count} players → ${fmts} · ${result.filename}`,
          "ok"
        );
      }
    } catch (e) {
      // Common causes: tab isn't scriptable (chrome:// pages, etc.)
      const msg = e && e.message ? e.message : String(e);
      setExportStatus("✗ " + (msg.includes("Cannot access") ? "Page not scriptable — reload the EA web app." : msg), "err");
    } finally {
      setExportBtnsDisabled(false);
    }
  }

  EL("btn-export-both").addEventListener("click", () => runExport("both"));
  EL("btn-export-json").addEventListener("click", () => runExport("json"));
  EL("btn-export-csv").addEventListener("click",  () => runExport("csv"));
});
