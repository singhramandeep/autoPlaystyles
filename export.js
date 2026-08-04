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
    const CAP_PLUS     = 4;
    const CAP_BASIC    = 8;
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

    // ── Per-player extraction ──────────────────────────────────────────────
    function extractPlayer(it, traitMap) {
      const isGK = safe(() => !!it.isGK());
      const sd   = safe(() => it.getStaticData ? it.getStaticData() : it._staticData) || {};
      const name = sd.name || sd.commonName || safe(() => it.name)
        || [sd.firstName, sd.lastName].filter(Boolean).join(" ") || "Unknown";

      const fn = sd.firstName || "";
      const ln = sd.lastName || "";
      const cn = sd.commonName || "";
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

      // PlayStyles
      const rawPS    = safe(() => it.getPlayStyles()) || [];
      const psPlus   = rawPS.filter(p =>  p.isIcon).map(p => (traitMap[p.traitId] || ("trait_" + p.traitId)) + "+");
      const psBasic  = rawPS.filter(p => !p.isIcon).map(p =>  traitMap[p.traitId] || ("trait_" + p.traitId));
      const numPlus  = safe(() => it.getNumPlusPlayStyles());
      const numBasic = safe(() => it.getNumBasicPlayStyles());
      const capPlus  = Math.max(4, numPlus || 0);
      const capBasic = Math.max(8, numBasic || 0);

      // Positions & Roles
      const prefPos = POS_LABEL[it.preferredPosition] || it.preferredPosition;
      const allPosIds = safe(() => it.possiblePositions) || safe(() => it.getBasePossiblePositions()) || [];
      const allPositions = [...new Set(
        [it.preferredPosition, ...allPosIds].filter(x => x != null).map(id => POS_LABEL[id] || id)
      )];
      const positionRoles = getPositionRoles(allPositions);

      // Club & Nation
      const nationId = safe(() => sd.nationality ?? it.nationality ?? it.nation);
      const teamId = safe(() => it.teamId ?? sd.teamId);
      const leagueId = safe(() => it.leagueId ?? sd.leagueId);

      const countryName = getNationName(nationId) || (nationId != null ? "Nation " + nationId : null);
      const teamName = getTeamName(teamId) || (teamId != null ? "Team " + teamId : null);
      const leagueName = getLeagueName(leagueId) || (leagueId != null ? "League " + leagueId : null);

      // Match Stats & Chem
      const pStats = getPlayerStats(it);
      const chemStyle = getChemStyleName(it);
      const injuryDetails = getInjuryDetails(it);
      const is1stOwner = safe(() => (typeof it.isFirstOwner === "function" ? it.isFirstOwner() : !!it.firstOwner)) || false;

      // Evo
      const isEvolved    = safe(() => !!it.canRemoveEvolution()) || safe(() => !!it.isAcademyGraduateWithStatUpgrade()) || false;
      const canRemoveEvo = safe(() => !!it.canRemoveEvolution()) || false;

      return {
        id: it.id, definitionId: it.definitionId ?? null,
        name, fullName,
        firstName:  sd.firstName  || null,
        lastName:   sd.lastName   || null,
        commonName: sd.commonName || null,
        rating:  it.rating  ?? null,
        rareflag: it.rareflag ?? null,
        preferredPos: prefPos, allPositions, positionRoles, isGK: !!isGK,
        // Match & Chem
        chemistryStyle: chemStyle,
        gamesPlayed: pStats.games,
        goalsScored: pStats.goals,
        assists: pStats.assists,
        yellowCards: pStats.yellowCards,
        redCards: pStats.redCards,
        injuryDetails,
        is1stOwner,
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
        // Club & Bio
        countryName, nationality: nationId ?? null,
        leagueName, leagueId: leagueId ?? null,
        teamName, teamId: teamId ?? null,
        untradeable: safe(() => (typeof it.isUntradeable === "function" ? !!it.isUntradeable() : (it.untradeable ?? it._untradeable ?? false))) ?? null,
        // Stats
        faceStats,
        subAttributes,
        // PlayStyles
        playStylesPlus: psPlus, playStylesBasic: psBasic,
        allPlayStyles: [...psPlus, ...psBasic],
        numPlusUsed: numPlus ?? null, numPlusCap: capPlus,
        numBasicUsed: numBasic ?? null, numBasicCap: capBasic,
        psRoomPlus:  numPlus  != null ? Math.max(0, capPlus  - numPlus)  : null,
        psRoomBasic: numBasic != null ? Math.max(0, capBasic - numBasic) : null,
        // Evo
        isEvolved, canRemoveEvo,
      };
    }

    // ── CSV builder ────────────────────────────────────────────────────────
    function toCSV(players) {
      if (!players.length) return "";
      const headers = [
        "id","name","fullName","rating","rareflag","preferredPos","allPositions","positionRoles","isGK",
        "chemistryStyle","gamesPlayed","goalsScored","assists","yellowCards","redCards","injuryDetails",
        "countryName","leagueName","teamName","untradeable","is1stOwner",
        "height","weight","age","birthdate","preferredFoot","skillMoves","weakFoot",
        "attackWorkRate","defenseWorkRate","bodyType",
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
      const rows = players.map(p => {
        const posRolesStr = p.positionRoles ? p.positionRoles.map(r => `${r.pos}:${r.roles.join("+")}`).join(";") : "";
        return headers.map(h => {
          if (ALL_FACE.includes(h))   return esc(p.faceStats ? p.faceStats[h] : null);
          if (SUB_ORDER.includes(h))  return esc(p.subAttributes ? p.subAttributes[h] : null);
          if (h === "allPositions")   return esc(p.allPositions);
          if (h === "positionRoles")  return esc(posRolesStr);
          if (h === "playStylesPlus") return esc(p.playStylesPlus);
          if (h === "playStylesBasic")return esc(p.playStylesBasic);
          return esc(p[h]);
        }).join(",");
      });
      return [headers.join(","), ...rows].join("\n");
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

    // ── Download helpers ───────────────────────────────────────────────────
    function downloadBlob(blob, filename) {
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

    function download(content, filename, mime) {
      downloadBlob(new Blob([content], { type: mime }), filename);
    }

    function ts() { return new Date().toISOString().slice(0,16).replace(/[T:]/g,"-"); }

    // ── Club loader ────────────────────────────────────────────────────────
    // Loads ALL club players (no rarity filter) and merges in active squad
    // players, which may live in a separate item pile.
    async function ensureClub() {
      if (!window.FCEvo) {
        throw new Error("FCEvo not ready — make sure you're on the EA FC 26 web app and the Evo Helper panel has loaded.");
      }

      // Collect players from all available sources and deduplicate by item id.
      const seen  = new Set();
      const all   = [];

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
          if (!isPlayer(it)) continue;
          if (seen.has(it.id)) continue;
          seen.add(it.id);
          all.push(it);
        }
      }

      // 1. Live club repository (all club players)
      try {
        const club = window.repositories && window.repositories.Item && window.repositories.Item.getClub();
        if (club) {
          addItems(club.items || (club.getItems ? club.getItems() : []));
        }
      } catch (_) {}

      // 2. Evo helper cached players (may be rarity-filtered)
      if (window.FCEvo) {
        try { addItems(window.FCEvo.state.clubItems); } catch (_) {}
        try { addItems(window.FCEvo.clubPlayers()); } catch (_) {}
      }

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

      // 4. All item piles (club, development, reserves, SBC storage, active squad)
      try {
        const ItemPile = window.ItemPile || {};
        const pileKeys = ["CLUB", "DEVELOPMENT", "RESERVES", "SBC_STORAGE", "ACTIVE_SQUAD"];
        const repo = window.repositories && window.repositories.Item;
        if (repo) {
          for (const key of pileKeys) {
            try {
              const pileId = ItemPile[key] ?? (key === "CLUB" ? 7 : null);
              if (pileId == null) continue;
              const pile = repo.getByPile ? repo.getByPile(pileId) : null;
              if (pile) addItems(Array.isArray(pile) ? pile : (pile.items || []));
            } catch (_) {}
          }
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

      if (format === "excel" || format === "xlsx" || format === "both" || format === "all") {
        const xlsxBlob = createXLSXBlob(data);
        if (xlsxBlob) downloadBlob(xlsxBlob, `fc26-club-${stamp}.xlsx`);
        formats.push("xlsx");
        console.log(`[FCEvoExport] ✅ Excel → fc26-club-${stamp}.xlsx`);
      }
      if (format === "json" || format === "both" || format === "all") {
        download(JSON.stringify(data, null, 2), `fc26-club-${stamp}.json`, "application/json");
        formats.push("json");
        console.log(`[FCEvoExport] ✅ JSON → fc26-club-${stamp}.json`);
      }
      if (format === "csv" || format === "both" || format === "all") {
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
