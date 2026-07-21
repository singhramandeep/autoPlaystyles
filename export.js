/**
 * FC26 Club Player Export  v2 — Injectable edition
 * ==================================================
 * This file is designed to be injected on-demand into the EA web app tab
 * by the Chrome extension popup via chrome.scripting.executeScript.
 * It can also be pasted manually into the DevTools console.
 *
 * It is IDEMPOTENT — safe to inject multiple times; the definition is skipped
 * if window.FCEvoExport already exists.
 *
 * Exported fields per player
 * ──────────────────────────
 *  IDENTITY     name · rating · rarity · isGK
 *               preferredPos · allPositions
 *               height(cm) · weight(kg) · age · birthdate
 *               preferredFoot · skillMoves · weakFoot
 *               attackWorkRate · defenseWorkRate · bodyType
 *               nationality · leagueId · teamId · untradeable
 *
 *  FACE STATS   outfield: pac/sho/pas/dri/def/phy
 *               GK:       div/han/kic/ref/spd/pos
 *
 *  SUB-ATTRS    All 34 detailed attributes including:
 *               finishing · shotPower · longShots · volleys · penalties
 *               fkAccuracy · heading · curve · shortPassing · longPassing
 *               crossing · vision · dribbling · ballControl · agility
 *               balance · reactions · composure · interceptions
 *               defAwareness · standTackle · slideTackle · acceleration
 *               sprintSpeed · jumping · stamina · strength · aggression
 *               positioning · gkDiving · gkHandling · gkKicking
 *               gkReflexes · gkPositioning
 *
 *  PLAYSTYLES   playStylesPlus · playStylesBasic
 *               numPlusUsed/Cap · numBasicUsed/Cap
 *               psRoomPlus · psRoomBasic
 *
 *  EVO STATE    isEvolved · canRemoveEvo
 *
 * Console API (manual use):
 *   await FCEvoExport.run()            → JSON + CSV download
 *   await FCEvoExport.run("json")      → JSON only
 *   await FCEvoExport.run("csv")       → CSV only
 *   await FCEvoExport.preview()        → console.table (no download)
 *   FCEvoExport.inspect("Mbappe")      → full detail for one player
 *   FCEvoExport.find("Salah")          → search by name
 *   FCEvoExport.last                   → raw array from last run
 */

if (!window.FCEvoExport) {
  window.FCEvoExport = (() => {
    "use strict";

    // ── Constants ──────────────────────────────────────────────────────────
    const TRAIT_OFFSET = 301;
    const CAP_PLUS     = 3;
    const CAP_BASIC    = 8;
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

    // Grouped column order for CSV
    const SUB_ORDER = [
      "acceleration","sprintSpeed",
      "finishing","shotPower","longShots","volleys","penalties","fkAccuracy","heading","curve",
      "shortPassing","longPassing","crossing","vision",
      "dribbling","ballControl","agility","balance","reactions","composure",
      "interceptions","defAwareness","standTackle","slideTackle",
      "jumping","stamina","strength","aggression","positioning",
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

    // ── Helpers ────────────────────────────────────────────────────────────
    const safe = (fn) => { try { return fn(); } catch (_) { return null; } };

    function buildTraitMap() {
      const map = {};
      try { (window.FCEvo.PS || []).forEach(x => { map[x.r - TRAIT_OFFSET] = x.n; }); } catch (_) {}
      return map;
    }

    function calcAge(bd) {
      if (!bd) return null;
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

    // ── Per-player extraction ──────────────────────────────────────────────
    function extractPlayer(it, traitMap) {
      const isGK = safe(() => !!it.isGK());
      const sd   = safe(() => it.getStaticData ? it.getStaticData() : it._staticData) || {};

      const name = sd.name || sd.commonName || safe(() => it.name)
        || [sd.firstName, sd.lastName].filter(Boolean).join(" ") || "Unknown";

      const birthdate = sd.birthdate ?? safe(() => it.birthdate) ?? null;
      const age = safe(() => it.age) ?? safe(() => sd.age) ?? calcAge(birthdate);

      // Face stats
      const faceRaw  = safe(() => it.getAttributes ? it.getAttributes() : null)
                    || safe(() => Array.isArray(it.attributes) ? it.attributes : null) || [];
      const faceKeys = isGK ? FACE_GK : FACE_OUT;
      const faceStats = {};
      faceKeys.forEach((k, i) => { faceStats[k] = faceRaw[i] != null ? +faceRaw[i] : null; });

      // Sub-attributes
      const subAttributes = {};
      (safe(() => it.getSubAttributes()) || []).forEach(s => {
        const key = SUB_ATTR[s && s.type];
        if (key && s.rating > 0) subAttributes[key] = s.rating;
      });

      // PlayStyles
      const rawPS    = safe(() => it.getPlayStyles()) || [];
      const psPlus   = rawPS.filter(p => p.isIcon).map(p  => (traitMap[p.traitId] || ("trait_" + p.traitId)) + "+");
      const psBasic  = rawPS.filter(p => !p.isIcon).map(p => traitMap[p.traitId] || ("trait_" + p.traitId));
      const numPlus  = safe(() => it.getNumPlusPlayStyles());
      const numBasic = safe(() => it.getNumBasicPlayStyles());
      const capPlus  = GH_RARITIES.has(it.rareflag) ? 4 : CAP_PLUS;

      // Positions
      const prefPos = POS_LABEL[it.preferredPosition] || it.preferredPosition;
      const allPosIds = safe(() => it.possiblePositions) || safe(() => it.getBasePossiblePositions()) || [];
      const allPositions = [...new Set(
        [it.preferredPosition, ...allPosIds].filter(x => x != null).map(id => POS_LABEL[id] || id)
      )];

      // Evo
      const isEvolved    = safe(() => !!it.canRemoveEvolution()) || safe(() => !!it.isAcademyGraduateWithStatUpgrade()) || false;
      const canRemoveEvo = safe(() => !!it.canRemoveEvolution()) || false;

      return {
        // Identity
        id: it.id, definitionId: it.definitionId ?? null,
        name,
        firstName:  sd.firstName  || null,
        lastName:   sd.lastName   || null,
        commonName: sd.commonName || null,
        rating:  it.rating  ?? null,
        rareflag: it.rareflag ?? null,
        preferredPos, allPositions, isGK: !!isGK,
        // Physical
        height: it.height ?? sd.height ?? null,
        weight: it.weight ?? sd.weight ?? null,
        age, birthdate,
        preferredFoot:  FOOT[sd.preferredFoot ?? safe(() => it.foot)] ?? null,
        skillMoves:     sd.skillMoves ?? safe(() => it.skillMoves)    ?? null,
        weakFoot:       sd.weakFoot   ?? safe(() => it.weakFoot)      ?? null,
        attackWorkRate:  WORK_RATE[sd.attackWorkRate  ?? safe(() => it.attackWorkRate)]  ?? null,
        defenseWorkRate: WORK_RATE[sd.defenseWorkRate ?? safe(() => it.defenseWorkRate)] ?? null,
        bodyType: BODY_TYPE[sd.bodyType ?? safe(() => it.bodyType)] ?? null,
        // Club
        nationality: safe(() => sd.nationality ?? it.nationality ?? it.nation) ?? null,
        leagueId:    safe(() => it.leagueId) ?? null,
        teamId:      safe(() => it.teamId)   ?? null,
        untradeable: safe(() => !!it.untradeable) ?? null,
        // Stats
        faceStats,
        subAttributes,
        // PlayStyles
        playStylesPlus: psPlus, playStylesBasic: psBasic,
        allPlayStyles: [...psPlus, ...psBasic],
        numPlusUsed: numPlus ?? null, numPlusCap: capPlus,
        numBasicUsed: numBasic ?? null, numBasicCap: CAP_BASIC,
        psRoomPlus:  numPlus  != null ? Math.max(0, capPlus  - numPlus)  : null,
        psRoomBasic: numBasic != null ? Math.max(0, CAP_BASIC - numBasic) : null,
        // Evo
        isEvolved, canRemoveEvo,
      };
    }

    // ── CSV builder ────────────────────────────────────────────────────────
    function toCSV(players) {
      if (!players.length) return "";
      const headers = [
        "id","name","rating","rareflag","preferredPos","allPositions","isGK",
        "height","weight","age","preferredFoot","skillMoves","weakFoot",
        "attackWorkRate","defenseWorkRate","bodyType",
        "nationality","leagueId","teamId","untradeable",
        ...ALL_FACE,
        ...SUB_ORDER,
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
        if (ALL_FACE.includes(h))   return esc(p.faceStats[h]);
        if (SUB_ORDER.includes(h))  return esc(p.subAttributes[h]);
        if (h === "allPositions")   return esc(p.allPositions);
        if (h === "playStylesPlus") return esc(p.playStylesPlus);
        if (h === "playStylesBasic")return esc(p.playStylesBasic);
        return esc(p[h]);
      }).join(","));
      return [headers.join(","), ...rows].join("\n");
    }

    // ── Download helpers ───────────────────────────────────────────────────
    function download(content, filename, mime) {
      const url = URL.createObjectURL(new Blob([content], { type: mime }));
      Object.assign(document.createElement("a"), { href: url, download: filename,
        style: "display:none" }).dispatchEvent
        ? (() => { const a = document.createElement("a"); a.href = url; a.download = filename;
            document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url); })()
        : URL.revokeObjectURL(url);
    }

    function ts() { return new Date().toISOString().slice(0,16).replace(/[T:]/g,"-"); }

    // ── Club loader ────────────────────────────────────────────────────────
    // Loads ALL club players (no rarity filter) and merges in active squad
    // players, which may live in a separate item pile.
    async function ensureClub() {
      if (!window.FCEvo) {
        throw new Error("FCEvo not ready — make sure you're on the EA FC 26 web app and the Evo Helper panel has loaded.");
      }

      // Load the full club with NO rarity filter so every card is included,
      // not just evo-eligible rarities. Pass null explicitly.
      console.log("[FCEvoExport] Loading full club (no rarity filter)…");
      try {
        await window.FCEvo.loadClub(null);
      } catch (e) {
        console.warn("[FCEvoExport] loadClub failed:", e.message || e);
      }

      // Collect players from all available sources and deduplicate by item id.
      const seen  = new Set();
      const all   = [];

      function addItems(items) {
        if (!Array.isArray(items)) return;
        for (const it of items) {
          if (!it || it.id == null) continue;
          let isPlayer = false;
          try { isPlayer = !!it.isPlayer(); } catch (_) { isPlayer = !!it.playerInfo; }
          if (!isPlayer) continue;
          if (seen.has(it.id)) continue;
          seen.add(it.id);
          all.push(it);
        }
      }

      // 1. Items loaded by loadClub (stored in state.clubItems via clubPlayers())
      addItems(window.FCEvo.clubPlayers());

      // 2. Fallback: live club repository (may have more / different piles)
      try {
        const club = window.repositories && window.repositories.Item && window.repositories.Item.getClub();
        if (club) {
          addItems(club.items || (club.getItems ? club.getItems() : []));
        }
      } catch (_) {}

      // 3. Active squad (players currently slotted in the 11)
      try {
        const sq = (window.repositories && window.repositories.Squad &&
                    (window.repositories.Squad.getActiveSquad
                      ? window.repositories.Squad.getActiveSquad()
                      : window.repositories.Squad.activeSquad));
        if (sq) {
          const sqPlayers = sq.getPlayers ? sq.getPlayers() : (sq.players || []);
          addItems(sqPlayers.filter(Boolean));
        }
      } catch (_) {}

      // 4. Any other piles (development, reserves, SBC storage)
      try {
        const ItemPile = window.ItemPile || {};
        const pileKeys = ["DEVELOPMENT", "RESERVES", "SBC_STORAGE", "ACTIVE_SQUAD"];
        const repo = window.repositories && window.repositories.Item;
        if (repo) {
          for (const key of pileKeys) {
            try {
              const pileId = ItemPile[key];
              if (pileId == null) continue;
              const pile = repo.getByPile ? repo.getByPile(pileId) : null;
              if (pile) addItems(Array.isArray(pile) ? pile : (pile.items || []));
            } catch (_) {}
          }
        }
      } catch (_) {}

      if (!all.length) throw new Error("No players found. Make sure you are logged in and on the EA FC 26 web app.");
      console.log(`[FCEvoExport] ${all.length} unique players collected across all piles.`);
      return all;
    }


    // ── Core run ───────────────────────────────────────────────────────────
    let lastResult = null;

    async function run(format = "both") {
      let players;
      try { players = await ensureClub(); }
      catch (e) {
        console.error("[FCEvoExport]", e.message);
        // Return a plain error summary (must be JSON-serializable for executeScript)
        return { ok: false, error: e.message };
      }

      const traitMap = buildTraitMap();
      const data = players.map(it => {
        try { return extractPlayer(it, traitMap); }
        catch (e) { console.warn("[FCEvoExport] Skipped:", e); return null; }
      }).filter(Boolean);

      data.sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
      lastResult = data;

      const stamp = ts();
      const formats = [];

      if (format === "json" || format === "both") {
        download(JSON.stringify(data, null, 2), `fc26-club-${stamp}.json`, "application/json");
        formats.push("json");
        console.log(`[FCEvoExport] ✅ JSON → fc26-club-${stamp}.json`);
      }
      if (format === "csv" || format === "both") {
        download(toCSV(data), `fc26-club-${stamp}.csv`, "text/csv");
        formats.push("csv");
        console.log(`[FCEvoExport] ✅ CSV  → fc26-club-${stamp}.csv`);
      }

      // Return a concise summary (JSON-serializable, safe to pass back to popup)
      return { ok: true, count: data.length, formats, filename: `fc26-club-${stamp}` };
    }

    async function preview(data) {
      if (!data) {
        try {
          const ps = await ensureClub();
          const tm = buildTraitMap();
          data = ps.map(it => { try { return extractPlayer(it, tm); } catch (_) { return null; } }).filter(Boolean);
        } catch (e) { console.error("[FCEvoExport]", e.message); return; }
      }
      console.groupCollapsed(`[FCEvoExport] ${data.length} players — top 25`);
      console.table(data.slice(0, 25).map(p => ({
        "Name":    p.name,
        "OVR":     p.rating,
        "Pos":     p.preferredPos,
        "Foot":    p.preferredFoot ?? "—",
        "SM★":     p.skillMoves  ?? "—",
        "WF★":     p.weakFoot    ?? "—",
        "H(cm)":   p.height ?? "—",
        "W(kg)":   p.weight ?? "—",
        "Age":     p.age    ?? "—",
        "ATT WR":  p.attackWorkRate  ?? "—",
        "DEF WR":  p.defenseWorkRate ?? "—",
        "PAC/DIV": p.faceStats.pac ?? p.faceStats.div ?? "—",
        "SHO/HAN": p.faceStats.sho ?? p.faceStats.han ?? "—",
        "PAS/KIC": p.faceStats.pas ?? p.faceStats.kic ?? "—",
        "DRI/REF": p.faceStats.dri ?? p.faceStats.ref ?? "—",
        "DEF/SPD": p.faceStats.def ?? p.faceStats.spd ?? "—",
        "PHY/POS": p.faceStats.phy ?? p.faceStats.pos ?? "—",
        "Finishing":  p.subAttributes.finishing  ?? "—",
        "ShotPower":  p.subAttributes.shotPower  ?? "—",
        "LongShots":  p.subAttributes.longShots  ?? "—",
        "Penalties":  p.subAttributes.penalties  ?? "—",
        "Heading":    p.subAttributes.heading     ?? "—",
        "PS+":  p.playStylesPlus.join(", ")  || "—",
        "PS":   p.playStylesBasic.join(", ") || "—",
        "PS+ Slots": `${p.numPlusUsed ?? "?"}/${p.numPlusCap}`,
        "Evolved": p.isEvolved,
      })));
      console.groupEnd();
    }

    function find(q) {
      const lq = q.toLowerCase();
      return (lastResult || []).filter(p => p.name.toLowerCase().includes(lq));
    }

    function inspect(q) {
      const hits = find(q);
      if (!hits.length) { console.warn("[FCEvoExport] No player matching:", q); return null; }
      const p = hits[0];
      console.group(`[FCEvoExport] ${p.name} (${p.rating} OVR · ${p.preferredPos})`);
      console.log("Identity:  ", { height: p.height, weight: p.weight, age: p.age, foot: p.preferredFoot, skillMoves: p.skillMoves, weakFoot: p.weakFoot, bodyType: p.bodyType, attackWR: p.attackWorkRate, defWR: p.defenseWorkRate });
      console.log("Face stats:", p.faceStats);
      console.log("Sub-attrs: ", p.subAttributes);
      console.log("PlayStyles:", { plus: p.playStylesPlus, basic: p.playStylesBasic });
      console.log("Evo state: ", { isEvolved: p.isEvolved, canRemove: p.canRemoveEvo, psPlus: `${p.numPlusUsed}/${p.numPlusCap}`, psBasic: `${p.numBasicUsed}/${p.numBasicCap}` });
      console.groupEnd();
      return p;
    }

    return {
      run,
      preview: () => preview(lastResult),
      find,
      inspect,
      get last() { return lastResult; },
    };
  })();

  // Console hint (only shown once, on first injection)
  console.log(
    "%c[FCEvoExport] Loaded\n%c" +
    "  await FCEvoExport.run()        → JSON + CSV\n" +
    "  await FCEvoExport.run('json')  → JSON only\n" +
    "  await FCEvoExport.run('csv')   → CSV only\n" +
    "  await FCEvoExport.preview()    → console.table\n" +
    "  FCEvoExport.inspect('Mbappe')  → one player detail\n" +
    "  FCEvoExport.last               → raw data array",
    "color:#3fb950;font-weight:700",
    "color:#7d8590"
  );
}
