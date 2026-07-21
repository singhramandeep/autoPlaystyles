/**
 * panel_extras.js — MAIN world content script
 *
 * Runs alongside apply.js on the EA FC 26 web app.
 * Waits for the #fcevo panel (created by apply.js) to appear,
 * then appends an "Export" section to it — no popup interaction needed.
 *
 * Also defines window.FCEvoExport so the popup's Export buttons
 * can call it directly without injecting a separate file.
 */
(function () {
  "use strict";

  // ── Export engine ──────────────────────────────────────────────────────
  // Defined once; idempotent if panel_extras.js somehow runs twice.
  if (!window.FCEvoExport) {

    const TRAIT_OFFSET = 301, CAP_PLUS = 3, CAP_BASIC = 8;
    const GH_RARITIES  = new Set([104, 109]);

    const SUB_ATTR = {
       0:"acceleration",  1:"sprintSpeed",   2:"agility",       3:"balance",
       4:"jumping",       5:"stamina",        6:"strength",      7:"reactions",
       8:"aggression",    9:"composure",     10:"interceptions",11:"positioning",
      12:"vision",       13:"ballControl",   14:"crossing",     15:"dribbling",
      16:"finishing",    17:"fkAccuracy",    18:"heading",      19:"longPassing",
      20:"shortPassing", 21:"defAwareness",  22:"shotPower",    23:"longShots",
      24:"standTackle",  25:"slideTackle",   26:"volleys",      27:"curve",
      28:"penalties",    29:"gkDiving",      30:"gkHandling",   31:"gkKicking",
      32:"gkReflexes",   33:"gkPositioning",
    };
    const SUB_ORDER = [
      "acceleration","sprintSpeed","finishing","shotPower","longShots","volleys",
      "penalties","fkAccuracy","heading","curve","shortPassing","longPassing",
      "crossing","vision","dribbling","ballControl","agility","balance",
      "reactions","composure","interceptions","defAwareness","standTackle",
      "slideTackle","jumping","stamina","strength","aggression","positioning",
      "gkDiving","gkHandling","gkKicking","gkReflexes","gkPositioning",
    ];
    const FACE_OUT = ["pac","sho","pas","dri","def","phy"];
    const FACE_GK  = ["div","han","kic","ref","spd","pos"];
    const ALL_FACE = [...FACE_OUT, ...FACE_GK];
    const POS_LABEL = {
       0:"GK", 1:"CB", 2:"RB", 3:"LB", 4:"SW", 5:"CB", 6:"CB",
       7:"RWB",8:"LWB",9:"CDM",10:"CDM",11:"CDM",12:"RM",13:"CM",
      14:"CM",15:"CM",16:"LM",17:"CAM",18:"CAM",19:"CAM",20:"RW",
      21:"ST",22:"LW",23:"RW",24:"CF",25:"ST",26:"ST",27:"LW",
    };
    const WORK_RATE = {0:"Low",1:"Medium",2:"High"};
    const FOOT      = {1:"Right",2:"Left"};
    const BODY_TYPE = {0:"Lean",1:"Normal",2:"Stocky",3:"Lean (Tall)",4:"Normal (Tall)",5:"Stocky (Tall)",6:"Mbappe"};

    const safe = (fn) => { try { return fn(); } catch (_) { return null; } };

    function buildTraitMap() {
      const map = {};
      try { (window.FCEvo.PS || []).forEach(x => { map[x.r - TRAIT_OFFSET] = x.n; }); } catch (_) {}
      return map;
    }

    function calcAge(bd) {
      try {
        const d = typeof bd === "number" && bd < 1e10 ? new Date(bd * 1000) : new Date(bd);
        if (isNaN(d)) return null;
        const now = new Date();
        let age = now.getFullYear() - d.getFullYear();
        const m = now.getMonth() - d.getMonth();
        if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--;
        return age > 10 && age < 60 ? age : null;
      } catch (_) { return null; }
    }

    function extractPlayer(it, traitMap) {
      const isGK = safe(() => !!it.isGK());
      const sd   = safe(() => it.getStaticData ? it.getStaticData() : it._staticData) || {};
      const name = sd.name || sd.commonName || safe(() => it.name)
        || [sd.firstName, sd.lastName].filter(Boolean).join(" ") || "Unknown";

      const birthdate = sd.birthdate ?? safe(() => it.birthdate) ?? null;
      const age = safe(() => it.age) ?? safe(() => sd.age) ?? calcAge(birthdate);

      const faceRaw  = safe(() => it.getAttributes ? it.getAttributes() : null)
                    || safe(() => Array.isArray(it.attributes) ? it.attributes : null) || [];
      const faceKeys = isGK ? FACE_GK : FACE_OUT;
      const faceStats = {};
      faceKeys.forEach((k, i) => { faceStats[k] = faceRaw[i] != null ? +faceRaw[i] : null; });

      const subAttributes = {};
      (safe(() => it.getSubAttributes()) || []).forEach(s => {
        const key = SUB_ATTR[s && s.type];
        if (key && s.rating > 0) subAttributes[key] = s.rating;
      });

      const rawPS   = safe(() => it.getPlayStyles()) || [];
      const psPlus  = rawPS.filter(p =>  p.isIcon).map(p => (traitMap[p.traitId] || "trait_" + p.traitId) + "+");
      const psBasic = rawPS.filter(p => !p.isIcon).map(p =>  traitMap[p.traitId] || "trait_" + p.traitId);
      const numPlus  = safe(() => it.getNumPlusPlayStyles());
      const numBasic = safe(() => it.getNumBasicPlayStyles());
      const capPlus  = GH_RARITIES.has(it.rareflag) ? 4 : CAP_PLUS;

      const prefPos = POS_LABEL[it.preferredPosition] || it.preferredPosition;
      const allPosIds = safe(() => it.possiblePositions) || safe(() => it.getBasePossiblePositions()) || [];
      const allPositions = [...new Set(
        [it.preferredPosition, ...allPosIds].filter(x => x != null).map(id => POS_LABEL[id] || id)
      )];

      const isEvolved    = safe(() => !!it.canRemoveEvolution()) || safe(() => !!it.isAcademyGraduateWithStatUpgrade()) || false;
      const canRemoveEvo = safe(() => !!it.canRemoveEvolution()) || false;

      return {
        id: it.id, definitionId: it.definitionId ?? null,
        name, firstName: sd.firstName || null, lastName: sd.lastName || null, commonName: sd.commonName || null,
        rating: it.rating ?? null, rareflag: it.rareflag ?? null,
        preferredPos, allPositions, isGK: !!isGK,
        height: it.height ?? sd.height ?? null, weight: it.weight ?? sd.weight ?? null,
        age, birthdate,
        preferredFoot:   FOOT[sd.preferredFoot ?? safe(() => it.foot)] ?? null,
        skillMoves:      sd.skillMoves ?? safe(() => it.skillMoves) ?? null,
        weakFoot:        sd.weakFoot   ?? safe(() => it.weakFoot)   ?? null,
        attackWorkRate:  WORK_RATE[sd.attackWorkRate  ?? safe(() => it.attackWorkRate)]  ?? null,
        defenseWorkRate: WORK_RATE[sd.defenseWorkRate ?? safe(() => it.defenseWorkRate)] ?? null,
        bodyType: BODY_TYPE[sd.bodyType ?? safe(() => it.bodyType)] ?? null,
        nationality: safe(() => sd.nationality ?? it.nationality ?? it.nation) ?? null,
        leagueId: safe(() => it.leagueId) ?? null, teamId: safe(() => it.teamId) ?? null,
        untradeable: safe(() => !!it.untradeable) ?? null,
        faceStats, subAttributes,
        playStylesPlus: psPlus, playStylesBasic: psBasic, allPlayStyles: [...psPlus, ...psBasic],
        numPlusUsed: numPlus ?? null, numPlusCap: capPlus,
        numBasicUsed: numBasic ?? null, numBasicCap: CAP_BASIC,
        psRoomPlus:  numPlus  != null ? Math.max(0, capPlus  - numPlus)  : null,
        psRoomBasic: numBasic != null ? Math.max(0, CAP_BASIC - numBasic) : null,
        isEvolved, canRemoveEvo,
      };
    }

    function toCSV(players) {
      if (!players.length) return "";
      const headers = [
        "id","name","rating","rareflag","preferredPos","allPositions","isGK",
        "height","weight","age","preferredFoot","skillMoves","weakFoot",
        "attackWorkRate","defenseWorkRate","bodyType","nationality",
        "leagueId","teamId","untradeable",
        ...ALL_FACE, ...SUB_ORDER,
        "playStylesPlus","playStylesBasic",
        "numPlusUsed","numPlusCap","numBasicUsed","numBasicCap",
        "psRoomPlus","psRoomBasic","isEvolved","canRemoveEvo","definitionId",
      ];
      const esc = (v) => {
        if (v == null) return "";
        const s = Array.isArray(v) ? v.join("|") : String(v);
        return s.includes(",") || s.includes('"') || s.includes("\n")
          ? '"' + s.replace(/"/g, '""') + '"' : s;
      };
      const rows = players.map(p => headers.map(h => {
        if (ALL_FACE.includes(h))    return esc(p.faceStats[h]);
        if (SUB_ORDER.includes(h))   return esc(p.subAttributes[h]);
        if (h === "allPositions")    return esc(p.allPositions);
        if (h === "playStylesPlus")  return esc(p.playStylesPlus);
        if (h === "playStylesBasic") return esc(p.playStylesBasic);
        return esc(p[h]);
      }).join(","));
      return [headers.join(","), ...rows].join("\n");
    }

    function dlFile(content, filename, mime) {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([content], { type: mime }));
      a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
    }

    function tsFmt() { return new Date().toISOString().slice(0,16).replace(/[T:]/g,"-"); }

    // Collect all players from every available source, deduped by id.
    async function gatherAllPlayers() {
      const seen = new Set(), all = [];
      function addItems(items) {
        if (!Array.isArray(items)) return;
        for (const it of items) {
          if (!it || it.id == null) continue;
          let isP = false;
          try { isP = !!it.isPlayer(); } catch (_) { isP = !!it.playerInfo; }
          if (!isP || seen.has(it.id)) continue;
          seen.add(it.id); all.push(it);
        }
      }

      // 1. Full club search — no rarity filter
      if (window.FCEvo) {
        try { await window.FCEvo.loadClub(null); } catch (_) {}
        addItems(window.FCEvo.clubPlayers());
      }
      // 2. Live club repository
      try {
        const club = window.repositories.Item.getClub();
        addItems(club.items || (club.getItems ? club.getItems() : []));
      } catch (_) {}
      // 3. Active squad
      try {
        const sq = window.repositories.Squad.getActiveSquad
          ? window.repositories.Squad.getActiveSquad()
          : window.repositories.Squad.activeSquad;
        addItems((sq.getPlayers ? sq.getPlayers() : sq.players || []).filter(Boolean));
      } catch (_) {}
      // 4. Other piles (development, reserves, SBC)
      try {
        const IP = window.ItemPile || {}, repo = window.repositories.Item;
        for (const k of ["DEVELOPMENT","RESERVES","SBC_STORAGE","ACTIVE_SQUAD"]) {
          try {
            const id = IP[k]; if (id == null) continue;
            const pile = repo.getByPile ? repo.getByPile(id) : null;
            if (pile) addItems(Array.isArray(pile) ? pile : pile.items || []);
          } catch (_) {}
        }
      } catch (_) {}

      return all;
    }

    let lastResult = null;

    async function run(format = "both") {
      let players;
      try { players = await gatherAllPlayers(); }
      catch (e) { return { ok: false, error: e.message || String(e) }; }

      if (!players.length) return { ok: false, error: "No players found. Are you logged in?" };

      const traitMap = buildTraitMap();
      const data = players.map(it => {
        try { return extractPlayer(it, traitMap); } catch (_) { return null; }
      }).filter(Boolean);
      data.sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
      lastResult = data;

      const stamp = tsFmt(), fmts = [];
      if (format === "json" || format === "both") {
        dlFile(JSON.stringify(data, null, 2), `fc26-club-${stamp}.json`, "application/json");
        fmts.push("json");
      }
      if (format === "csv" || format === "both") {
        dlFile(toCSV(data), `fc26-club-${stamp}.csv`, "text/csv");
        fmts.push("csv");
      }
      return { ok: true, count: data.length, formats: fmts, filename: `fc26-club-${stamp}` };
    }

    window.FCEvoExport = { run, get last() { return lastResult; } };
  }

  // ── Panel injection ────────────────────────────────────────────────────
  // Adds a small Export section to the bottom of the #fcevo panel body.
  function injectExportUI() {
    const panel = document.getElementById("fcevo");
    if (!panel || panel.dataset.exportUi) return;
    panel.dataset.exportUi = "1";

    const body = panel.querySelector(".body");
    if (!body) return;

    // Styles — uses the same CSS variables apply.js already set
    const style = document.createElement("style");
    style.textContent = `
      #fcevo .export-sec{border-top:1px solid var(--line,#222e3c);padding-top:10px;margin-top:2px}
      #fcevo .export-sec h4{font:700 10px/1 var(--grot,-apple-system);text-transform:uppercase;
        letter-spacing:.12em;color:var(--acc,#2ea5ff);margin-bottom:8px}
      #fcevo .export-row{display:flex;gap:5px}
      #fcevo .exp-btn{flex:1;background:transparent;color:var(--ash,#7a8a9a);
        border:1px solid var(--line2,#2a3a4a);padding:6px 4px;cursor:pointer;
        font:600 10px/1 var(--mono,monospace);text-transform:uppercase;letter-spacing:.08em;
        transition:color .15s,border-color .15s}
      #fcevo .exp-btn:hover{color:var(--bone,#e0eaf4);border-color:var(--ash,#7a8a9a)}
      #fcevo .exp-btn:disabled{opacity:.35;cursor:not-allowed}
      #fcevo .exp-btn.primary{background:var(--acc,#2ea5ff);color:#0a0e14;border-color:var(--acc,#2ea5ff)}
      #fcevo .exp-btn.primary:hover{filter:brightness(1.1)}
      #fcevo .exp-status{font:11px/1.4 var(--grot,-apple-system);color:var(--ash,#7a8a9a);
        margin-top:6px;min-height:16px;word-break:break-all}
      #fcevo .exp-status.ok{color:var(--good,#3ecf6a)}
      #fcevo .exp-status.err{color:var(--bad,#e05252)}
      #fcevo .exp-status.load{color:var(--warn,#e5a72a)}
    `;
    document.head.appendChild(style);

    // HTML
    const sec = document.createElement("div");
    sec.className = "sec export-sec";
    sec.innerHTML = `
      <h4>📥 Export club data</h4>
      <div class="export-row">
        <button class="exp-btn primary" id="fcevo-exp-both">JSON + CSV</button>
        <button class="exp-btn" id="fcevo-exp-json">JSON</button>
        <button class="exp-btn" id="fcevo-exp-csv">CSV</button>
      </div>
      <div class="exp-status" id="fcevo-exp-status">Exports all players incl. squad · no filter</div>
    `;
    body.appendChild(sec);

    const btns    = ["fcevo-exp-both","fcevo-exp-json","fcevo-exp-csv"];
    const statusEl = document.getElementById("fcevo-exp-status");

    function setStatus(msg, cls) {
      statusEl.textContent = msg;
      statusEl.className = "exp-status" + (cls ? " " + cls : "");
    }
    function setBusy(on) {
      btns.forEach(id => { const b = document.getElementById(id); if (b) b.disabled = on; });
    }

    async function doExport(fmt) {
      setBusy(true);
      setStatus("Loading all players…", "load");
      try {
        const res = await window.FCEvoExport.run(fmt);
        if (res.ok) {
          setStatus(`✅ ${res.count} players → ${res.formats.join(" + ").toUpperCase()}`, "ok");
        } else {
          setStatus("✗ " + res.error, "err");
        }
      } catch (e) {
        setStatus("✗ " + (e.message || String(e)), "err");
      }
      setBusy(false);
    }

    document.getElementById("fcevo-exp-both").addEventListener("click", () => doExport("both"));
    document.getElementById("fcevo-exp-json").addEventListener("click", () => doExport("json"));
    document.getElementById("fcevo-exp-csv").addEventListener("click",  () => doExport("csv"));
  }

  // Wait for the #fcevo panel (apply.js polls for services, may take a few seconds).
  function waitForPanel() {
    if (document.getElementById("fcevo")) { injectExportUI(); return; }
    const obs = new MutationObserver(() => {
      if (document.getElementById("fcevo")) { obs.disconnect(); injectExportUI(); }
    });
    obs.observe(document.body || document.documentElement, { childList: true, subtree: true });
    // Safety timeout: give up watching after 5 minutes (tab stayed open, panel never appeared)
    setTimeout(() => obs.disconnect(), 5 * 60 * 1000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", waitForPanel);
  } else {
    waitForPanel();
  }
})();
