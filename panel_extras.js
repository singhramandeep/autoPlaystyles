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

    const TRAIT_OFFSET = 301, CAP_PLUS = 4, CAP_BASIC = 8;
    const GH_RARITIES  = new Set([104, 109]);
    const FUTTIES_RARITIES = new Set([70, 78, 128, 140, 141, 142, 143, 144, 145, 146, 169, 171, 172, 173]);

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

    const CHEM_STYLES = {
      250: "Basic", 251: "Sniper", 252: "Finisher", 253: "Deadeye", 254: "Marksman", 255: "Hawk",
      256: "Artist", 257: "Architect", 258: "Powerhouse", 259: "Maestro", 260: "Engine",
      261: "Sentinel", 262: "Guardian", 263: "Gladiator", 264: "Backbone", 265: "Anchor",
      266: "Hunter", 267: "Shadow", 268: "Wall", 269: "Shield", 270: "Cat", 271: "Glove", 272: "GK Basic"
    };
    function getChemStyleName(it) {
      if (!it) return "None";
      const id = it.chemistryStyle ?? it.playStyle ?? it._chemistryStyle;
      if (id != null && CHEM_STYLES[id]) return CHEM_STYLES[id];
      try { if (window.UTLocalizationUtil && typeof window.UTLocalizationUtil.getChemistryStyleName === "function") return window.UTLocalizationUtil.getChemistryStyleName(id); } catch (_) {}
      return id != null ? "Style " + id : "None";
    }
    function getPlayerStats(it) {
      if (!it) return { games: 0, goals: 0, assists: 0, yellowCards: 0, redCards: 0 };
      const st = it.stats || it._stats || it.lifetimeStats || it._itemData || {};
      const games = it.games ?? st.games ?? safe(() => it.getGamesPlayed()) ?? 0;
      const goals = it.goals ?? st.goals ?? safe(() => it.getGoals()) ?? 0;
      const assists = it.assists ?? st.assists ?? safe(() => it.getAssists()) ?? 0;
      const yellowCards = it.yellowCards ?? st.yellowCards ?? st.yellows ?? 0;
      const redCards = it.redCards ?? st.redCards ?? st.reds ?? 0;
      return { games, goals, assists, yellowCards, redCards };
    }
    function getInjuryDetails(it) {
      if (!it) return "Healthy";
      try { if (typeof it.isInjured === "function" && !it.isInjured()) return "Healthy"; } catch (_) {}
      const games = it.injuryGames ?? it._injuryGames ?? 0;
      if (games > 0) return `Injured (${games} match${games > 1 ? "es" : ""})`;
      return "Healthy";
    }
    function getNationName(id) {
      if (id == null) return null;
      try {
        if (window.repositories && window.repositories.Item && window.repositories.Item.getNation) {
          const n = window.repositories.Item.getNation(id);
          if (n && n.name) return n.name;
        }
      } catch (_) {}
      return null;
    }
    function getTeamName(id) {
      if (id == null) return null;
      try {
        if (window.repositories && window.repositories.Item && window.repositories.Item.getTeam) {
          const t = window.repositories.Item.getTeam(id);
          if (t && t.name) return t.name;
        }
      } catch (_) {}
      return null;
    }
    function getLeagueName(id) {
      if (id == null) return null;
      try {
        if (window.repositories && window.repositories.Item && window.repositories.Item.getLeague) {
          const l = window.repositories.Item.getLeague(id);
          if (l && l.name) return l.name;
        }
      } catch (_) {}
      return null;
    }
    const ROLES = {
      "ST": ["Advanced Forward", "Target Forward", "Poacher", "False 9"],
      "RW / LW": ["Inside Forward", "Winger", "Wide Playmaker"],
      "CAM": ["Shadow Striker", "Playmaker", "Classic 10", "Half Winger"],
      "CM": ["Box to Box", "Playmaker", "Deep Lying Playmaker", "Holding", "Half Winger"],
      "RM / LM": ["Inside Forward", "Winger", "Wide Playmaker", "Wide Midfielder"],
      "CDM": ["Holding", "Deep Lying Playmaker", "Box Crasher", "Centre Half", "Wide Half"],
      "RB / LB": ["Fullback", "Wingback", "Falseback", "Inverted Wingback", "Attacking Wingback"],
      "CB": ["Defender", "Stopper", "Wide Back", "Ball Playing Defender"],
      "GK": ["Goalkeeper", "Ball Playing", "Sweeper Keeper"]
    };
    const POS_GROUP_NAME = {
      "GK": "GK", "CB": "CB", "RB": "RB / LB", "LB": "RB / LB", "RWB": "RB / LB", "LWB": "RB / LB",
      "CDM": "CDM", "CM": "CM", "CAM": "CAM", "RM": "RM / LM", "LM": "RM / LM",
      "RW": "RW / LW", "LW": "RW / LW", "ST": "ST", "CF": "ST"
    };
    function getPositionRoles(posList) {
      const out = [];
      (posList || []).forEach((posName) => {
        const group = POS_GROUP_NAME[posName] || posName;
        const roles = ROLES[group] || ROLES[posName];
        if (roles) out.push({ pos: posName, roles });
      });
      return out;
    }

    function extractPlayer(it, traitMap) {
      const isGK = safe(() => !!it.isGK());
      const sd   = safe(() => it.getStaticData ? it.getStaticData() : it._staticData) || {};
      const clean = (s) => (s && typeof s === "string" && s.trim() !== "---" && s.trim().toLowerCase() !== "null" ? s.trim() : "");
      const cn = clean(sd.commonName || sd.cname || sd.knownAs || it.commonName || it._commonName || safe(() => typeof it.getCommonName === "function" ? it.getCommonName() : ""));
      const fn = clean(sd.firstName || sd.fname || it.firstName || it._firstName || safe(() => typeof it.getFirstName === "function" ? it.getFirstName() : ""));
      const ln = clean(sd.lastName || sd.lname || it.lastName || it._lastName || safe(() => typeof it.getLastName === "function" ? it.getLastName() : ""));
      const rawName = clean(sd.name || safe(() => it.name) || it._name);
      const name = cn || [fn, ln].filter(Boolean).join(" ") || rawName || "Unknown";
      const fullName = cn ? `${cn} (${[fn, ln].filter(Boolean).join(" ")})`.trim() : ([fn, ln].filter(Boolean).join(" ") || name);

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
      const capPlus  = Math.max(4, numPlus || 0);
      const capBasic = Math.max(8, numBasic || 0);

      const prefPos = POS_LABEL[it.preferredPosition] || it.preferredPosition;
      const allPosIds = safe(() => it.possiblePositions) || safe(() => it.getBasePossiblePositions()) || [];
      const allPositions = [...new Set(
        [it.preferredPosition, ...allPosIds].filter(x => x != null).map(id => POS_LABEL[id] || id)
      )];
      const positionRoles = getPositionRoles(allPositions);

      const nationId = safe(() => sd.nationality ?? it.nationality ?? it.nation);
      const teamId = safe(() => it.teamId ?? sd.teamId);
      const leagueId = safe(() => it.leagueId ?? sd.leagueId);

      const countryName = getNationName(nationId) || (nationId != null ? "Nation " + nationId : null);
      const teamName = getTeamName(teamId) || (teamId != null ? "Team " + teamId : null);
      const leagueName = getLeagueName(leagueId) || (leagueId != null ? "League " + leagueId : null);

      const pStats = getPlayerStats(it);
      const chemStyle = getChemStyleName(it);
      const injuryDetails = getInjuryDetails(it);
      const is1stOwner = safe(() => (typeof it.isFirstOwner === "function" ? it.isFirstOwner() : !!it.firstOwner)) || false;

      const isEvolved    = safe(() => !!it.canRemoveEvolution()) || safe(() => !!it.isAcademyGraduateWithStatUpgrade()) || false;
      const canRemoveEvo = safe(() => !!it.canRemoveEvolution()) || false;

      return {
        id: it.id, definitionId: it.definitionId ?? null,
        name, fullName, firstName: sd.firstName || null, lastName: sd.lastName || null, commonName: sd.commonName || null,
        rating: it.rating ?? null, rareflag: it.rareflag ?? null,
        preferredPos: prefPos, allPositions, positionRoles, isGK: !!isGK,
        chemistryStyle: chemStyle, gamesPlayed: pStats.games, goalsScored: pStats.goals, assists: pStats.assists,
        yellowCards: pStats.yellowCards, redCards: pStats.redCards, injuryDetails, is1stOwner,
        height: it.height ?? sd.height ?? null, weight: it.weight ?? sd.weight ?? null,
        age, birthdate,
        preferredFoot:   FOOT[sd.preferredFoot ?? safe(() => it.foot)] ?? null,
        skillMoves:      sd.skillMoves ?? safe(() => it.skillMoves) ?? null,
        weakFoot:        sd.weakFoot   ?? safe(() => it.weakFoot)   ?? null,
        attackWorkRate:  WORK_RATE[sd.attackWorkRate  ?? safe(() => it.attackWorkRate)]  ?? null,
        defenseWorkRate: WORK_RATE[sd.defenseWorkRate ?? safe(() => it.defenseWorkRate)] ?? null,
        bodyType: BODY_TYPE[sd.bodyType ?? safe(() => it.bodyType)] ?? null,
        countryName, nationality: nationId ?? null,
        leagueName, leagueId: leagueId ?? null,
        teamName, teamId: teamId ?? null,
        untradeable: safe(() => (typeof it.isUntradeable === "function" ? !!it.isUntradeable() : (it.untradeable ?? it._untradeable ?? false))) ?? null,
        faceStats, subAttributes,
        playStylesPlus: psPlus, playStylesBasic: psBasic, allPlayStyles: [...psPlus, ...psBasic],
        numPlusUsed: numPlus ?? null, numPlusCap: capPlus,
        numBasicUsed: numBasic ?? null, numBasicCap: capBasic,
        psRoomPlus:  numPlus  != null ? Math.max(0, capPlus  - numPlus)  : null,
        psRoomBasic: numBasic != null ? Math.max(0, capBasic - numBasic) : null,
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

    function dlFileBlob(blob, filename) {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    function dlFile(content, filename, mime) {
      dlFileBlob(new Blob([content], { type: mime }), filename);
    }

    function tsFmt() { return new Date().toISOString().slice(0,16).replace(/[T:]/g,"-"); }

    // Collect all players from every available source, deduped by id.
    async function gatherAllPlayers() {
      const seen = new Set(), all = [];
      function isPlayer(it) {
        try { if (it.isPlayer && it.isPlayer()) return true; } catch (_) {}
        try { if (it.playerInfo) return true; } catch (_) {}
        try { if (it.getPlayStyles && typeof it.getPlayStyles === "function") return true; } catch (_) {}
        try { if (it.rating != null && it.preferredPosition != null) return true; } catch (_) {}
        return false;
      }
      function addItems(items) {
        if (!Array.isArray(items)) return;
        for (const it of items) {
          if (!it || it.id == null) continue;
          if (!isPlayer(it) || seen.has(it.id)) continue;
          seen.add(it.id); all.push(it);
        }
      }

      // 1. Live club repository (all club players)
      try {
        const club = window.repositories.Item.getClub();
        if (club) addItems(club.items || (club.getItems ? club.getItems() : []));
      } catch (_) {}
      // 2. Evo helper cached players (may be rarity-filtered)
      if (window.FCEvo) {
        try { addItems(window.FCEvo.state.clubItems); } catch (_) {}
        try { addItems(window.FCEvo.clubPlayers()); } catch (_) {}
      }
      // 3. Active squad
      try {
        const sq = window.repositories.Squad.getActiveSquad
          ? window.repositories.Squad.getActiveSquad()
          : window.repositories.Squad.activeSquad;
        if (sq) addItems((sq.getPlayers ? sq.getPlayers() : sq.players || []).filter(Boolean));
      } catch (_) {}
      // 4. All item piles (club, development, reserves, SBC, active squad)
      try {
        const IP = window.ItemPile || {}, repo = window.repositories.Item;
        for (const k of ["CLUB","DEVELOPMENT","RESERVES","SBC_STORAGE","ACTIVE_SQUAD"]) {
          try {
            const id = IP[k] ?? (k === "CLUB" ? 7 : null);
            if (id == null) continue;
            const pile = repo.getByPile ? repo.getByPile(id) : null;
            if (pile) addItems(Array.isArray(pile) ? pile : pile.items || []);
          } catch (_) {}
        }
      } catch (_) {}

      // 5. If no players found yet, trigger FCEvo.loadClub() to fetch all players from EA's server
      if (!all.length && window.FCEvo && typeof window.FCEvo.loadClub === "function") {
        try {
          await window.FCEvo.loadClub(null);
          if (window.FCEvo.state && Array.isArray(window.FCEvo.state.clubItems)) {
            addItems(window.FCEvo.state.clubItems);
          }
          if (typeof window.FCEvo.clubPlayers === "function") {
            addItems(window.FCEvo.clubPlayers());
          }
        } catch (_) {}
      }

      return all;
    }

    function createZipBlob(files) {
      const encoder = new TextEncoder();
      const parts = [];
      const cdEntries = [];
      let offset = 0;

      function crc32(bytes) {
        let crc = 0xFFFFFFFF;
        for (let i = 0; i < bytes.length; i++) {
          crc ^= bytes[i];
          for (let j = 0; j < 8; j++) {
            crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
          }
        }
        return (crc ^ 0xFFFFFFFF) >>> 0;
      }

      files.forEach((f) => {
        const nameBytes = encoder.encode(f.name);
        const dataBytes = encoder.encode(f.data);
        const crc = crc32(dataBytes);
        const len = dataBytes.length;

        const lh = new Uint8Array(30 + nameBytes.length);
        const dv = new DataView(lh.buffer);
        dv.setUint32(0, 0x04034b50, true);
        dv.setUint16(4, 20, true);
        dv.setUint16(6, 0, true);
        dv.setUint16(8, 0, true);
        dv.setUint16(10, 0, true);
        dv.setUint16(12, 0, true);
        dv.setUint32(14, crc, true);
        dv.setUint32(18, len, true);
        dv.setUint32(22, len, true);
        dv.setUint16(26, nameBytes.length, true);
        dv.setUint16(28, 0, true);
        lh.set(nameBytes, 30);

        parts.push(lh);
        parts.push(dataBytes);

        cdEntries.push({ nameBytes, crc, len, offset });
        offset += lh.length + len;
      });

      const cdStart = offset;

      cdEntries.forEach((e) => {
        const cdh = new Uint8Array(46 + e.nameBytes.length);
        const dv = new DataView(cdh.buffer);
        dv.setUint32(0, 0x02014b50, true);
        dv.setUint16(4, 20, true);
        dv.setUint16(6, 20, true);
        dv.setUint16(8, 0, true);
        dv.setUint16(10, 0, true);
        dv.setUint16(12, 0, true);
        dv.setUint16(14, 0, true);
        dv.setUint32(16, e.crc, true);
        dv.setUint32(20, e.len, true);
        dv.setUint32(24, e.len, true);
        dv.setUint16(28, e.nameBytes.length, true);
        dv.setUint16(30, 0, true);
        dv.setUint16(32, 0, true);
        dv.setUint16(34, 0, true);
        dv.setUint16(36, 0, true);
        dv.setUint32(38, 0, true);
        dv.setUint32(42, e.offset, true);
        cdh.set(e.nameBytes, 46);

        parts.push(cdh);
        offset += cdh.length;
      });

      const cdSize = offset - cdStart;

      const eocd = new Uint8Array(22);
      const dv = new DataView(eocd.buffer);
      dv.setUint32(0, 0x06054b50, true);
      dv.setUint16(4, 0, true);
      dv.setUint16(6, 0, true);
      dv.setUint16(8, cdEntries.length, true);
      dv.setUint16(10, cdEntries.length, true);
      dv.setUint32(12, cdSize, true);
      dv.setUint32(16, cdStart, true);
      dv.setUint16(20, 0, true);

      parts.push(eocd);

      return new Blob(parts, { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    }

    function createXLSXBlob(players) {
      if (!players || !players.length) return null;

      const headers = [
        "id","name","fullName","rating","rareflag","preferredPos","allPositions","positionRoles","isGK",
        "chemistryStyle","gamesPlayed","goalsScored","assists","yellowCards","redCards","injuryDetails",
        "countryName","leagueName","teamName","untradeable","is1stOwner",
        "height","weight","age","birthdate","preferredFoot","skillMoves","weakFoot",
        "attackWorkRate","defenseWorkRate","bodyType",
        ...ALL_FACE, ...SUB_ORDER,
        "playStylesPlus","playStylesBasic",
        "numPlusUsed","numPlusCap","numBasicUsed","numBasicCap",
        "psRoomPlus","psRoomBasic","isEvolved","canRemoveEvo","definitionId"
      ];

      const xmlEsc = (v) => {
        if (v == null) return "";
        const s = Array.isArray(v) ? v.join(", ") : String(v);
        return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
      };

      const colName = (n) => {
        let s = "";
        while (n >= 0) {
          s = String.fromCharCode((n % 26) + 65) + s;
          n = Math.floor(n / 26) - 1;
        }
        return s;
      };

      let sheetRowsXml = `<row r="1">` + headers.map((h, i) => {
        return `<c r="${colName(i)}1" t="inlineStr"><is><t>${xmlEsc(h)}</t></is></c>`;
      }).join("") + `</row>`;

      players.forEach((p, rIdx) => {
        const rowNum = rIdx + 2;
        const posRolesStr = p.positionRoles ? p.positionRoles.map(r => `${r.pos}:${r.roles.join("+")}`).join(";") : "";
        const rowVals = headers.map(h => {
          if (ALL_FACE.includes(h))    return p.faceStats ? p.faceStats[h] : null;
          if (SUB_ORDER.includes(h))   return p.subAttributes ? p.subAttributes[h] : null;
          if (h === "allPositions")    return p.allPositions;
          if (h === "positionRoles")   return posRolesStr;
          if (h === "playStylesPlus")  return p.playStylesPlus;
          if (h === "playStylesBasic") return p.playStylesBasic;
          if (h === "untradeable")     return p.untradeable ? "Untradeable" : "Tradeable";
          if (h === "is1stOwner")      return p.is1stOwner ? "Yes" : "No";
          if (h === "isGK")            return p.isGK ? "Yes" : "No";
          if (h === "isEvolved")       return p.isEvolved ? "Yes" : "No";
          if (h === "canRemoveEvo")    return p.canRemoveEvo ? "Yes" : "No";
          return p[h];
        });

        sheetRowsXml += `<row r="${rowNum}">` + rowVals.map((v, cIdx) => {
          const cellRef = colName(cIdx) + rowNum;
          if (typeof v === "number" && !isNaN(v)) {
            return `<c r="${cellRef}"><v>${v}</v></c>`;
          }
          return `<c r="${cellRef}" t="inlineStr"><is><t>${xmlEsc(v)}</t></is></c>`;
        }).join("") + `</row>`;
      });

      const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n  <Default Extension="xml" ContentType="application/xml"/>\n  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>\n  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>\n</Types>`;

      const relsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>\n</Relationships>`;

      const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">\n  <sheets>\n    <sheet name="EA FC 26 Club Players" sheetId="1" r:id="rId1"/>\n  </sheets>\n</workbook>`;

      const workbookRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>\n</Relationships>`;

      const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">\n  <sheetData>${sheetRowsXml}</sheetData>\n</worksheet>`;

      const files = [
        { name: "[Content_Types].xml", data: contentTypesXml },
        { name: "_rels/.rels", data: relsXml },
        { name: "xl/workbook.xml", data: workbookXml },
        { name: "xl/_rels/workbook.xml.rels", data: workbookRelsXml },
        { name: "xl/worksheets/sheet1.xml", data: sheetXml }
      ];

      return createZipBlob(files);
    }

    let lastResult = null;

    async function run(format = "excel") {
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
      if (format === "excel" || format === "xlsx" || format === "both" || format === "all") {
        const xlsxBlob = createXLSXBlob(data);
        if (xlsxBlob) dlFileBlob(xlsxBlob, `fc26-club-${stamp}.xlsx`);
        fmts.push("xlsx");
      }
      if (format === "json" || format === "both" || format === "all") {
        dlFile(JSON.stringify(data, null, 2), `fc26-club-${stamp}.json`, "application/json");
        fmts.push("json");
      }
      if (format === "csv" || format === "both" || format === "all") {
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
        <button class="exp-btn primary" id="fcevo-exp-excel">📊 Excel (.xlsx)</button>
        <button class="exp-btn" id="fcevo-exp-csv">CSV</button>
        <button class="exp-btn" id="fcevo-exp-json">JSON</button>
      </div>
      <div class="exp-status" id="fcevo-exp-status">Exports all club players to Excel / CSV / JSON</div>
    `;
    body.appendChild(sec);

    const btns    = ["fcevo-exp-excel","fcevo-exp-csv","fcevo-exp-json"];
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

    document.getElementById("fcevo-exp-excel").addEventListener("click", () => doExport("excel"));
    document.getElementById("fcevo-exp-csv").addEventListener("click",   () => doExport("csv"));
    document.getElementById("fcevo-exp-json").addEventListener("click",  () => doExport("json"));
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
