# ⚽ PlayStyle Evo Helper — FC26 Chrome Extension

> **Batch-apply PlayStyle and PlayStyle+ evolutions to your FC 26 players directly from the EA web app.**  
> Powered by [nezygis/fc26-playstyle-evo-helper](https://github.com/nezygis/fc26-playstyle-evo-helper) · Wrapped as a Chrome Extension for developer-mode use.

---

> ⚠️ **Disclaimer:** Automating the EA FC web app is against EA's Terms of Service and may result in an account ban. Use entirely at your own risk.

---

## Table of Contents

- [What It Does](#what-it-does)
- [How It Works](#how-it-works)
- [File Structure](#file-structure)
- [Installation](#installation)
- [Using the Extension](#using-the-extension)
- [Updating the Core Script](#updating-the-core-script)
- [Status & Health Check](#status--health-check)
- [PlayStyle Caps & Rules](#playstyle-caps--rules)
- [Modes](#modes)
- [Troubleshooting](#troubleshooting)

---

## What It Does

This Chrome Extension injects a **floating control panel** into the EA FC 26 web app that lets you:

- 🎯 **Select any player** from your club by name search or rarity filter
- ✨ **Auto-suggest** the best PlayStyles for a chosen position + role (e.g. ST → Advanced Forward)
- ✅ **Batch-apply** multiple PlayStyle / PlayStyle+ evolutions in one click
- 🔄 **Bulk mode** — queue multiple players and evolve them all in sequence
- ↩️ **Remove evolutions** — undo the last applied evo from a player
- 🌟 **Glory Hunters support** — apply the special 4th PS+ slot for GH cards (rarity 109)
- 📊 **Live cap tracking** — shows used / remaining slots before you apply

---

## How It Works

### The Core Script (`apply.js`)

`apply.js` is the original Tampermonkey userscript by [nezygis](https://github.com/nezygis/fc26-playstyle-evo-helper). It drives EA's **own internal service objects** rather than making raw HTTP calls, keeping the game's state machine consistent:

| EA Service Call | What It Does |
|---|---|
| `services.Academy.addItemToSlot(slotId, itemId)` | Applies one evolution to a player |
| `services.Academy.claimSlot(slotId)` | Claims / finishes the slot (locks it in) |
| `services.Academy.removeEvoUpgrade(itemId)` | Removes the most recently applied evo |
| `repositories.Item.getClub()` | Fetches your club players |

### The Chrome Extension Wrapper

Chrome content scripts normally run in an **isolated JavaScript world** and cannot access the EA web app's internal objects (`window.services`, `window.repositories`, etc.).

The extension solves this by declaring `"world": "MAIN"` in the manifest, which injects `apply.js` directly into the **page's own JS context** — exactly the same environment that Tampermonkey uses. No modifications to `apply.js` are needed.

```
┌─────────────────────────────────────────────────────────┐
│  EA FC 26 Web App (ea.com/ultimate-team/web-app)        │
│                                                         │
│  ┌───────────────────────────────┐  ◄── MAIN world     │
│  │  apply.js                     │                     │
│  │  • Reads window.services      │                     │
│  │  • Reads window.repositories  │                     │
│  │  • Injects #fcevo panel       │                     │
│  └───────────────────────────────┘                     │
│                                                         │
│  ┌───────────────────────────────┐  ◄── ISOLATED world │
│  │  status.js                    │                     │
│  │  • Watches for #fcevo in DOM  │                     │
│  │  • Reports health to popup    │                     │
│  └───────────────────────────────┘                     │
└─────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────┐
│  background.js (SW)         │  Updates badge per tab
│  popup.html / popup.js      │  Shows live status
└─────────────────────────────┘
```

---

## File Structure

```
autoplaystyles/
│
├── apply.js              ← Core logic — NEVER modify this manually.
│                           Drop in a new version to update.
│
├── manifest.json         ← Chrome Extension manifest (v3)
├── status.js             ← Health monitor (isolated world content script)
├── background.js         ← Service worker: badge + status cache per tab
├── popup.html            ← Extension popup UI
├── popup.js              ← Popup logic: health check & status rendering
│
└── icons/
    ├── icon16.png        ← 16×16  toolbar icon
    ├── icon48.png        ← 48×48  extensions page icon
    └── icon128.png       ← 128×128 Chrome Web Store / about icon
```

---

## Installation

### Prerequisites

- **Google Chrome** (or any Chromium-based browser: Edge, Brave, Opera, etc.)
- The extension folder at `C:\Users\RamandeepSingh\workspaces\autoplaystyles`

### Step-by-Step

**1. Open the Extensions page**

Type the following in your Chrome address bar and press `Enter`:
```
chrome://extensions
```

---

**2. Enable Developer Mode**

In the **top-right corner** of the extensions page, toggle **Developer mode** to ON.

```
┌──────────────────────────────────────────┐
│ Extensions            Developer mode  ●  │
└──────────────────────────────────────────┘
```

---

**3. Load the unpacked extension**

Click **"Load unpacked"** and navigate to your extension folder:

```
C:\Users\RamandeepSingh\workspaces\autoplaystyles
```

Select the folder and click **"Select Folder"**.

---

**4. Confirm the extension loaded**

You should now see the **PlayStyle Evo Helper — FC26** card in your extensions list with no errors.

---

**5. Pin it to the toolbar** *(recommended)*

Click the 🧩 puzzle-piece icon in Chrome's top-right corner → find **PlayStyle Evo Helper — FC26** → click the **📌 pin icon**.

---

## Using the Extension

### Open the EA Web App

Navigate to: **https://www.ea.com/ultimate-team/web-app**

Log in, then go to the **Evolutions → Academy** hub. The floating **Evo Helper** panel will appear automatically in the bottom-right area of the page.

---

### Single Mode (one player)

1. **Search** for a player by name in the panel's search box, or browse the list
2. Filter by rarity using **Rarity ▾** (defaults to evo-eligible rarities)
3. **Click the player** to select them
4. Pick a **Position** and **Role** from the dropdowns
5. Click **✨ Suggest** — the panel pre-selects the recommended PlayStyles:
   - Top 3 from the role's priority list → **PlayStyle+**
   - The rest → **basic PlayStyle**
6. Tweak the selection by clicking tiles in the grid (PS+ tab / PS tab)
7. Click **Apply selected evolutions**

---

### Bulk Mode (multiple players)

1. Switch to the **Bulk** tab at the top of the panel
2. **Click players** in the list to add them to the queue — each player is auto-assigned a role based on their primary position
3. Adjust each queued player's **Position** and **Role** in the queue panel
4. Click **Evolve selected players** → confirm on the second click
5. The tool processes each player in sequence with a configurable delay

---

### Settings (⚙ icon in panel header)

| Setting | Default | Description |
|---|---|---|
| **Claim & finish** | ✅ On | Claims each slot after applying (locks the evo in) |
| **Delay** | 300 ms | Gap between applying each evo (jittered ±35% automatically) |
| **Start minimized** | Off | Panel boots collapsed on every page load |

---

## Updating the Core Script

The wrapper is designed so you **never need to touch it** when the core logic changes.

1. Get the new version of `apply.js` (or `fc26-playstyle-evo-helper.user.js` renamed to `apply.js`)
2. Drop it into `C:\Users\RamandeepSingh\workspaces\autoplaystyles\`, overwriting the old file
3. Go to `chrome://extensions`
4. Click the **⟳ reload** icon on the **PlayStyle Evo Helper** card

That's all. No other files need to change.

---

## Status & Health Check

Click the extension icon in your Chrome toolbar to open the **status popup**.

### Badge colours

| Badge | Meaning |
|---|---|
| 🟢 `✓` | Evo Helper panel is live and active on the current tab |
| 🟡 `…` | On the EA web app but the panel hasn't appeared yet |
| *(no badge)* | Current tab is not the EA web app |

### Popup states

| State | Meaning |
|---|---|
| **Evo Helper is ACTIVE** | `#fcevo` panel found in the page DOM — fully working |
| **Waiting for panel…** | On the EA web app, but the Academy hub isn't open yet |
| **Not on EA Web App** | You're on a different tab/page |

The popup also shows:
- Whether the page is the EA web app
- Whether `apply.js` is loaded
- How recently the status was last reported
- A **⟳ Refresh** button to re-query immediately

---

## PlayStyle Caps & Rules

These are enforced by `apply.js` and match EA's in-game rules:

| Rule | Limit |
|---|---|
| **PlayStyle+** per player | 3 (4 for Glory Hunters rarity 109 cards) |
| **Basic PlayStyle** per player | 8 |
| Base PS and PS+ of the same name | Mutually exclusive — only one can be applied |
| GK-only PlayStyles (`Far Reach`, `Footwork`, etc.) | Only applicable to Goalkeepers |

The panel tracks your remaining slots in real time and turns **red** if a selection would exceed the cap.

---

## Modes

### 🎯 Single Mode
Manual control. You pick the player, pick the evos, hit apply. Best for careful one-off upgrades.

### ⚡ Bulk / Auto Mode
Queue multiple players with auto-resolved roles. The tool applies evos to each in sequence. Ideal for evolving an entire squad in one session.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Extension card shows an error on load | Make sure all files are present (especially `icons/icon16.png`, `icon48.png`, `icon128.png`) |
| Panel doesn't appear on the EA page | Navigate to **Evolutions → Academy** hub first — the script boots when `services.Academy` is ready |
| Status popup shows "Waiting for panel…" | The Academy services haven't initialised yet — wait a few seconds and click ⟳ Refresh |
| Error `460` when applying | Player is ineligible — already has the PlayStyle, is at cap, or their rarity/OVR isn't allowed |
| Error `458` (captcha required) | EA has flagged the session. Stop, reload the web app, and try again later |
| Error `461` (permission denied) | The evo slot isn't available to your account |
| Club list is empty | Click the **Club: waiting…** bar to manually trigger a reload |
| Applied evos not showing | The panel reloads club data automatically after applying. If still stale, click the club status bar to force a reload |

---

## Exporting Your Club Data

You can download a full export of all your club players (stats, playstyles, positions, everything) using the included [`export.js`](export.js) console script.

### What gets exported (per player)

| Category | Fields |
|---|---|
| **Identity** | Name, Rating, Rarity, Height, Weight, Age, Nationality |
| **Positions** | Preferred position, all alternative positions |
| **Face stats** | PAC / SHO / PAS / DRI / DEF / PHY (or DIV/HAN/KIC/REF/SPD/POS for GKs) |
| **Sub-attributes** | All 34 detailed stats (acceleration, finishing, longPassing, etc.) |
| **PlayStyles** | Current basic PS list, current PS+ list, slots used/remaining |
| **Evo state** | Is evolved?, can remove evo?, room for more PS / PS+ |
| **Meta** | Item ID, definition ID, team ID, league ID, untradeable flag |

### How to run the export

1. Open the EA FC 26 web app and log in
2. Make sure the **Evo Helper** panel has loaded (it says "Ready" in the status bar)
3. Open **DevTools** → press `F12` → click the **Console** tab
4. Open [`export.js`](export.js), copy the entire contents, paste into the console and press `Enter`
5. Then run:

```js
// Download both JSON and CSV
await FCEvoExport.run()

// JSON only
await FCEvoExport.run("json")

// CSV only
await FCEvoExport.run("csv")

// Inspect data in console without downloading
FCEvoExport.last
```

Two files will download automatically:
- `fc26-club-YYYY-MM-DD-HH-MM.json` — full structured data, one object per player
- `fc26-club-YYYY-MM-DD-HH-MM.csv` — flat table, one row per player, importable into Excel / Google Sheets

> **Note:** The export uses `window.FCEvo.clubPlayers()` which is populated by the extension. If the club hasn't loaded yet, the script will call `loadClub()` automatically before exporting.

---

## Credits

- **Core script:** [nezygis](https://github.com/nezygis/fc26-playstyle-evo-helper) — the original Tampermonkey userscript author
- **Chrome Extension wrapper:** Created to allow running the script without Tampermonkey, using developer mode
