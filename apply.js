// ==UserScript==
// @name         PlayStyle Evo Helper — FC26
// @namespace    https://github.com/nezygis/fc26-playstyle-evo-helper
// @version      2.2.1
// @description  Batch-apply PlayStyle / PlayStyle+ evolutions on the EA FC 26 web app. Single mode (one player, hand-pick) or Bulk mode (click players to queue and evolve many at once).
// @author       nezygis
// @homepageURL  https://github.com/nezygis/fc26-playstyle-evo-helper
// @supportURL   https://github.com/nezygis/fc26-playstyle-evo-helper/issues
// @match        https://www.ea.com/*ultimate-team/web-app*
// @match        https://www.ea.com/*/ultimate-team/web-app*
// @run-at       document-idle
// @grant        none
// @downloadURL  https://raw.githubusercontent.com/nezygis/fc26-playstyle-evo-helper/main/fc26-playstyle-evo-helper.user.js
// @updateURL    https://raw.githubusercontent.com/nezygis/fc26-playstyle-evo-helper/main/fc26-playstyle-evo-helper.user.js
// ==/UserScript==

/*
 * PlayStyle Evo Helper — batch-apply PlayStyle / PlayStyle+ evolutions to one player.
 *
 * Install: Tampermonkey → new script → paste this file → save. Open the EA FC 26
 * web app, go to the Evolutions (Academy) hub. A floating panel appears.
 * Usage: search a player (search defaults to evo-eligible rarities), pick a
 * Position+Role and hit ✨ Suggest (or tick evos by hand), then Apply selected.
 *
 * ⚠ Automating the FC web app is against EA's Terms of Service and can get your
 * account banned. Use at your own risk.
 *
 * How it works: drives the web app's OWN service objects (state-safe), not raw HTTP.
 *   services.Academy.addItemToSlot(slotId, itemId)  -> apply an evo
 *   services.Academy.claimSlot(slotId)              -> claim/finish it
 *   repositories.Item.getClub().items               -> club players
 * PlayStyle traitId = rewardId - 301. Caps: 3 PS+ / 8 basic per player.
 * Console helpers on window.FCEvo: scrapeRarities(), clubRaritiesDump(),
 * eligibleRarities(slotId).
 */
(function () {
  "use strict";

  function esc(s) {
    if (s == null) return "";
    return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  const safe = (fn) => { try { return fn(); } catch (_) { return null; } };

  const CAP_PLUS = 4, CAP_BASIC = 8, TRAIT_OFFSET = 301; // traitId = rewardId - 301 (icon classes run 0..35)
  const SETTLE_MS = 700; // wait after an apply/remove for the server to commit before re-fetching (else stale card)
  const REPO_URL = "https://github.com/nezygis/fc26-playstyle-evo-helper";
  // Clicking this opens the raw userscript, which Tampermonkey shows as an install/update page.
  const INSTALL_URL = "https://raw.githubusercontent.com/nezygis/fc26-playstyle-evo-helper/main/fc26-playstyle-evo-helper.user.js";
  // Small JSON I can edit to broadcast a notice without shipping a new build.
  //   { "title": "Heads up", "body": "Your message here.", "url": "https://…", "linkText": "Open" }
  // title/body/link → a centered popup. Blank = nothing shown. (The header update
  // badge is separate — it compares @version, so version lives only in the header.)
  const NOTICE_URL = "https://raw.githubusercontent.com/nezygis/fc26-playstyle-evo-helper/main/notice.json";
  // Anonymous, cookieless load ping (GoatCounter — no PII, no cookies). Uses the
  // no-JS pixel endpoint with our own path so it logs "tool loaded", not EA's pages.
  // Dashboard: https://futhelper.goatcounter.com
  const METRICS_URL = "https://futhelper.goatcounter.com/count";
  // Glory Hunters (104, 109), FUTTIES (70, 78, 128, 140-146, 169, 171-173), and special promo cards can hold up to 4 PS+.
  const GH_RARITIES = new Set([104, 109]);
  const FUTTIES_RARITIES = new Set([70, 78, 128, 140, 141, 142, 143, 144, 145, 146, 169, 171, 172, 173]);
  const SPECIAL_4PS_RARITIES = new Set([
    ...FUTTIES_RARITIES,
    ...GH_RARITIES,
    18, 20, 28, 94, 98, 103, 107, 116, 130, 131
  ]);
  const isGH = (it) => { try { return !!it && GH_RARITIES.has(it.rareflag); } catch (_) { return false; } };
  const isFUTTIES = (it) => { try { return !!it && FUTTIES_RARITIES.has(it.rareflag); } catch (_) { return false; } };
  const is4PSPlusEligible = (it) => {
    if (!it) return false;
    try {
      if (isFUTTIES(it) || isGH(it)) return true;
      if (SPECIAL_4PS_RARITIES.has(it.rareflag)) return true;
      if (capPlus(it) >= 4) return true;
    } catch (_) {}
    return false;
  };

  // Helper functions for inspecting PlayStyles on player entities
  const numPlus = (it) => {
    if (!it) return null;
    try { if (typeof it.getNumPlusPlayStyles === "function") return it.getNumPlusPlayStyles(); } catch (_) {}
    try {
      const ps = typeof it.getPlayStyles === "function" ? it.getPlayStyles() : (it._playStyles || []);
      if (Array.isArray(ps)) return ps.filter((p) => p && (p.isIcon || p.isPlus)).length;
    } catch (_) {}
    return null;
  };
  const numBasic = (it) => {
    if (!it) return null;
    try { if (typeof it.getNumBasicPlayStyles === "function") return it.getNumBasicPlayStyles(); } catch (_) {}
    try {
      const ps = typeof it.getPlayStyles === "function" ? it.getPlayStyles() : (it._playStyles || []);
      if (Array.isArray(ps)) return ps.filter((p) => p && !p.isIcon && !p.isPlus).length;
    } catch (_) {}
    return null;
  };

  // Dynamically inspect max allowed PS+ and basic PlayStyles per player item
  const capPlus = (it) => {
    if (!it) return 4;
    try { if (typeof it.getMaxPlusPlayStyles === "function") { const m = it.getMaxPlusPlayStyles(); if (m && m > 0) return m; } } catch (_) {}
    try { if (typeof it.getMaxPlayStyles === "function") { const m = it.getMaxPlayStyles(); if (m && m > 0) return m; } } catch (_) {}
    try { if (it.maxPlusPlayStyles != null && +it.maxPlusPlayStyles > 0) return +it.maxPlusPlayStyles; } catch (_) {}
    let curPlus = 0;
    try { const n = numPlus(it); if (n != null) curPlus = n; } catch (_) {}
    return Math.max(4, curPlus);
  };
  const capBasic = (it) => {
    if (!it) return 8;
    try { if (typeof it.getMaxBasicPlayStyles === "function") { const m = it.getMaxBasicPlayStyles(); if (m && m > 0) return m; } } catch (_) {}
    try { if (it.maxBasicPlayStyles != null && +it.maxBasicPlayStyles > 0) return +it.maxBasicPlayStyles; } catch (_) {}
    let curBasic = 0;
    try { const n = numBasic(it); if (n != null) curBasic = n; } catch (_) {}
    return Math.max(8, curBasic);
  };

  // Catalog: n=name, s=slotId, r=rewardId(=traitId+301), g=gk-only
  const PS = [{"n":"Finesse Shot","s":2141,"r":301,"g":0},{"n":"Far Throw","s":2142,"r":331,"g":1},{"n":"Enforcer","s":2143,"r":330,"g":0},{"n":"Intercept","s":2144,"r":317,"g":0},{"n":"Whipped Pass","s":2145,"r":313,"g":0},{"n":"Long Ball Pass","s":2146,"r":311,"g":0},{"n":"Incisive Pass","s":2147,"r":309,"g":0},{"n":"Deflector","s":2148,"r":336,"g":1},{"n":"Quick Step","s":2149,"r":326,"g":0},{"n":"Trickster","s":2150,"r":324,"g":0},{"n":"Slide Tackle","s":2151,"r":319,"g":0},{"n":"Aerial Fortress","s":2152,"r":320,"g":0},{"n":"Tiki Taka","s":2153,"r":312,"g":0},{"n":"Gamechanger","s":2154,"r":308,"g":0},{"n":"Chip Shot","s":2155,"r":302,"g":0},{"n":"Cross Claimer","s":2156,"r":333,"g":1},{"n":"Bruiser","s":2157,"r":329,"g":0},{"n":"Precision Header","s":2158,"r":305,"g":0},{"n":"Acrobatic","s":2159,"r":306,"g":0},{"n":"Long Throw","s":2160,"r":328,"g":0},{"n":"Press Proven","s":2161,"r":325,"g":0},{"n":"Block","s":2162,"r":316,"g":0},{"n":"Pinged Pass","s":2163,"r":310,"g":0},{"n":"Inventive","s":2164,"r":314,"g":0},{"n":"Power Shot","s":2165,"r":303,"g":0},{"n":"1v1 Close Down","s":2166,"r":334,"g":1},{"n":"Relentless","s":2167,"r":327,"g":0},{"n":"Rapid","s":2168,"r":322,"g":0},{"n":"Jockey","s":2169,"r":315,"g":0},{"n":"Anticipate","s":2170,"r":318,"g":0},{"n":"Low Driven Shot","s":2171,"r":307,"g":0},{"n":"Dead Ball","s":2172,"r":304,"g":0},{"n":"Far Reach","s":2173,"r":335,"g":1},{"n":"Footwork","s":2174,"r":332,"g":1},{"n":"Technical","s":2175,"r":321,"g":0},{"n":"First Touch","s":2176,"r":323,"g":0}];
  const PSP = [{"n":"Far Reach+","s":2181,"r":335,"g":1},{"n":"Technical+","s":2184,"r":321,"g":0},{"n":"Intercept+","s":2185,"r":317,"g":0},{"n":"Tiki Taka+","s":2186,"r":312,"g":0},{"n":"Low Driven Shot+","s":2187,"r":307,"g":0},{"n":"Footwork+","s":2188,"r":332,"g":1},{"n":"Jockey+","s":2191,"r":315,"g":0},{"n":"Anticipate+","s":2196,"r":318,"g":0},{"n":"Finesse Shot+","s":2200,"r":301,"g":0},{"n":"Incisive Pass+","s":2203,"r":309,"g":0},{"n":"Quick Step+","s":2210,"r":326,"g":0},{"n":"Rapid+","s":2211,"r":322,"g":0},{"n":"Pinged Pass+","s":2213,"r":310,"g":0},{"n":"Bruiser+","s":2189,"r":329,"g":0},{"n":"Relentless+","s":2183,"r":327,"g":0},{"n":"Long Ball Pass+","s":2192,"r":311,"g":0},{"n":"Inventive+","s":2197,"r":314,"g":0},{"n":"Cross Claimer+","s":2198,"r":333,"g":1},{"n":"First Touch+","s":2201,"r":323,"g":0},{"n":"1v1 Close Down+","s":2204,"r":334,"g":1},{"n":"Trickster+","s":2206,"r":324,"g":0},{"n":"Press Proven+","s":2207,"r":325,"g":0},{"n":"Block+","s":2212,"r":316,"g":0},{"n":"Gamechanger+","s":2214,"r":308,"g":0},{"n":"Deflector+","s":2215,"r":336,"g":1},{"n":"Power Shot+","s":2216,"r":303,"g":0},{"n":"Enforcer+","s":2182,"r":330,"g":0},{"n":"Chip Shot+","s":2190,"r":302,"g":0},{"n":"Acrobatic+","s":2193,"r":306,"g":0},{"n":"Dead Ball+","s":2194,"r":304,"g":0},{"n":"Slide Tackle+","s":2195,"r":319,"g":0},{"n":"Long Throw+","s":2199,"r":328,"g":0},{"n":"Aerial Fortress+","s":2202,"r":320,"g":0},{"n":"Far Throw+","s":2205,"r":331,"g":1},{"n":"Whipped Pass+","s":2208,"r":313,"g":0},{"n":"Precision Header+","s":2209,"r":305,"g":0}];
  PS.forEach((x) => (x.kind = "PS"));
  PSP.forEach((x) => (x.kind = "PS+"));
  // Sort both grids into one shared order (alphabetical by base name) so every
  // playstyle sits in the same cell on the PlayStyle and PlayStyle+ tabs.
  const baseName = (x) => x.n.replace(/\+$/, "");
  const byBaseName = (a, b) => baseName(a).localeCompare(baseName(b));
  PS.sort(byBaseName);
  PSP.sort(byBaseName);
  const ALL = PS.concat(PSP);
  // Glory Hunters "4th PS+" reward evos: account-specific Academy slots (category 9,
  // slotName "GH 4th <PlayStyle>+"). Loaded live on demand — one-time consumables
  // with duplicates per playstyle, so the grid dedupes by playstyle.
  const GH = []; // {n, s(slotId), r(rewardId), kind:"PS+", g:0, gh:true}
  let ghLoaded = false, ghLoading = false, ghLoadPromise = null;
  // EA groups PlayStyles into these six categories in the in-game UI; the grid
  // mirrors that grouping (and order) so it matches the player's mental model.
  const CAT_ORDER = ["Finishing", "Passing", "Defending", "Ball Control", "Physical", "Goalkeeping"];
  const CAT_OF = {
    "Finesse Shot": "Finishing", "Chip Shot": "Finishing", "Power Shot": "Finishing", "Dead Ball": "Finishing",
    "Precision Header": "Finishing", "Acrobatic": "Finishing", "Low Driven Shot": "Finishing", "Gamechanger": "Finishing",
    "Incisive Pass": "Passing", "Pinged Pass": "Passing", "Long Ball Pass": "Passing", "Tiki Taka": "Passing",
    "Whipped Pass": "Passing", "Inventive": "Passing",
    "Jockey": "Defending", "Block": "Defending", "Intercept": "Defending", "Anticipate": "Defending",
    "Slide Tackle": "Defending", "Aerial Fortress": "Defending",
    "Technical": "Ball Control", "Rapid": "Ball Control", "First Touch": "Ball Control", "Trickster": "Ball Control", "Press Proven": "Ball Control",
    "Quick Step": "Physical", "Relentless": "Physical", "Long Throw": "Physical", "Bruiser": "Physical", "Enforcer": "Physical",
    "Far Throw": "Goalkeeping", "Footwork": "Goalkeeping", "Cross Claimer": "Goalkeeping", "1v1 Close Down": "Goalkeeping",
    "Far Reach": "Goalkeeping", "Deflector": "Goalkeeping",
  };
  const traitName = {}; // traitId -> display name (base name, no '+')
  PS.forEach((x) => (traitName[x.r - TRAIT_OFFSET] = x.n));

  // Recommended playstyles per position/role. Top 4 -> PS+, rest -> base (up to 8 basic, total 12).
  const ROLES = {"ST":{"Advanced Forward":["Finesse Shot","Low Driven Shot","Rapid","Incisive Pass","Gamechanger","Quick Step","Technical","Tiki Taka","First Touch","Press Proven","Enforcer","Power Shot","Relentless","Chip Shot"],"Target Forward":["Finesse Shot","Enforcer","Precision Header","Low Driven Shot","Incisive Pass","Rapid","First Touch","Gamechanger","Tiki Taka","Press Proven","Pinged Pass","Aerial Fortress","Power Shot","Bruiser"],"Poacher":["Finesse Shot","Low Driven Shot","Rapid","Incisive Pass","First Touch","Gamechanger","Quick Step","Technical","Press Proven","Pinged Pass","Enforcer","Power Shot","Chip Shot","Relentless"],"False 9":["Finesse Shot","Incisive Pass","Low Driven Shot","Gamechanger","Rapid","Tiki Taka","Technical","Pinged Pass","Quick Step","Inventive","First Touch","Press Proven","Relentless","Enforcer"]},"RW / LW":{"Inside Forward":["Finesse Shot","Low Driven Shot","Rapid","Quick Step","Technical","Gamechanger","Incisive Pass","Pinged Pass","Tiki Taka","First Touch","Inventive","Press Proven","Power Shot","Trickster"],"Winger":["Rapid","Finesse Shot","Pinged Pass","Quick Step","Technical","Low Driven Shot","Gamechanger","Incisive Pass","Tiki Taka","First Touch","Inventive","Whipped Pass","Press Proven","Trickster"],"Wide Playmaker":["Finesse Shot","Incisive Pass","Technical","Tiki Taka","Pinged Pass","Rapid","Low Driven Shot","Gamechanger","Press Proven","First Touch","Inventive","Quick Step","Long Ball Pass","Relentless"]},"CAM":{"Shadow Striker":["Finesse Shot","Incisive Pass","Rapid","Low Driven Shot","Technical","Quick Step","Tiki Taka","Gamechanger","First Touch","Pinged Pass","Inventive","Press Proven","Power Shot","Relentless"],"Playmaker":["Finesse Shot","Incisive Pass","Low Driven Shot","Tiki Taka","Pinged Pass","Technical","Gamechanger","First Touch","Press Proven","Quick Step","Inventive","Long Ball Pass","Relentless","Enforcer"],"Classic 10":["Finesse Shot","Incisive Pass","Technical","Tiki Taka","Pinged Pass","Low Driven Shot","Gamechanger","First Touch","Press Proven","Quick Step","Inventive","Long Ball Pass","Trickster","Dead Ball"],"Half Winger":["Incisive Pass","Rapid","Technical","Tiki Taka","Pinged Pass","Gamechanger","Quick Step","First Touch","Press Proven","Inventive","Low Driven Shot","Finesse Shot","Relentless","Intercept"]},"CM":{"Box to Box":["Incisive Pass","Pinged Pass","Intercept","Finesse Shot","Tiki Taka","Bruiser","Anticipate","Quick Step","Technical","Relentless","Press Proven","Long Ball Pass","First Touch","Low Driven Shot"],"Playmaker":["Incisive Pass","Pinged Pass","Finesse Shot","Tiki Taka","Technical","Intercept","Low Driven Shot","Anticipate","First Touch","Quick Step","Inventive","Press Proven","Relentless","Long Ball Pass"],"Deep Lying Playmaker":["Intercept","Pinged Pass","Bruiser","Tiki Taka","Incisive Pass","Anticipate","Jockey","Quick Step","First Touch","Press Proven","Long Ball Pass","Technical","Relentless","Block"],"Holding":["Intercept","Pinged Pass","Bruiser","Tiki Taka","Anticipate","Jockey","Incisive Pass","Quick Step","First Touch","Press Proven","Long Ball Pass","Block","Relentless","Slide Tackle"],"Half Winger":["Pinged Pass","Intercept","Quick Step","Tiki Taka","Incisive Pass","Finesse Shot","Anticipate","Technical","Jockey","Bruiser","Rapid","Press Proven","Relentless","First Touch"]},"RM / LM":{"Inside Forward":["Finesse Shot","Low Driven Shot","Rapid","Quick Step","Technical","Gamechanger","Incisive Pass","Pinged Pass","Tiki Taka","First Touch","Inventive","Press Proven","Power Shot","Trickster"],"Winger":["Rapid","Finesse Shot","Pinged Pass","Quick Step","Technical","Low Driven Shot","Gamechanger","Incisive Pass","Tiki Taka","First Touch","Inventive","Whipped Pass","Press Proven","Trickster"],"Wide Playmaker":["Finesse Shot","Incisive Pass","Technical","Tiki Taka","Pinged Pass","Rapid","Low Driven Shot","Gamechanger","Press Proven","First Touch","Inventive","Quick Step","Long Ball Pass","Relentless"],"Wide Midfielder":["Rapid","Quick Step","Pinged Pass","Tiki Taka","Incisive Pass","Intercept","Anticipate","Relentless","Whipped Pass","Jockey","Press Proven","Bruiser","Technical","First Touch"]},"CDM":{"Holding":["Intercept","Pinged Pass","Bruiser","Tiki Taka","Anticipate","Jockey","Incisive Pass","Quick Step","First Touch","Press Proven","Long Ball Pass","Block","Relentless","Aerial Fortress"],"Deep Lying Playmaker":["Intercept","Pinged Pass","Bruiser","Tiki Taka","Incisive Pass","Anticipate","Jockey","Quick Step","First Touch","Press Proven","Long Ball Pass","Technical","Relentless","Block"],"Box Crasher":["Incisive Pass","Intercept","Pinged Pass","Finesse Shot","Tiki Taka","Quick Step","Bruiser","Anticipate","Technical","Press Proven","Relentless","Long Ball Pass","First Touch","Power Shot"],"Centre Half":["Intercept","Bruiser","Jockey","Anticipate","Quick Step","Block","Tiki Taka","Pinged Pass","Aerial Fortress","Slide Tackle","Long Ball Pass","Press Proven","Relentless","First Touch"],"Wide Half":["Bruiser","Intercept","Quick Step","Jockey","Anticipate","Incisive Pass","Block","Tiki Taka","Pinged Pass","Press Proven","Relentless","Long Ball Pass","Technical","First Touch"]},"RB / LB":{"Fullback":["Bruiser","Intercept","Quick Step","Jockey","Anticipate","Incisive Pass","Block","Tiki Taka","Pinged Pass","Press Proven","Relentless","Rapid","Long Ball Pass","Slide Tackle"],"Wingback":["Intercept","Pinged Pass","Quick Step","Anticipate","Bruiser","Tiki Taka","Jockey","Incisive Pass","Rapid","Relentless","Press Proven","Whipped Pass","Technical","First Touch"],"Falseback":["Intercept","Pinged Pass","Anticipate","Jockey","Tiki Taka","Incisive Pass","Bruiser","Quick Step","First Touch","Press Proven","Long Ball Pass","Technical","Relentless","Block"],"Inverted Wingback":["Incisive Pass","Tiki Taka","Quick Step","Intercept","Anticipate","Rapid","Pinged Pass","Jockey","Press Proven","Relentless","Bruiser","Technical","First Touch","Long Ball Pass"],"Attacking Wingback":["Rapid","Quick Step","Pinged Pass","Tiki Taka","Incisive Pass","Intercept","Anticipate","Relentless","Jockey","First Touch","Bruiser","Whipped Pass","Technical","Press Proven"]},"CB":{"Defender":["Intercept","Bruiser","Anticipate","Jockey","Quick Step","Block","Pinged Pass","Aerial Fortress","Slide Tackle","Tiki Taka","Press Proven","Long Ball Pass","Relentless","First Touch"],"Stopper":["Intercept","Bruiser","Anticipate","Jockey","Quick Step","Block","Slide Tackle","Tiki Taka","Pinged Pass","Relentless","Aerial Fortress","Press Proven","Long Ball Pass","First Touch"],"Wide Back":["Intercept","Anticipate","Quick Step","Jockey","Bruiser","Block","Pinged Pass","Aerial Fortress","Slide Tackle","Tiki Taka","Press Proven","Rapid","Relentless","Long Ball Pass"],"Ball Playing Defender":["Intercept","Bruiser","Anticipate","Jockey","Quick Step","Block","Pinged Pass","Tiki Taka","First Touch","Press Proven","Aerial Fortress","Long Ball Pass","Relentless","Slide Tackle"]},"GK":{"Goalkeeper":["Far Reach","Footwork","1v1 Close Down","Deflector","Cross Claimer","Far Throw","Pinged Pass","Long Ball Pass","Tiki Taka","Press Proven","First Touch","Relentless","Quick Step","Anticipate"],"Ball Playing":["Far Reach","Footwork","1v1 Close Down","Deflector","Cross Claimer","Pinged Pass","Far Throw","Long Ball Pass","Tiki Taka","Press Proven","First Touch","Relentless","Quick Step","Anticipate"],"Sweeper Keeper":["Far Reach","Footwork","1v1 Close Down","Deflector","Cross Claimer","Pinged Pass","Far Throw","Long Ball Pass","Tiki Taka","Press Proven","First Touch","Relentless","Quick Step","Anticipate"]}};
  const psByName = {}, pspByName = {};
  PS.forEach((x) => (psByName[x.n] = x));
  PSP.forEach((x) => (pspByName[x.n.replace(/\+$/, "")] = x)); // keyed by base name

  // ==========================================================================
  // getSubAttributes() returns [{type, rating}]; this type->key map was confirmed
  // by matching every value against the in-game Attributes panel (all 34 line up).
  // Used by the readAttrs() console diagnostic (FCEvo.dumpEntity()).
  const SUB_ATTR = {
    0: "acceleration", 1: "sprintspeed", 2: "agility", 3: "balance", 4: "jumping", 5: "stamina",
    6: "strength", 7: "reactions", 8: "aggression", 9: "composure", 10: "interceptions",
    11: "positioning", 12: "vision", 13: "ballcontrol", 14: "crossing", 15: "dribbling",
    16: "finishing", 17: "fkaccuracy", 18: "heading", 19: "longpassing", 20: "shortpassing",
    21: "defaware", 22: "shotpower", 23: "longshots", 24: "standtackle", 25: "slidetackle",
    26: "volleys", 27: "curve", 28: "penalties",
    29: "gkdiving", 30: "gkhandling", 31: "gkkicking", 32: "gkreflexes", 33: "gkpositioning",
  };
  const FACE_KEYS = ["pace", "shooting", "passing", "dribbling", "defending", "physical"];
  // Read a card's attributes as normalized 0..1 values. Prefers the fine-grained
  // sub-attributes (getSubAttributes); falls back to the 6 face stats, then to none
  // (scoring then uses role consensus only). _coverage reflects what resolved.
  function readAttrs(it) {
    const out = {}, norm = (v) => Math.max(0, Math.min(1, v / 99));
    let subFound = 0;
    try {
      const subs = it && it.getSubAttributes && it.getSubAttributes();
      if (Array.isArray(subs)) subs.forEach((s) => {
        const k = SUB_ATTR[s && s.type];
        if (k && s.rating > 0) { out[k] = norm(s.rating); subFound++; }
      });
    } catch (_) {}
    let faceFound = 0, face = null;
    try { face = it && it.getAttributes && it.getAttributes(); } catch (_) {}
    if (!(face && face.length >= 6)) { try { face = it && it.attributes; } catch (_) {} }
    if (face && face.length >= 6) FACE_KEYS.forEach((k, i) => { const v = +face[i]; if (v > 0) { out[k] = norm(v); faceFound++; } });
    out._sub = subFound > 0;
    out._coverage = subFound > 0 ? Math.min(1, subFound / 29) : faceFound / 6;
    return out;
  }

  // rareflag ids these evos can be applied to (empty = search all club rarities by default).
  const ELIGIBLE_RARITIES = []; // empty = load all club players including FUTTIES, TOTS, TOTY, etc.

  // position id (UTLocalizationUtil) -> role group
  const POS_GROUP = {
    0: "GK", 1: "CB", 2: "RB / LB", 3: "RB / LB", 4: "CB", 5: "CB", 6: "CB", 7: "RB / LB", 8: "RB / LB",
    9: "CDM", 10: "CDM", 11: "CDM", 12: "RM / LM", 13: "CM", 14: "CM", 15: "CM", 16: "RM / LM",
    17: "CAM", 18: "CAM", 19: "CAM", 20: "RW / LW", 21: "ST", 22: "RW / LW", 23: "RW / LW",
    24: "ST", 25: "ST", 26: "ST", 27: "RW / LW",
  };

  // rareflag -> name (EA obfuscates in-app names). Editable via data/rarities.json.
  const RARITIES = {"0":"Common","1":"Rare","3":"Team of the Week","5":"Team of the Year","8":"Star Performer","11":"Team of the Season","12":"Icon","13":"Hero","14":"Knockout Royalty Hero","15":"Knockout Royalty ICON","16":"In Progress Evolution","17":"Evolution","18":"Festival of Football ICON","20":"FoF: Answer the Call","21":"Prime Hero","22":"Ratings Reload","23":"Future Stars Hero","26":"UCL Primetime Hero","27":"UWCL Primetime Hero","28":"Festival of Football: Captains","30":"FUT Birthday","31":"UEFA Women's Champions League Primetime","32":"UEFA Women's Champions League Road to the Final","33":"Thunderstruck","34":"FC Pro Live","35":"Winter Wildcards ICON","36":"Journey of Nations","46":"UEFA Europa League Primetime","49":"Winter Wildcards Hero","50":"UEFA Champions League Primetime","55":"Knockout Royalty","57":"Showdown Upgrade","58":"Showdown","62":"Festival of Football Showdown","63":"Festival of Football Showdown Upgrade","64":"TOTY Honourable Mentions","65":"TOTS Honourable Mentions","69":"World Tour Silver Superstar","70":"FUTTIES","71":"Future Stars","72":"Heroes","76":"Trophy Titans ICON","77":"Trophy Titans Hero","78":"FUTTIES Hero","81":"Classic XI Hero","82":"Unbreakables","83":"Unbreakables Hero","85":"Unbreakables ICON","88":"Unbreakables Evolution","90":"Moments","91":"World Tour","94":"Festival of Football: Star Performer","96":"Joga Bonito","97":"Joga Bonito Hero","98":"Festival of Football: National Pride","103":"Festival of Football: National Pride Red","104":"Festival of Football: Glory Hunters Red","105":"UEFA Conference League Primetime","107":"Festival of Football: Path to Glory","108":"Time Warp","109":"Festival of Football: Glory Hunters","111":"Fantasy FC","112":"Time Warp ICON","116":"Festival of Football: Captains ICON","117":"Winter Wildcards","120":"TOTS Breakthrough","124":"UEFA Champions League Road to the Final","125":"UEFA Europa League Road to the Final","126":"UEFA Conference League Road to the Final","128":"FUTTIES ICON","130":"Festival of Football: Greats of the Game Hero","131":"Festival of Football: Greats of the Game ICON","132":"TOTY HM Evolution","135":"Fantasy FC Hero","140":"FUTTIES Evolution","141":"FUTTIES Premium","142":"FUTTIES Premium Hero","143":"FUTTIES Premium ICON","144":"FUTTIES Re-Release","145":"FUTTIES Batch 1","146":"FUTTIES Batch 2","147":"FUT Birthday EVO","148":"FUT Birthday Hero","149":"FUT Birthday ICON","150":"Cornerstones","151":"Ultimate Scream","155":"Team of the Year ICON","157":"Thunderstruck ICON","168":"Ultimate Scream Hero","169":"FUTTIES Batch 3","170":"Future Stars ICON","171":"FUTTIES Premium Evolution","172":"FUTTIES Red","173":"FUTTIES Pink"};

  const state = {
    item: null, // selected club item entity
    selected: new Set(), // slotIds currently selected
    selectedOrder: [], // ordered slotIds for exact user-defined application sequence
    reserveOrder: [], // slotIds sitting in temporary reserve area
    cursorIndex: 0, // insertion cursor index in selectedOrder (0..selectedOrder.length)
    suggestedSlots: new Set(), // slotIds auto-suggested for the active role/position
    running: false, abort: false,
    rarities: new Set(), // allowed rareflags for club search; empty = all
    trdFilter: "untr", // default: untradeable
    psFilter: "none", // default: 0 PlayStyles
    sortOrder: "cat", // "cat" (by category) | "alpha" (alphabetical A-Z)
    psSearchQ: "", // PlayStyle quick-search query
    clubItems: null, // players we loaded ourselves (full club / eligible rarities)
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const ACAD = () => (window.services && window.services.Academy) || (typeof services !== "undefined" ? services.Academy : null);
  const CLUB = () => { try { return window.repositories.Item.getClub(); } catch (_) { return null; } };

  // Preference persistence via localStorage (keeps the script at @grant none —
  // no Tampermonkey storage privileges needed). All keys namespaced under fcevo:.
  const PREFS_KEY = "fcevo:prefs";
  function loadPrefs() { try { return JSON.parse(localStorage.getItem(PREFS_KEY)) || {}; } catch (_) { return {}; } }
  function savePrefs(patch) {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(Object.assign(loadPrefs(), patch))); } catch (_) {}
  }
  const prefs = loadPrefs();
  // Randomize the gap between applies by ±35% so the cadence isn't a fixed
  // machine-perfect interval. Purely a timing tweak; does not change what runs.
  const jitter = (ms) => Math.max(120, Math.round(ms * (0.65 + Math.random() * 0.7)));

  // --- Engine ---------------------------------------------------------------
  function svcObserve(observable, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      if (!observable || typeof observable.observe !== "function") return reject(new Error("not an observable"));
      let done = false;
      const target = {}; // Unique observer target — NEVER use window
      let timer = null;
      const cleanup = () => {
        if (timer) { clearTimeout(timer); timer = null; }
        try { observable.unobserve(target); } catch (_) {}
      };
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          if (done) return;
          done = true;
          cleanup();
          reject(new Error("Service call timed out"));
        }, timeoutMs);
      }
      observable.observe(target, function (obs, res) {
        if (done) return;
        done = true;
        cleanup();
        if (res && res.success) resolve(res); else reject(res || new Error("call failed"));
      });
    });
  }
  const applyEvo = (slotId, itemId) => svcObserve(ACAD().addItemToSlot(slotId, itemId, undefined));
  const claimEvo = (slotId) => svcObserve(ACAD().claimSlot(slotId));
  // Undo: EA's own "remove evo" — strips the most recently applied PlayStyle upgrade
  // from a player. Repeatable; when the last upgrade is removed the player reverts.
  const removeEvoUpgrade = (itemId) => svcObserve(ACAD().removeEvoUpgrade(itemId));
  const evoRemovalEnabled = () => { try { return !!ACAD().isFeatureEnabled(); } catch (_) { return false; } };
  const canRemoveEvo = (it) => { try { return !!(it && it.canRemoveEvolution && it.canRemoveEvolution()); } catch (_) { return false; } };

  const acadRepo = () => { try { return window.repositories.Academy; } catch (_) { return null; } };
  const getSlot = (id) => { try { return acadRepo().getSlotById(Number(id)); } catch (_) { return null; } };

  // Page the whole Rewards category (id 9) — the GH 4th reward slots are paginated,
  // so we keep requesting pages until the loaded count stops growing — then rebuild
  // the GH catalog from every slot whose name starts "GH 4th ".
  async function loadGHEvos() {
    if (ghLoaded) return GH;
    if (ghLoadPromise) return ghLoadPromise; // concurrent callers await the in-flight load
    ghLoadPromise = (async () => {
      ghLoading = true;
      let completed = false;
      try {
        const S = ACAD(), R = acadRepo();
        // Fetch the Rewards category (id 9) directly — no need for the user to open
        // anything in the web app. Page until the loaded count stops growing.
        if (S && R && S.requestSlotsByCategory) {
          let prev = -1, off = 0; const COUNT = 60;
          completed = true;
          for (let i = 0; i < 12; i++) {
            try { await svcObserve(S.requestSlotsByCategory({ categoryId: 9, offset: off, count: COUNT, sort: 0 })); }
            catch (_) { completed = false; break; } // a page failed -> leave unloaded so it retries
            const n = (R.getSlots() || []).filter((s) => s.categoryId === 9).length;
            if (n === prev) break; // no new slots -> category fully loaded (or cache returned all)
            prev = n; off += COUNT;
          }
        }
        rebuildGH();
        if (completed) ghLoaded = true; // only lock in on a real successful load; else retry next call
      } finally { ghLoading = false; ghLoadPromise = null; }
      return GH;
    })();
    return ghLoadPromise;
  }
  function rebuildGH() {
    const R = acadRepo(); if (!R) return;
    GH.length = 0;
    (R.getSlots() || []).forEach((s) => {
      if (!s.slotName) return;
      const is4th = s.slotName.indexOf("GH 4th ") === 0
        || s.slotName.indexOf("4th ") === 0
        || s.slotName.indexOf("4th PS+") === 0
        || (s.categoryId === 9 && s.slotName.includes("PlayStyle+"));
      if (!is4th) return;
      let r; try { r = s.getAllSlotRewards()[0].type; } catch (_) {}
      if (r == null) return;
      const cleanName = s.slotName.replace(/^(?:GH\s+)?4th\s+(?:PS\+\s+)?/i, "").trim();
      GH.push({ n: cleanName || s.slotName, s: s.id, r, kind: "PS+", g: 0, gh: true });
    });
    GH.forEach((g) => { if (!ALL.includes(g)) ALL.push(g); }); // make GH slots resolvable via byId()
  }
  // Dedupe GH reward slots by playstyle for the grid. Each tile picks a slot the
  // player is actually eligible for — canApplyTo enforces rarity 109 AND already-3-PS+,
  // so a tile only lights up on a Glory Hunters card that has exactly 3 PS+.
  function ghForPlayer(it) {
    const byPs = new Map();
    GH.forEach((g) => { if (!byPs.has(g.n)) byPs.set(g.n, []); byPs.get(g.n).push(g); });
    const out = [];
    byPs.forEach((list) => {
      let chosen = null, applicable = false;
      for (const g of list) {
        const slot = getSlot(g.s);
        // slot.meetsRequirements(player) evaluates the slot's eligibility rules
        // (rarity 109 + already-3-PS+). (item.canApplyTo is a consumable-item method,
        // unrelated to Academy slots — it always returns false for a player.)
        let ok = false; try { ok = !!it && !!slot && slot.meetsRequirements(it); } catch (_) {}
        // Fail closed: these are one-time reward slots, so an unknown availability
        // (missing slot or hasSlottedPlayer throwing) must NOT count as free.
        let free = false; try { free = !!slot && !slot.hasSlottedPlayer(); } catch (_) {}
        if (ok && free) { chosen = g; applicable = true; break; }
        if (!chosen) chosen = g;
      }
      const entry = Object.assign({}, chosen);
      entry.disGH = !applicable; // grey out if not currently applicable to this card
      out.push(entry);
    });
    out.sort((a, b) => baseName(a).localeCompare(baseName(b)));
    return out;
  }

  // Core apply loop for one player. Returns { ok, fail, done } and does NOT own
  // state.running or the post-apply reload — the caller (runBatch / runDispatch)
  // handles those, so it can be reused for both single and multi-player runs.
  async function applySlots(item, slotIds, opts, prefix) {
    const itemId = item.id; let ok = 0, fail = 0; const done = [];
    prefix = prefix || "";
    // Note: Apply sequence follows the user-defined / dragged order in slotIds
    for (let i = 0; i < slotIds.length; i++) {
      if (state.abort) { log(`${prefix}⏹ Aborted.`, "warn"); break; }
      const evo = byId(slotIds[i]);
      const tag = `${prefix}[${i + 1}/${slotIds.length}] ${evo ? evo.n : slotIds[i]}`;
      try {
        const res = await applyEvo(slotIds[i], itemId);
        if (res.data && res.data.isMaximumNumberOfSlotsReached) log(`⚠ ${tag}: max active slots — claim needed`, "warn");
        if (opts.claim) { try { await claimEvo(slotIds[i]); } catch (ce) { log(`   (claim skipped: ${errMsg(ce)})`, "dim"); } }
        ok++; done.push(slotIds[i]); log(`✔ ${tag}`, "ok");
      } catch (e) { fail++; log(`✗ ${tag} — ${errMsg(e)}`, "err"); }
      if (i < slotIds.length - 1 && !state.abort) await sleep(jitter(opts.delayMs));
    }
    return { ok, fail, done };
  }

  // Single-player run (Single mode). Applies to state.item, then refreshes it.
  async function runBatch(slotIds, opts) {
    if (state.running) return;
    if (!state.item) return log("✋ No player selected.", "warn");
    if (!slotIds.length) return log("✋ Nothing selected.", "warn");
    state.running = true; state.abort = false; setRunning(true);
    const itemId = state.item.id;
    log(`▶ ${slotIds.length} evo(s) → ${playerName(state.item)} (delay ${opts.delayMs}ms, claim=${opts.claim})`, "head");
    const { ok, fail, done } = await applySlots(state.item, slotIds, opts);
    // Applied evos are now owned; drop them from the selection so the count and cap
    // projection don't double-count them against the fresh entity.
    done.forEach((s) => {
      state.selected.delete(s);
      state.selectedOrder = state.selectedOrder.filter((x) => x !== s);
    });
    refreshClub();
    try {
      const fresh = freshItemById(itemId);
      if (fresh) {
        state.item = fresh;
        if (state.clubItems && state.clubItems.length) {
          state.clubItems = state.clubItems.map((x) => (x && (x.id === itemId || x.id === Number(itemId)) ? fresh : x));
        }
      }
    } catch (_) {}
    renderPreview(); renderGrid(); updateCount();
    // In-place read can still be stale — EA only reflects an applied evo after a
    // server re-fetch. Reload so the new playstyles actually show.
    if (ok > 0) {
      await sleep(SETTLE_MS);
      try { await reloadAndReselect(itemId); } catch (_) {}
      renderPreview(); renderGrid(); updateCount();
    }
    state.running = false; setRunning(false);
    log(`■ Done: ${ok} ok, ${fail} failed.`, "head");
  }

  // Apply entry point for the Run button: apply selected evolutions to the active player.
  async function runDispatch(opts) {
    if (!state.item) return log("✋ No player selected — select a player from the list.", "warn");
    if (!state.selected.size) return log("✋ No evolutions selected — select playstyles to apply.", "warn");
    
    // Preserve user-defined order in state.selectedOrder
    const ordered = state.selectedOrder.filter((s) => state.selected.has(s));
    state.selected.forEach((s) => { if (!ordered.includes(s)) ordered.push(s); });
    return runBatch(ordered, opts);
  }

  // Mirror what the app's own academy flow does after an apply, so views pick up
  // the change without a page reload (the addItemToSlot service already updated
  // the club/squad item entities).
  function refreshClub() {
    try {
      const P = window.ItemPile || {};
      // Mark the club AND squad-side piles dirty so every view (club list, Active
      // Squad, player menus) re-fetches — not just the club grid.
      const piles = [P.CLUB != null ? P.CLUB : 7, P.ACTIVE_SQUAD, P.DEVELOPMENT, P.RESERVES, P.SBC_STORAGE]
        .filter((v) => v != null);
      piles.forEach((p) => { try { window.repositories.Item.setDirty(p); } catch (_) {} });
      window.repositories.Academy.requiresHubCall = true;
    } catch (_) {}
  }
  const CODE = { 458: "captcha required", 460: "ineligible (already has it, maxed, or rarity/OVR not allowed)", 461: "permission denied", 426: "feature disabled", 470: "not enough currency" };
  function errMsg(e) {
    if (!e) return "?";
    const code = (e.error && e.error.code) || e.status;
    if (code && CODE[code]) return `${code} — ${CODE[code]}`;
    if (e.error && e.error.message) return `${e.error.code || ""} ${e.error.message}`.trim();
    return code ? "status=" + code : (e.message || String(e));
  }
  const byId = (s) => {
    try {
      return ALL.find((x) => x.s === s) || (state.ghEvos && state.ghEvos.find((x) => x.s === s));
    } catch (_) { return null; }
  };
  function getEvoKind(slotId) {
    try {
      const e = byId(slotId);
      if (e && e.kind) return e.kind;
      if (slotId >= 2181) return "PS+";
      if (slotId >= 2141) return "PS";
    } catch (_) {}
    return "PS";
  }

  // --- Player helpers -------------------------------------------------------
  // Memoized: the source array reference + length change whenever the club is
  // (re)loaded, so this recomputes exactly when it needs to and is otherwise free
  // for the many render paths that call it per keystroke.
  let _cpSrc, _cpLen = -1, _cpOut = null;
  function clubPlayers() {
    // Prefer the items we loaded ourselves (full / eligible); fall back to whatever
    // the app has cached (usually just the active squad).
    let items = state.clubItems;
    if (!items || !items.length) { const c = CLUB(); items = (c && (c.items || (c.getItems ? c.getItems() : []))) || []; }
    items = items || [];
    if (items === _cpSrc && items.length === _cpLen && _cpOut) return _cpOut;
    _cpOut = items.filter((it) => { try { return it && it.isPlayer && it.isPlayer(); } catch (_) { return false; } });
    _cpSrc = items; _cpLen = items.length;
    return _cpOut;
  }
  // Build a club search criteria (UTSearchCriteriaDTO), optionally rarity-filtered.
  function makeClubCriteria(offset, count, rarities) {
    const Ctor = window.UTSearchCriteriaDTO;
    if (!Ctor) return null;
    const c = new Ctor();
    try { c.type = (window.SearchType && window.SearchType.PLAYER) || "player"; } catch (_) {}
    try { c.count = count; } catch (_) {}
    try { c.offset = offset; } catch (_) {}
    if (rarities && rarities.length) { try { c.rarities = rarities.slice(); } catch (_) {} }
    return c;
  }
  function setClubStatus(text, cls) {
    try {
      if (els && els.clubstat) { els.clubstat.textContent = text; els.clubstat.className = "clubstat " + (cls || ""); }
    } catch (_) {}
  }
  // The active squad being loaded is a good "app is ready for club searches" signal.
  function getActiveSquad() {
    const R = window.repositories, S = window.services;
    const tries = [
      () => R.Squad && R.Squad.getActiveSquad && R.Squad.getActiveSquad(),
      () => R.Squad && R.Squad.getCurrentSquad && R.Squad.getCurrentSquad(),
      () => S.Squad && S.Squad.getActiveSquad && S.Squad.getActiveSquad(),
      () => R.Squad && R.Squad.activeSquad,
    ];
    for (const f of tries) { try { const sq = f(); if (sq) return sq; } catch (_) {} }
    return null;
  }
  function squadReady() {
    const sq = getActiveSquad();
    if (!sq) return false;
    try { if (typeof sq.getPlayers === "function") return sq.getPlayers().filter(Boolean).length >= 1; } catch (_) {}
    try { if (Array.isArray(sq.players)) return sq.players.filter(Boolean).length >= 1; } catch (_) {}
    return true; // squad object exists even if we can't read players
  }
  // Load club players via paginated search. With `rarities`, only those load.
  // Throws if the FIRST page fails (app not ready) so the caller can retry.
  // The first page is fetched alone (readiness probe); the rest are fetched in
  // parallel batches, which is the bulk of the speedup over one-at-a-time.
  async function loadClub(rarities) {
    if (!(window.services && window.services.Club && window.services.Club.search)) throw new Error("Club service unavailable");
    const PAGE = 91, BATCH = 4;
    const all = [], seen = new Set();
    const add = (res) => {
      const items = (res && res.response && res.response.items) || (res && res.data && res.data.items) || [];
      for (const it of items) { const id = it && it.id; if (id != null && !seen.has(id)) { seen.add(id); all.push(it); } }
      return items.length;
    };
    const fetchPage = (offset) => {
      const crit = makeClubCriteria(offset, PAGE, rarities);
      if (!crit) throw new Error("no UTSearchCriteriaDTO");
      return svcObserve(window.services.Club.search(crit));
    };
    // First page alone so an app-not-ready failure propagates to the retry wrapper.
    let done = add(await fetchPage(0)) < PAGE;
    state.clubItems = all.slice();
    renderList();

    let offset = PAGE, guard = 0;
    while (!done && guard++ < 40) {
      const offsets = [];
      for (let b = 0; b < BATCH; b++) { offsets.push(offset); offset += PAGE; }
      // A mid-run page failure yields null (skip that page, keep the rest) rather
      // than aborting the whole load.
      const results = await Promise.all(offsets.map((o) => fetchPage(o).catch(() => null)));
      for (const res of results) {
        if (!res) continue;
        if (add(res) < PAGE) done = true; // a short/empty page means we hit the end
      }
      state.clubItems = all.slice();
      setClubStatus("Club: loading… " + all.length + " players", "load");
      renderList();
      if (!done) await sleep(80);
    }
    state.clubItems = all;
    if (els.rarpanel) els.rarpanel.dataset.built = ""; // rebuild rarity list with real counts
    renderList();
    return all.length;
  }
  // Retry wrapper: waits/retries until the club search is accepted by the app.
  let clubLoading = false;
  async function startClubLoad(attempt, manual) {
    if (clubLoading && !manual) return;
    clubLoading = true;
    const rarities = null; // load all club players without backend rarity restriction
    setClubStatus("Club: loading…" + (attempt > 1 ? " (retry " + attempt + ")" : ""), "load");
    try {
      const n = await loadClub(rarities);
      if (!n) throw new Error("0 players returned");
      setClubStatus("Club: " + n + " players loaded" + (rarities ? " (eligible)" : "") + " · click to reload", "ok");
      clubLoading = false;
      ensureItemDefinitionsLoaded(state.clubItems).then(() => { try { renderList(); } catch (_) {} });
    } catch (e) {
      clubLoading = false;
      if (attempt < 8) {
        setClubStatus("Club: app not ready, retrying (" + attempt + ")…", "load");
        setTimeout(() => startClubLoad(attempt + 1), 2500);
      } else {
        setClubStatus("Club: load failed (" + errMsg(e) + ") — click to retry", "err");
      }
    }
  }
  function findItemById(id) { return clubPlayers().find((it) => it.id === id || it.id === Number(id)); }
  // After an evo is applied the game mutates the entity it holds authoritatively —
  // the one in the live club repo, and the one behind the open detail panel. Our
  // own loaded snapshot (state.clubItems, from services.Club.search) can be a
  // different, now-stale instance, so pull the freshest copy for this id.
  function freshItemById(id) {
    const nid = Number(id), same = (it) => it && (it.id === id || it.id === nid);
    try { const e = openEntity(); if (same(e)) return e; } catch (_) {}
    try {
      const c = CLUB(), items = c && (c.items || (c.getItems ? c.getItems() : []));
      const hit = items && items.find(same);
      if (hit) return hit;
    } catch (_) {}
    return findItemById(id) || null;
  }
  // Applied evos are only reflected in the local item model after the club is
  // re-fetched from the server (the same effect as the "click to reload" status).
  // Reload, then re-select the player by id so the new playstyles/counts render.
  async function reloadAndReselect(itemId) {
    if (!(window.services && window.services.Club && window.services.Club.search)) return false;
    const rarities = null; // load all club players without backend rarity restriction
    setClubStatus("Club: refreshing after apply…", "load");
    try {
      const n = await loadClub(rarities);
      setClubStatus("Club: " + n + " players loaded" + (rarities ? " (eligible)" : "") + " · click to reload", "ok");
      // Prefer the reloaded club copy; fall back to the live entity (open detail
      // panel / game club repo) in case the evolved card's rarity changed and it
      // fell outside the eligible-rarity filter used for the reload.
      const again = findItemById(itemId) || freshItemById(itemId);
      if (again) state.item = again;
      return true;
    } catch (e) {
      setClubStatus("Club: refresh failed (" + errMsg(e) + ") — click to reload", "err");
      return false;
    }
  }
  // Remove the most recently applied evo upgrade from the selected player, then
  // refresh so the reverted card shows. Repeatable until the player is fully reverted.
  async function removeLastEvo() {
    const it = state.item;
    if (!it) return log("✋ Select a player first.", "warn");
    if (!evoRemovalEnabled()) return log("✋ Evo removal is unavailable.", "warn");
    if (!canRemoveEvo(it)) return log("✋ No evolution to remove on this player.", "warn");
    if (state.running) return;
    const itemId = it.id, name = playerName(it);
    state.running = true; state.abort = false; setRunning(true);
    log(`▶ Removing last evo from ${name}…`, "head");
    try {
      await removeEvoUpgrade(itemId);
      refreshClub();
      await sleep(SETTLE_MS);
      try { await reloadAndReselect(itemId); } catch (_) {}
      renderPreview(); renderGrid(); updateCount();
      log(`■ Removed last evo from ${name}.`, "ok");
    } catch (e) {
      log(`✗ Remove failed — ${errMsg(e)}`, "err");
    }
    state.running = false; setRunning(false);
  }
  function pickStr(...args) {
    const loc = window.glocalization || (window.services && window.services.Localization) || (window.repositories && window.repositories.Localization);
    const isInvalid = (s) => {
      if (!s || typeof s !== "string") return true;
      const str = s.trim();
      if (!str || str === "---" || str.toLowerCase() === "null" || str.toLowerCase() === "undefined" || str.toLowerCase() === "player") return true;
      const low = str.toLowerCase();
      if (low.startsWith("player_name_") || low.startsWith("item_name_") || low.startsWith("card_name_") || low.startsWith("name_") || low.startsWith("pname_") || low.startsWith("missing key") || low.startsWith("key_not_found")) return true;
      return false;
    };
    for (let i = 0; i < args.length; i++) {
      let val = args[i];
      if (val == null) continue;
      if (typeof val === "function") {
        try { val = val(); } catch (_) { continue; }
      }
      if (typeof val === "number" && loc && typeof loc.getText === "function") {
        try {
          const lVal = loc.getText(val);
          if (!isInvalid(lVal)) return lVal.trim();
        } catch (_) {}
      }
      if (typeof val === "string") {
        if (!isInvalid(val)) return val.trim();
        if (/^\d+$/.test(val.trim()) && loc && typeof loc.getText === "function") {
          try {
            const lVal = loc.getText(val.trim());
            if (!isInvalid(lVal)) return lVal.trim();
          } catch (_) {}
        }
      }
    }
    return "";
  }
  const _nameCache = new Map();
  let _loadingDefIds = new Set();

  async function ensureItemDefinitionsLoaded(items) {
    if (!Array.isArray(items) || !items.length) return;
    const missingDefIds = new Set();

    for (const it of items) {
      if (!it) continue;
      const { commonName, firstName, lastName, name } = getPlayerNameParts(it);
      if (!commonName && !firstName && !lastName && !name) {
        const rawId = it.definitionId ?? it._definitionId ?? it.assetId ?? it._assetId ?? it.id;
        if (rawId != null) {
          const num = Number(rawId);
          const baseId = (!isNaN(num) && num > 16777215) ? (num & 0xFFFFFF) : num;
          if (baseId > 0 && !_nameCache.has(baseId) && !_loadingDefIds.has(baseId)) {
            missingDefIds.add(baseId);
          }
        }
      }
    }

    if (!missingDefIds.size) return;
    const missingArr = Array.from(missingDefIds);
    missingArr.forEach((id) => _loadingDefIds.add(id));

    const S = window.services, R = window.repositories;

    try {
      const reqFn = (S && S.Item && typeof S.Item.requestItemDefinitions === "function" && S.Item.requestItemDefinitions.bind(S.Item))
        || (S && S.ItemDefinition && typeof S.ItemDefinition.requestItemDefinitions === "function" && S.ItemDefinition.requestItemDefinitions.bind(S.ItemDefinition))
        || (R && R.ItemDefinition && typeof R.ItemDefinition.fetch === "function" && R.ItemDefinition.fetch.bind(R.ItemDefinition));

      if (reqFn) {
        for (let i = 0; i < missingArr.length; i += 40) {
          const batch = missingArr.slice(i, i + 40);
          try {
            await reqFn(batch);
          } catch (_) {}
        }
      }
    } catch (_) {}

    const remaining = missingArr.filter((id) => {
      const loc = window.glocalization || (S && S.Localization) || (R && R.Localization);
      const locName = loc && typeof loc.getText === "function" ? loc.getText("player_name_" + id) : "";
      const repoDef = R?.ItemDefinition?.get?.(id) || S?.ItemDefinition?.get?.(id);
      return (!locName || locName.startsWith("player_name_")) && !repoDef?.commonName && !repoDef?.name;
    });

    if (remaining.length) {
      await Promise.all(remaining.slice(0, 20).map(async (id) => {
        try {
          const ctrl = new AbortController();
          const tid = setTimeout(() => ctrl.abort(), 3000);
          const res = await fetch(`https://futdb.app/api/players/${id}`, {
            headers: { "Accept": "application/json" },
            signal: ctrl.signal
          }).catch(() => null);
          clearTimeout(tid);
          if (res && res.ok) {
            const data = await res.json().catch(() => null);
            const pName = data?.player?.common_name || data?.player?.name || data?.player?.last_name || data?.name;
            if (pName) _nameCache.set(id, pName);
          }
        } catch (_) {}
      }));
    }

    missingArr.forEach((id) => _loadingDefIds.delete(id));
  }

  function getPlayerNameParts(it) {
    if (!it) return { commonName: "", firstName: "", lastName: "", name: "" };

    let sd = {};
    try {
      if (typeof it.getStaticData === "function") {
        sd = it.getStaticData() || {};
      }
    } catch (_) {}
    if (!sd || !Object.keys(sd).length) {
      sd = it._staticData || it.staticData || {};
    }

    const itemDef = it._itemDefinition || it.itemDefinition || sd._itemDefinition || sd.itemDefinition || it._definition || it.definition || {};
    const playerInfo = it._playerInfo || it.playerInfo || it._playerData || it.playerData || {};

    const rawDefIds = [
      it.definitionId, it._definitionId,
      it.assetId, it._assetId,
      it.baseId, it._baseId,
      it.conceptId, it._conceptId,
      it.resourceId, it._resourceId,
      sd.definitionId, sd._definitionId,
      sd.assetId, sd._assetId,
      sd.baseId, sd._baseId,
      sd.conceptId, sd._conceptId,
      sd.resourceId, sd._resourceId,
      itemDef.definitionId, itemDef._definitionId,
      itemDef.assetId, itemDef._assetId,
      itemDef.baseId, itemDef._baseId,
      itemDef.conceptId, itemDef._conceptId,
      playerInfo.definitionId, playerInfo._definitionId,
      playerInfo.assetId, playerInfo._assetId,
      playerInfo.baseId, playerInfo._baseId,
      typeof it.getDefinitionId === "function" ? (() => { try { return it.getDefinitionId(); } catch (_) {} })() : null,
      typeof it.getAssetId === "function" ? (() => { try { return it.getAssetId(); } catch (_) {} })() : null,
      typeof it.getBaseId === "function" ? (() => { try { return it.getBaseId(); } catch (_) {} })() : null,
      it.id
    ].filter((id) => id != null && id !== 0);

    const candidateDefIds = [];
    const seenDefIds = new Set();
    const addDefId = (id) => {
      if (id == null || id === 0) return;
      const num = Number(id);
      if (!isNaN(num) && num > 0 && !seenDefIds.has(num)) {
        seenDefIds.add(num);
        candidateDefIds.push(num);
      }
    };

    for (const raw of rawDefIds) {
      const num = Number(raw);
      if (!isNaN(num) && num > 0) {
        if (num > 16777215) {
          addDefId(num & 0xFFFFFF);
        }
        addDefId(num);
      }
    }

    let repoDef = null;
    for (const defId of candidateDefIds) {
      try {
        if (window.repositories && window.repositories.ItemDefinition && typeof window.repositories.ItemDefinition.get === "function") {
          repoDef = window.repositories.ItemDefinition.get(defId);
        }
        if (!repoDef && window.services && window.services.ItemDefinition && typeof window.services.ItemDefinition.get === "function") {
          repoDef = window.services.ItemDefinition.get(defId);
        }
        if (!repoDef && window.repositories && window.repositories.Player && typeof window.repositories.Player.get === "function") {
          repoDef = window.repositories.Player.get(defId);
        }
        if (repoDef) break;
      } catch (_) {}
    }

    const cn = pickStr(
      sd.commonName, sd._commonName, sd.cname, sd._cname, sd.knownAs, sd._knownAs, sd.commonNameId, sd._commonNameId,
      itemDef.commonName, itemDef._commonName, itemDef.cname, itemDef._cname, itemDef.knownAs, itemDef._knownAs, itemDef.commonNameId, itemDef._commonNameId,
      playerInfo.commonName, playerInfo._commonName, playerInfo.cname, playerInfo.knownAs,
      repoDef?.commonName, repoDef?._commonName, repoDef?.cname, repoDef?.knownAs, repoDef?.commonNameId,
      it.commonName, it._commonName, it.cname, it._cname, it.knownAs, it._knownAs,
      typeof it.getCommonName === "function" ? () => it.getCommonName() : null
    );

    const fn = pickStr(
      sd.firstName, sd._firstName, sd.fname, sd._fname, sd.firstNameId, sd._firstNameId,
      itemDef.firstName, itemDef._firstName, itemDef.fname, itemDef._fname, itemDef.firstNameId, itemDef._firstNameId,
      playerInfo.firstName, playerInfo._firstName, playerInfo.fname,
      repoDef?.firstName, repoDef?._firstName, repoDef?.fname, repoDef?.firstNameId,
      it.firstName, it._firstName, it.fname, it._fname,
      typeof it.getFirstName === "function" ? () => it.getFirstName() : null
    );

    const ln = pickStr(
      sd.lastName, sd._lastName, sd.lname, sd._lname, sd.lastNameId, sd._lastNameId,
      itemDef.lastName, itemDef._lastName, itemDef.lname, itemDef._lname, itemDef.lastNameId, itemDef._lastNameId,
      playerInfo.lastName, playerInfo._lastName, playerInfo.lname,
      repoDef?.lastName, repoDef?._lastName, repoDef?.lname, repoDef?.lastNameId,
      it.lastName, it._lastName, it.lname, it._lname,
      typeof it.getLastName === "function" ? () => it.getLastName() : null
    );

    const rawName = pickStr(
      sd.name, sd._name, sd.nameId, sd._nameId, sd.shortName, sd._shortName, sd.displayName, sd._displayName,
      itemDef.name, itemDef._name, itemDef.nameId, itemDef._nameId, itemDef.shortName, itemDef._shortName,
      playerInfo.name, playerInfo._name, playerInfo.shortName,
      repoDef?.name, repoDef?._name, repoDef?.nameId, repoDef?.shortName,
      it.name, it._name, it.shortName, it._shortName, it.displayName, it._displayName, it.formattedName, it._formattedName,
      typeof it.getName === "function" ? () => it.getName() : null,
      typeof it.getShortName === "function" ? () => it.getShortName() : null,
      typeof it.getDisplayName === "function" ? () => it.getDisplayName() : null,
      typeof it.getFormattedName === "function" ? () => it.getFormattedName() : null
    );

    let locName = "";
    if (!cn && !fn && !ln && !rawName) {
      const loc = window.glocalization || (window.services && window.services.Localization) || (window.repositories && window.repositories.Localization);
      if (loc && typeof loc.getText === "function") {
        for (const defId of candidateDefIds) {
          locName = pickStr(
            loc.getText("player_name_" + defId),
            loc.getText("item_name_" + defId),
            loc.getText("card_name_" + defId),
            loc.getText("Name_" + defId),
            loc.getText("name_" + defId),
            loc.getText("pname_" + defId),
            loc.getText(defId)
          );
          if (locName) break;
        }
      }
    }

    let cachedName = "";
    const rawId = it.definitionId ?? it._definitionId ?? it.assetId ?? it._assetId ?? it.id;
    if (rawId != null) {
      const num = Number(rawId);
      const baseId = (!isNaN(num) && num > 16777215) ? (num & 0xFFFFFF) : num;
      cachedName = _nameCache.get(baseId) || _nameCache.get(num) || "";
    }

    return { commonName: cn || locName || cachedName, firstName: fn, lastName: ln, name: rawName };
  }
  function playerName(it) {
    if (!it) return "Player";
    const { commonName, firstName, lastName, name } = getPlayerNameParts(it);
    if (commonName) return commonName;
    const full = [firstName, lastName].filter(Boolean).join(" ");
    if (full) return full;
    if (name) return name;

    const rawId = it.definitionId ?? it._definitionId ?? it.assetId ?? it._assetId ?? it.id;
    if (rawId != null) {
      const num = Number(rawId);
      const baseId = (!isNaN(num) && num > 16777215) ? (num & 0xFFFFFF) : rawId;
      return "Player #" + baseId;
    }

    return "Player";
  }
  function rarityName(it) {
    if (!it) return "";
    const rf = it.rareflag ?? it._rareflag ?? (typeof it.getRareflag === "function" ? (() => { try { return it.getRareflag(); } catch (_) {} })() : null);
    if (rf == null) return "";

    if (RARITIES[rf]) return RARITIES[rf];

    try {
      const R = window.repositories, S = window.services;
      const rObj = (R && R.ItemRarity && typeof R.ItemRarity.get === "function" && R.ItemRarity.get(rf))
        || (R && R.Rarity && typeof R.Rarity.get === "function" && R.Rarity.get(rf))
        || (S && S.ItemRarity && typeof S.ItemRarity.get === "function" && S.ItemRarity.get(rf));
      if (rObj) {
        const name = rObj.name || rObj._name || rObj.description || rObj.label || rObj.locKey;
        if (name && typeof name === "string" && name.trim() && !name.startsWith("rarity_")) return name.trim();
      }
    } catch (_) {}

    try {
      const loc = window.glocalization || (window.services && window.services.Localization) || (window.repositories && window.repositories.Localization);
      if (loc && typeof loc.getText === "function") {
        const keys = ["rarity_name_" + rf, "item_rarity_" + rf, "rarity_" + rf, "search_rarity_" + rf, "card_rarity_" + rf, "Rarity_" + rf];
        for (const k of keys) {
          const txt = loc.getText(k);
          if (txt && typeof txt === "string" && !txt.startsWith("rarity_") && !txt.startsWith("item_rarity_") && !txt.startsWith("search_rarity_") && !txt.startsWith("card_rarity_") && !txt.startsWith("missing key") && !txt.startsWith("Rarity_")) {
            return txt.trim();
          }
        }
      }
    } catch (_) {}

    try {
      let sd = {};
      if (typeof it.getStaticData === "function") sd = it.getStaticData() || {};
      if (!sd || !Object.keys(sd).length) sd = it._staticData || it.staticData || {};
      const name = it.rarityName || it._rarityName || sd.rarityName || sd._rarityName;
      if (name && typeof name === "string" && name.trim()) return name.trim();
    } catch (_) {}

    const COMMON_RF_FALLBACKS = {
      16: "In Progress Evolution",
      17: "Evolution",
      70: "FUTTIES",
      78: "FUTTIES Hero",
      104: "Glory Hunters Red",
      109: "Glory Hunters",
      128: "FUTTIES ICON",
      140: "FUTTIES Evolution",
      141: "FUTTIES Premium",
      142: "FUTTIES Premium Hero",
      143: "FUTTIES Premium ICON",
      144: "FUTTIES Re-Release",
      145: "FUTTIES Batch 1",
      146: "FUTTIES Batch 2",
      169: "FUTTIES Batch 3",
      171: "FUTTIES Premium Evolution",
      172: "FUTTIES Red",
      173: "FUTTIES Pink"
    };
    if (COMMON_RF_FALLBACKS[rf]) return COMMON_RF_FALLBACKS[rf];

    return "Rarity " + rf;
  }

  // Scrape rareflag -> name from the open transfer-market rarity filter DOM
  // (bg url cards_bg_e_1_{id}_N.png + label). Merges into RARITIES live and logs
  // a JSON block to paste into data/rarities.json. Open TM search > rarity first.
  function scrapeRarities() {
    const found = {};
    document.querySelectorAll("li.with-icon, ul.inline-list li").forEach((li) => {
      let bg = "";
      try { bg = li.style.backgroundImage || getComputedStyle(li).backgroundImage; } catch (_) {}
      const m = bg && bg.match(/cards_bg_e_1_(\d+)_/);
      const name = (li.textContent || "").trim();
      if (m && name && name.toLowerCase() !== "any") found[m[1]] = name;
    });
    const n = Object.keys(found).length;
    if (n) { Object.assign(RARITIES, found); renderList(); renderPreview(); }
    log(n ? `↻ Scraped ${n} rarities (applied live).` : "✋ No rarity dropdown found — open TM search → rarity filter first.", n ? "head" : "warn");
    console.log("[FCEvo] rarities for data/rarities.json:\n" + JSON.stringify(found));
    return found;
  }

  // List every distinct rarity present in the club (id, name, count).
  function clubRaritiesDump() {
    const rs = clubRarities();
    console.log("[FCEvo] club rarities (id \\t name \\t count):\n" + rs.map((r) => `${r.rf}\t${r.name}\t×${r.count}`).join("\n"));
    return rs;
  }
  // Empirically find which rarities an evo accepts, via the app's canApplyTo().
  function eligibleRarities(slotId) {
    let slot = null;
    try { slot = window.repositories.Academy.getSlotById(Number(slotId)); } catch (_) {}
    if (!slot) { log("✋ Slot " + slotId + " not loaded — open the Academy hub (that category) first.", "warn"); return null; }
    const players = clubPlayers();
    const byRf = {};
    let tested = 0, eligible = 0, threw = 0;
    players.forEach((it) => {
      if (typeof it.canApplyTo !== "function") return;
      tested++;
      let ok = false;
      try { ok = !!it.canApplyTo(slot); } catch (_) { threw++; return; }
      if (ok) { eligible++; const rf = it.rareflag; (byRf[rf] = byRf[rf] || { rf, name: rarityName(it), count: 0 }).count++; }
    });
    const res = Object.values(byRf).sort((a, b) => b.count - a.count);
    log(`canApplyTo(${slotId}): ${eligible}/${tested} eligible across ${res.length} rarities${threw ? " (" + threw + " errored)" : ""}.`, "head");
    console.log("[FCEvo] eligible rarities for slot " + slotId + ":\n" + res.map((r) => `${r.rf}\t${r.name}\t×${r.count}`).join("\n") + "\n\nids: " + JSON.stringify(res.map((r) => r.rf)));
    return res;
  }
  const isGKItem = (it) => {
    try { if (it && typeof it.isGK === "function" && it.isGK()) return true; } catch (_) {}
    return !!it && (it.preferredPosition === 0 || it.preferredPosition === 28);
  };
  // Player's role groups from current positions (preferred first, then alts), deduped.
  function playerPositionGroups(it) {
    let ids = null;
    try { if (Array.isArray(it.possiblePositions)) ids = it.possiblePositions; } catch (_) {}
    if (!ids) { try { ids = it.getBasePossiblePositions(); } catch (_) {} }
    ids = ids || [];
    const groups = [];
    [it.preferredPosition].concat(ids).forEach((id) => {
      if (id == null) return;
      const g = POS_GROUP[id];
      if (g && !groups.includes(g)) groups.push(g);
    });
    return groups;
  }
  function hasEvo(it, evo) {
    const t = evo.r - TRAIT_OFFSET;
    try { return evo.kind === "PS+" ? !!it.hasPlusPlayStyle(t) : !!it.hasBasePlayStyle(t); } catch (_) { return false; }
  }
  const evoTrait = (evo) => evo.r - TRAIT_OFFSET;
  // A few base-trait glyphs are blank in EA's icon font (e.g. Intercept = 16);
  // fall back to the icontrait glyph (same symbol, colored by our CSS) so the
  // card/chip isn't empty.
  const MISSING_BASE_GLYPHS = new Set([16]);
  const iconClass = (kindIsPlus, traitId) =>
    (kindIsPlus || MISSING_BASE_GLYPHS.has(traitId) ? "icon_icontrait" : "icon_basetrait") + traitId;
  function currentPlayStyles(it) { try { return it.getPlayStyles() || []; } catch (_) { return []; } }
  // Distinct rarities present in the club: [{rf, name, count}]
  function clubRarities() {
    const m = new Map();
    clubPlayers().forEach((it) => {
      const rf = it.rareflag;
      if (!m.has(rf)) m.set(rf, { rf, name: rarityName(it), count: 0 });
      m.get(rf).count++;
    });
    return [...m.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
  const rarityAllowed = (it) => !state.rarities.size || state.rarities.has(it.rareflag);
  // True when this card itself already carries an evolution. Such a card is NOT
  // dead — you can keep adding PlayStyles to it (up to caps). It's the player's
  // one allowed evo version.
  const isEvoed = (it) => {
    try { if (it.canRemoveEvolution && it.canRemoveEvolution()) return true; } catch (_) {}
    try { if (it.isAcademyGraduateWithStatUpgrade && it.isAcademyGraduateWithStatUpgrade()) return true; } catch (_) {}
    return false;
  };
  // EA allows only ONE evolved copy per player. If an evolved copy of a card
  // (matched by definitionId) already exists, the CLEAN duplicates of that same
  // card can't be evolved — so hide those, but keep the evolved one.
  function pickable(it) {
    if (!rarityAllowed(it)) return false;
    if (isEvoed(it)) return true; // the allowed evo version — keep it
    return !blockedDefs().has(it.definitionId); // clean dupe of an evolved card -> hide
  }
  // Memoized set of definitionIds that have an evolved copy in the club. Recomputes
  // when the club (re)loads — keyed on the source array reference + length.
  let _bdSrc, _bdLen = -1, _bdOut = null;
  function blockedDefs() {
    const src = clubPlayers();
    if (src === _bdSrc && src.length === _bdLen && _bdOut) return _bdOut;
    _bdSrc = src; _bdLen = src.length;
    _bdOut = new Set();
    src.forEach((it) => { if (isEvoed(it) && it.definitionId != null) _bdOut.add(it.definitionId); });
    return _bdOut;
  }

  // EA's own name for "1v1 Close Down" is "Rush Out"; alias it for display only —
  // internal keys, ROLES and icon mapping keep the catalog name.
  const ALIAS = { "1v1 Close Down": "Rush Out" };
  const dispName = (base) => ALIAS[base] || base;
  // One-line PlayStyle explanations (FC 26) for tooltips.
  const PS_DESC = {
    "Finesse Shot": "Finesse shots are faster, curl harder and land more accurately.",
    "Chip Shot": "Chips and lobs dip more sharply with better accuracy and pace.",
    "Power Shot": "Power shots wind up faster and fly flatter and harder.",
    "Dead Ball": "Direct free kicks get a shot-aim aid, extra curve and power.",
    "Precision Header": "Headed shots, passes and clearances are faster and more accurate.",
    "Acrobatic": "Volleys and acrobatic finishes are quicker and more reliable.",
    "Low Driven Shot": "Driven shots stay low and skid, harder for keepers to reach.",
    "Gamechanger": "Shots from outside the box are faster and more accurate.",
    "Incisive Pass": "Through balls are faster and more accurate, splitting defences.",
    "Pinged Pass": "Driven ground passes are faster and more accurate.",
    "Long Ball Pass": "Long and lofted passes are faster and more accurate at range.",
    "Tiki Taka": "Short ground passes are quicker, tighter and first-time capable.",
    "Whipped Pass": "Crosses carry more pace, curve and accuracy.",
    "Inventive": "Flair passes (scoop, no-look) land more reliably.",
    "Jockey": "Faster, more responsive jockeying to contain attackers.",
    "Block": "Wider, more effective blocks of shots and passes.",
    "Intercept": "Greater reach and success reading and cutting out passes.",
    "Anticipate": "Cleaner, safer standing tackles that win the ball at the feet.",
    "Slide Tackle": "Longer-range, more accurate slide tackles.",
    "Aerial Fortress": "Wins more aerial duels with better jump, reach and timing.",
    "Technical": "Tighter close control and quicker, cleaner dribble touches.",
    "Rapid": "Accelerates faster while sprint-dribbling with the ball.",
    "First Touch": "Cleaner traps with less error, keeping the ball close.",
    "Trickster": "Performs skill moves faster while keeping the ball tight.",
    "Press Proven": "Holds up under pressure, losing less control when challenged.",
    "Quick Step": "Explosive acceleration off the ball to burst into space.",
    "Relentless": "Loses stamina slower and recovers more at halftime.",
    "Long Throw": "Throw-ins travel much farther, right into the box.",
    "Bruiser": "Wins more physical battles with stronger shoulder challenges.",
    "Enforcer": "Stronger in duels and quicker to recover after tackles.",
    "Far Throw": "Keeper throws travel farther and faster to launch attacks.",
    "Footwork": "Quicker keeper footwork and sharper reflex saves.",
    "Cross Claimer": "Commands the box and claims crosses more reliably.",
    "1v1 Close Down": "Rushes out faster and smothers one-on-ones (a.k.a. Rush Out).",
    "Far Reach": "Extra reach on dives to keep out shots bound for the corners.",
    "Deflector": "Parries shots into safer areas with stronger deflections.",
  };
  const psDesc = (base) => PS_DESC[base] || "";

  // ==========================================================================
  // UI
  // ==========================================================================
  let els = {}, tab = "PS+", searchQ = "";

  function css() {
    const s = document.createElement("style");
    s.textContent = `
    #fcevo{--ink:#0b0f14;--char:#141b23;--char2:#1d2732;--char3:#253241;--line:#28323d;--line2:#394653;
      --bone:#e7edf3;--ash:#a4b3c1;--acc:#33d6c1;--acc-glow:rgba(51,214,193,0.35);--acc-ink:#052420;--good:#4fd08a;--bad:#ff6b6b;--warn:#f2c14e;
      --gold1:#f6d879;--gold2:#c9942f;--pink:#ec4899;--violet:#8b5cf6;--grot:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;--mono:ui-monospace,Menlo,Consolas,monospace;
      position:fixed;top:54px;right:16px;width:min(480px, calc(100vw - 20px));min-width:400px;max-width:720px;resize:horizontal;max-height:90vh;z-index:2147483647;background:rgba(11,15,20,0.96);backdrop-filter:blur(10px);color:var(--bone);
      font:12.5px/1.45 var(--grot);border:1px solid var(--line2);border-radius:10px;box-shadow:0 26px 64px -24px #000, 0 0 0 1px rgba(255,255,255,0.06);display:flex;flex-direction:column;overflow:hidden}
    #fcevo *{box-sizing:border-box}
    #fcevo, #fcevo *{text-transform:none !important;letter-spacing:normal !important}
    #fcevo select,#fcevo input{min-width:0}
    #fcevo header{display:flex;align-items:center;gap:9px;padding:12px 14px;background:linear-gradient(135deg, #141b23 0%, #1c2736 100%);border-bottom:1px solid var(--line);cursor:move;user-select:none}
    #fcevo header .wm{font-weight:800;font-size:12.5px;letter-spacing:.06em;text-transform:uppercase}
    #fcevo header .dia{width:7px;height:7px;background:var(--acc);transform:rotate(45deg);display:inline-block;box-shadow:0 0 8px var(--acc)}
    #fcevo .upd{font:700 10px/1 var(--grot);color:var(--acc-ink);background:var(--acc);padding:3px 6px;border-radius:3px;text-decoration:none;white-space:nowrap;margin-left:4px}
    #fcevo .upd:hover{filter:brightness(1.1)}
    #fcevo .notice-overlay{position:absolute;inset:0;z-index:20;display:flex;align-items:center;justify-content:center;padding:18px;background:rgba(2,6,10,.7)}
    #fcevo .notice-card{max-width:320px;display:flex;flex-direction:column;gap:13px;text-align:center;
      background:var(--char);border:1px solid var(--acc);border-radius:10px;box-shadow:0 22px 54px -14px #000;padding:17px 16px 15px}
    #fcevo .notice-card .notice-title{color:var(--bone);font:800 15px/1.3 var(--grot)}
    #fcevo .notice-card .notice-title:empty{display:none}
    #fcevo .notice-card .notice-body{color:var(--ash);font:400 12.5px/1.5 var(--grot)}
    #fcevo .notice-card .notice-body:empty{display:none}
    #fcevo .notice-card .notice-link{color:var(--acc);text-decoration:none;font:700 12.5px/1.3 var(--grot)}
    #fcevo .notice-card .notice-link:hover{text-decoration:underline}
    #fcevo .notice-card .notice-x{align-self:center;background:var(--acc);color:var(--acc-ink);border:0;border-radius:6px;padding:8px 18px;cursor:pointer;font:700 12px/1 var(--grot)}
    #fcevo .notice-card .notice-x:hover{filter:brightness(1.08)}
    #fcevo header .sp{flex:1}
    #fcevo header button{background:transparent;color:var(--ash);border:1px solid var(--line2);width:26px;height:24px;border-radius:4px;padding:0;cursor:pointer;font:600 13px/1 var(--grot);display:flex;align-items:center;justify-content:center;transition:all .15s}
    #fcevo header button:hover{color:var(--ink);background:var(--acc);border-color:var(--acc)}
    #fcevo header button[data-act="close"]:hover{color:#fff;background:var(--bad);border-color:var(--bad)}
    #fcevo .chev{pointer-events:none;transform:rotate(0);transition:transform .32s cubic-bezier(.2,.7,.2,1)}
    #fcevo .setpanel{position:absolute;top:44px;right:12px;z-index:6;background:var(--char);border:1px solid var(--line2);border-radius:8px;padding:12px 14px;display:flex;flex-direction:column;gap:10px;box-shadow:0 16px 38px -14px #000;font:11px/1.3 var(--mono);color:var(--ash);text-transform:uppercase;letter-spacing:.06em}
    #fcevo .setpanel label{display:flex;align-items:center;gap:8px;white-space:nowrap;cursor:pointer}
    #fcevo .setpanel input[type=checkbox]{accent-color:var(--acc);cursor:pointer;margin:0}
    #fcevo .setpanel input[type=number]{font-family:var(--mono);background:var(--ink);color:var(--bone);border:1px solid var(--line2);border-radius:4px;padding:3px 6px}
    #fcevo .setfoot{border-top:1px solid var(--line2);margin-top:3px;padding-top:8px;font-size:11px;color:var(--ash)}
    #fcevo .setfoot a{color:var(--acc);text-decoration:none}
    #fcevo .setfoot a:hover{text-decoration:underline}
    #fcevo.min .chev{transform:rotate(180deg)}
    #fcevo .body{padding:12px 14px;overflow-y:auto;overflow-x:hidden;display:flex;flex-direction:column;gap:12px}
    #fcevo.min{width:auto;resize:none}
    #fcevo.min .body{display:none}
    #fcevo.min header{border-bottom:0}
    #fcevo input,#fcevo select{background:var(--ink);border:1px solid var(--line2);color:var(--bone);border-radius:6px;padding:7px 9px;font:12px/1.3 var(--grot);accent-color:var(--acc);transition:border-color .15s}
    #fcevo input:focus,#fcevo select:focus{outline:none;border-color:var(--acc);box-shadow:0 0 0 2px var(--acc-glow)}
    #fcevo input::placeholder{color:var(--ash)}
    #fcevo input[type=text]{width:100%}
    #fcevo .row{display:flex;gap:7px;align-items:center}
    #fcevo .sec{background:transparent;border:0;padding:0}
    #fcevo .sec h4{margin:0 0 9px;font:700 10.5px/1 var(--mono);color:var(--ash);text-transform:uppercase;letter-spacing:.12em;
      display:flex;align-items:center;gap:8px;padding-bottom:7px;border-bottom:1px solid var(--line)}
    #fcevo .sec h4 .ix{color:var(--acc);font-weight:800;letter-spacing:.06em}
    #fcevo .rhint{padding:8px 9px;font:10.5px/1.4 var(--mono);text-transform:uppercase;letter-spacing:.06em;color:var(--ash)}
    #fcevo .rarpanel{position:fixed;z-index:2147483647;display:none;flex-direction:column;max-height:300px;overflow-y:auto;
      background:var(--char);border:1px solid var(--line2);border-radius:8px;box-shadow:0 20px 46px -18px #000}
    #fcevo .rarpanel.open{display:flex}
    #fcevo .rarhead{flex:none;display:flex;flex-direction:column;gap:7px;padding:8px;border-bottom:1px solid var(--line2)}
    #fcevo .rarsearch{width:100%}
    #fcevo .rarhead .allrar{padding:3px 3px 1px;border:0;font-weight:700}
    #fcevo .rarlist{flex:1;overflow-y:auto}
    #fcevo .rarpanel label{display:flex;align-items:center;gap:10px;font-size:12px;padding:8px 11px;cursor:pointer;border-bottom:1px solid var(--line);color:var(--bone)}
    #fcevo .rarlist label:last-child{border-bottom:0}
    #fcevo .rarpanel label:hover{background:var(--char2)}
    #fcevo .rarpanel label .rc{margin-left:auto;color:var(--ash);font:10px/1 var(--mono);font-variant-numeric:tabular-nums}
    #fcevo input[type=checkbox]{width:14px;height:14px;padding:0;border:0;background:none;accent-color:var(--acc);cursor:pointer;flex:none}
    #fcevo .plist{display:flex;flex-direction:column;max-height:190px;overflow-y:auto;overflow-x:hidden;margin-top:8px;border:1px solid var(--line);border-radius:6px;background:rgba(10,14,19,0.4)}
    #fcevo .pr{display:flex;align-items:center;gap:9px;padding:8px 9px;border:0;border-bottom:1px solid var(--line);cursor:pointer;background:transparent;transition:background .12s}
    #fcevo .pr:last-child{border-bottom:0}
    #fcevo .pr:hover{background:var(--char2)}
    #fcevo .pr:focus{outline:none;background:var(--char2);box-shadow:inset 3px 0 0 var(--acc)}
    #fcevo .pr.on{background:var(--char2);box-shadow:inset 3px 0 0 var(--acc)}
    #fcevo .pr.hasps .nm{color:var(--warn)}
    #fcevo .pr .ov{font:800 15px/1 var(--grot);color:var(--bone);min-width:26px;text-align:center;font-variant-numeric:tabular-nums}
    #fcevo .pr .nm{flex:1;font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    #fcevo .pr .gk{font:10px/1.5 var(--grot);color:var(--acc);border:1px solid var(--line2);padding:1px 5px;border-radius:3px}
    #fcevo .pr .psc{display:flex;gap:5px;white-space:nowrap;font-family:var(--mono);flex:none}
    #fcevo .pr .pchip{font-size:10px;font-weight:700;padding:1px 5px;border:1px solid;border-radius:3px;font-variant-numeric:tabular-nums}
    #fcevo .pr .pchip.room{color:var(--good);border-color:#2f5a2a;background:rgba(47,90,42,0.15)}
    #fcevo .pr .pchip.full{color:var(--bad);border-color:#5a2b24;background:rgba(90,43,36,0.15)}
    #fcevo .statrow{display:flex;gap:0;margin-top:9px;border:1px solid var(--line);border-radius:6px;overflow:hidden;background:var(--char)}
    #fcevo .statrow .stat{flex:1;text-align:center;padding:5px 2px;border-right:1px solid var(--line);min-width:0}
    #fcevo .statrow .stat:last-child{border-right:0}
    #fcevo .statrow .stat b{display:block;font:800 13.5px/1 var(--grot);color:var(--bone);font-variant-numeric:tabular-nums}
    #fcevo .statrow .stat small{display:block;font-size:9px;color:var(--ash);margin-top:2px}
    #fcevo .statrow .stat.hi b{color:var(--good)}
    #fcevo .statrow .stat.lo b{color:var(--ash)}
    #fcevo .rolebox{background:var(--char);border:1px solid var(--line);border-radius:8px;padding:10px 11px;display:flex;flex-direction:column;gap:8px}
    #fcevo .tabs{display:flex;gap:0;border-bottom:1px solid var(--line);margin-top:6px}
    #fcevo .tabs button{flex:1;background:transparent;border:0;border-bottom:2px solid transparent;color:var(--ash);padding:9px 6px;cursor:pointer;
      font:700 10.5px/1 var(--mono);text-transform:uppercase;letter-spacing:.08em;margin-bottom:-1px;transition:all .15s}
    #fcevo .tabs button:hover{color:var(--bone)}
    #fcevo .tabs button.on{color:var(--bone);border-bottom-color:var(--acc)}
    #fcevo .tabs button.disabled{opacity:.38;cursor:help}
    #fcevo .tabs button.disabled:hover{color:var(--ash)}
    
    /* PlayStyle search box and dropdown */
    #fcevo .ps-search-wrap{position:relative;margin:8px 0 4px}
    #fcevo .ps-search-input{width:100%;background:var(--char);border:1px solid var(--line2);color:var(--bone);border-radius:6px;padding:6px 9px;font:11.5px/1.3 var(--grot)}
    #fcevo .ps-search-input:focus{outline:none;border-color:var(--acc);box-shadow:0 0 0 2px var(--acc-glow)}
    #fcevo .ps-quick-list{position:absolute;top:calc(100% + 2px);left:0;right:0;z-index:25;background:var(--char);border:1px solid var(--line2);border-radius:6px;max-height:160px;overflow-y:auto;box-shadow:0 12px 28px -8px #000}
    #fcevo .ps-quick-item{display:flex;align-items:center;gap:8px;padding:6px 10px;cursor:pointer;border-bottom:1px solid var(--line);font-size:11.5px;color:var(--bone)}
    #fcevo .ps-quick-item:last-child{border-bottom:0}
    #fcevo .ps-quick-item:hover{background:var(--char2);color:var(--acc)}
    #fcevo .ps-quick-item.sel{opacity:.5}
    #fcevo .ps-quick-item .qbadge{font:700 9px/1 var(--mono);padding:2px 5px;border-radius:3px;background:var(--ink);border:1px solid var(--line2);color:var(--ash)}
    #fcevo .ps-quick-item.psp .qbadge{color:var(--gold1);border-color:#7d6320}

    /* Selected PlayStyles strip with Drag-and-Drop Reordering & Cursor */
    #fcevo .sel-ps-strip-wrap{margin:6px 0 8px}
    #fcevo .sel-ps-strip-hdr{display:flex;align-items:center;justify-content:space-between;font:700 9.5px/1 var(--mono);color:var(--ash);text-transform:uppercase;letter-spacing:.08em;margin-bottom:4px}
    #fcevo .sel-ps-strip-hdr .order-hint{color:var(--acc);font-weight:600;font-size:9px}
    #fcevo .sel-ps-strip{display:flex;flex-wrap:wrap;gap:2px;padding:6px 8px;background:rgba(20,27,35,0.7);border:1px solid var(--line);border-radius:6px;min-height:34px;align-items:center;outline:none}
    #fcevo .sel-chip{display:inline-flex;align-items:center;gap:4px;font:700 10.5px/1 var(--grot);padding:4px 6px;border-radius:5px;background:var(--char2);border:1px solid var(--line2);color:var(--bone);user-select:none;cursor:grab;transition:transform .12s, box-shadow .12s, opacity .12s}
    #fcevo .sel-chip:active{cursor:grabbing}
    #fcevo .sel-chip.dragging{opacity:.4;transform:scale(0.95)}
    #fcevo .sel-chip.drag-over{border-color:var(--acc);box-shadow:0 0 0 2px var(--acc-glow);transform:scale(1.04)}
    #fcevo .sel-chip .drag-grip{color:var(--ash);font-size:10px;line-height:1;opacity:.6;cursor:grab}
    #fcevo .sel-chip .chip-num{font:800 9px/1 var(--mono);background:var(--ink);border:1px solid var(--line2);padding:1.5px 3.5px;border-radius:3px;color:var(--acc)}
    #fcevo .sel-chip.psp{border-color:#7d6320;background:rgba(155,120,25,.18);color:var(--gold1)}
    #fcevo .sel-chip.psp .chip-num{color:var(--gold1);border-color:#7d6320}
    #fcevo .sel-chip .chip-arrow{background:none;border:0;color:var(--ash);cursor:pointer;font-size:9px;line-height:1;padding:2px 3px;border-radius:2px;display:inline-flex;align-items:center;justify-content:center;transition:all .12s}
    #fcevo .sel-chip .chip-arrow:hover{color:var(--acc);background:rgba(51,214,193,0.15)}
    #fcevo .sel-chip .chip-x{background:none;border:0;color:var(--ash);cursor:pointer;font-size:11px;line-height:1;padding:1px 3px;margin-left:1px;border-radius:2px;display:inline-flex;align-items:center;justify-content:center;transition:all .12s}
    #fcevo .sel-chip .chip-x:hover{color:#fff;background:var(--bad)}

    /* Cursor & Temporary Reserve Area Styling */
    #fcevo .cursor-pos-badge{background:var(--char2);border:1px solid var(--acc);color:var(--acc);font:800 9px/1 var(--mono);padding:2.5px 6px;border-radius:4px;letter-spacing:.05em}
    #fcevo .reserve-btn,#fcevo .reserve-action-btn{background:rgba(46,165,255,0.12);border:1px solid var(--acc);color:var(--acc);font:700 9px/1 var(--mono);padding:3px 7px;border-radius:4px;cursor:pointer;transition:all .15s}
    #fcevo .reserve-btn:hover,#fcevo .reserve-action-btn:hover{background:rgba(46,165,255,0.25);box-shadow:0 0 8px var(--acc-glow)}

    #fcevo .cursor-spot{display:inline-flex;align-items:center;justify-content:center;width:10px;height:28px;cursor:pointer;position:relative;margin:0 -1px;z-index:2;transition:all .15s}
    #fcevo .cursor-spot .cursor-line{width:2px;height:18px;background:rgba(255,255,255,0.15);border-radius:1px;transition:all .15s}
    #fcevo .cursor-spot:hover .cursor-line{background:var(--acc);height:24px;box-shadow:0 0 6px var(--acc)}
    #fcevo .cursor-spot.active .cursor-line{width:3px;height:26px;background:var(--acc);box-shadow:0 0 10px var(--acc), 0 0 2px #fff;animation:cursorPulse 1.5s infinite}
    #fcevo .cursor-spot.active::before{content:"▼";position:absolute;top:-8px;font-size:8px;color:var(--acc);line-height:1}
    #fcevo .cursor-spot.drag-over .cursor-line{background:var(--acc);height:26px;box-shadow:0 0 12px var(--acc)}
    @keyframes cursorPulse { 0%,100%{opacity:1} 50%{opacity:0.6} }

    #fcevo .reserve-strip-wrap{margin:6px 0 8px;padding:6px 8px;background:rgba(15,22,30,0.85);border:1px dashed #3a4b5c;border-radius:6px}
    #fcevo .reserve-strip-hdr{display:flex;align-items:center;justify-content:space-between;font:700 9.5px/1 var(--mono);color:var(--ash);text-transform:uppercase;letter-spacing:.08em;margin-bottom:6px}
    #fcevo .reserve-strip{display:flex;flex-wrap:wrap;gap:5px;min-height:30px;align-items:center;padding:4px;border-radius:4px;background:rgba(0,0,0,0.2);transition:all .15s}
    #fcevo .reserve-strip.drag-over{border:1px solid var(--acc);background:rgba(46,165,255,0.1)}
    #fcevo .reserve-chip{display:inline-flex;align-items:center;gap:4px;font:700 10px/1 var(--grot);padding:3px 6px;border-radius:4px;background:var(--char);border:1px dashed var(--line2);color:var(--ash);user-select:none;cursor:grab;transition:all .12s}
    #fcevo .reserve-chip:hover{color:var(--bone);border-color:var(--acc)}
    #fcevo .reserve-chip.psp{border-color:#7d6320;color:var(--gold1)}
    #fcevo .reserve-chip .chip-rest{background:none;border:0;color:var(--acc);cursor:pointer;font:800 9px/1 var(--mono);padding:2px 4px;border-radius:3px;transition:all .12s}
    #fcevo .reserve-chip .chip-rest:hover{background:rgba(51,214,193,0.2)}

    /* Grid & Icons (25% bigger, modern and readable) */
    #fcevo .grid{display:flex;flex-direction:column;gap:9px;max-height:280px;overflow-y:auto;overflow-x:hidden;padding-right:2px}
    #fcevo .gcat-h{font:700 11px/1 var(--grot);color:var(--acc);margin:0 0 4px;padding-bottom:3px;border-bottom:1px solid var(--line)}
    #fcevo .gcat-row{display:flex;flex-wrap:wrap;gap:4px}
    #fcevo .ec{position:relative;width:48px;padding:4px 2px 3px;cursor:pointer;text-align:center;border-radius:6px;transition:background .12s}
    #fcevo .ec:hover{background:var(--char2)}
    #fcevo .ec.dis{opacity:.24;cursor:not-allowed}
    #fcevo .ec.owned{opacity:.45}
    #fcevo .noglyph i{display:none}
    #fcevo .ec .ico{position:relative;width:38px;height:38px;margin:0 auto 3px;display:flex;align-items:center;justify-content:center;
      border-radius:8px;border:1px solid var(--line2);background:var(--char2);transition:all .15s}
    #fcevo .ec .ico i{font-family:'UltimateTeam-Icons',sans-serif;font-style:normal;font-weight:400;font-size:22px;line-height:1;color:var(--bone)}
    #fcevo .ec .ico.noglyph::after{content:attr(data-ini);font:800 12px var(--grot);color:var(--bone)}
    #fcevo .ec.psp .ico{border-color:#7d6320;background:rgba(155,120,25,.14)}
    #fcevo .ec.psp .ico i,#fcevo .ec.psp .ico.noglyph::after{color:var(--gold1)}
    #fcevo .ec.owned .ico i,#fcevo .ec.owned .ico.noglyph::after{color:var(--ash)}
    #fcevo .ec.sel .ico{border-color:var(--acc);box-shadow:0 0 0 1px var(--acc) inset,0 0 11px -2px var(--acc)}
    #fcevo .ec.psp.sel .ico{border-color:var(--gold1);box-shadow:0 0 0 1px var(--gold1) inset,0 0 11px -2px var(--gold1)}
    #fcevo .ec.sug-pick .ico{border-color:rgba(51,214,193,0.7);box-shadow:0 0 9px rgba(51,214,193,0.3)}
    #fcevo .ec.sug-pick.psp .ico{border-color:rgba(246,216,121,0.8);box-shadow:0 0 9px rgba(246,216,121,0.35)}
    #fcevo .ec .sug-badge{position:absolute;top:1px;left:3px;font-size:9px;line-height:1;filter:drop-shadow(0 0 3px var(--acc))}
    #fcevo .ec .nm{font-size:9.5px;line-height:1.15;color:#c2ccd6;max-height:22px;overflow:hidden;word-break:break-word}
    #fcevo .ec.sel .nm{color:var(--bone);font-weight:700}#fcevo .ec.psp.sel .nm{color:var(--gold1);font-weight:700}
    #fcevo .ec .own{position:absolute;top:1px;right:3px;width:13px;height:13px;background:var(--ink);border:1px solid var(--line2);border-radius:3px;
      display:flex;align-items:center;justify-content:center;font:8px/1 var(--grot);color:var(--ash)}
    #fcevo .ec .own::after{content:"\\2713"}
    #fcevo .psrow{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
    #fcevo .psrow .chip{width:29px;height:29px;display:flex;align-items:center;justify-content:center;
      border-radius:7px;border:1px solid var(--line2);background:var(--char2);color:var(--bone)}
    #fcevo .psrow .chip i{font-family:'UltimateTeam-Icons',sans-serif;font-style:normal;font-weight:400;font-size:16px;line-height:1}
    #fcevo .psrow .chip.noglyph::after{content:attr(data-ini);font:800 10px var(--grot);color:var(--bone)}
    #fcevo .psrow .chip.ic{border-color:#7d6320;background:rgba(155,120,25,.14);color:var(--gold1)}
    .trd-badge{font:700 8.5px/1 var(--mono);padding:1.5px 4px;border-radius:3px;text-transform:uppercase;flex:none;display:inline-block;margin-left:4px;vertical-align:middle}
    .trd-badge.trd{background:rgba(62,207,106,0.15);color:#3ecf6a;border:1px solid rgba(62,207,106,0.3)}
    .trd-badge.untr{background:rgba(224,82,82,0.15);color:#e05252;border:1px solid rgba(224,82,82,0.3)}
    .pos-chip{font:800 8.5px/1 var(--mono);padding:1.5px 4px;border-radius:3px;background:rgba(46,165,255,0.15);color:#2ea5ff;border:1px solid rgba(46,165,255,0.3);margin-left:4px;vertical-align:middle;display:inline-block;text-transform:uppercase}
    #fcevo .trdbtn, #fcevo .psfilterbtn{display:flex;align-items:center;white-space:nowrap}
    #fcevo .view-btn{background:transparent;border:1px solid var(--line2);color:var(--ash);font:600 9.5px/1 var(--mono);padding:3px 6px;border-radius:4px;cursor:pointer;margin-left:auto;flex:none;transition:all .15s}
    #fcevo .view-btn:hover{color:var(--acc);border-color:var(--acc);background:rgba(46,165,255,0.12)}
    
    /* Attribute Viewer Modal Overlay */
    .fcevo-modal-overlay{position:fixed;top:0;left:0;right:0;bottom:0;z-index:2147483647;background:rgba(10,14,20,.85);backdrop-filter:blur(8px);display:none;align-items:center;justify-content:center;padding:16px;box-sizing:border-box}
    .fcevo-modal-overlay.open{display:flex}
    .fcevo-modal-dialog{background:#141c24;border:1px solid #2a3a4a;border-radius:12px;width:100%;max-width:560px;max-height:90vh;overflow-y:auto;padding:18px;box-shadow:0 25px 60px -15px #000;position:relative;color:#e0eaf4;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
    .fcevo-modal-close{position:absolute;top:12px;right:14px;background:none;border:0;color:#7a8a9a;font-size:22px;cursor:pointer;line-height:1}
    .fcevo-modal-close:hover{color:#e0eaf4}
    .attr-hdr{display:flex;align-items:center;gap:12px;border-bottom:1px solid #222e3c;padding-bottom:12px}
    .attr-ovr{font:800 32px/1 var(--grot,sans-serif);color:#2ea5ff}
    .attr-name{font:800 17px/1.2 var(--grot,sans-serif);color:#e0eaf4}
    .attr-meta{font-size:11.5px;color:#7a8a9a;margin-top:3px;display:flex;align-items:center;gap:6px}
    .attr-meta-strip{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin:10px 0;background:#1c2632;padding:8px 10px;border-radius:6px;border:1px solid #263445}
    .attr-meta-strip.full-bio{grid-template-columns:repeat(2,1fr);gap:8px}
    .attr-meta-strip .mitem small{display:block;font-size:9.5px;color:#7a8a9a;text-transform:uppercase}
    .attr-meta-strip .mitem b{font-size:11.5px;color:#e0eaf4}
    .pos-badge{font:800 10.5px/1 var(--mono,monospace);padding:3px 7px;border-radius:4px;display:inline-block;text-transform:uppercase}
    .pos-badge.main{background:#2ea5ff;color:#0a0e14;border:1px solid #52b4ff}
    .pos-badge.alt{background:#1c2632;color:#a0b4c8;border:1px solid #2a3a4a}
    .attr-sec-title{font:700 10.5px/1 var(--mono,monospace);color:#2ea5ff;text-transform:uppercase;letter-spacing:.1em;margin:14px 0 7px;border-bottom:1px solid #222e3c;padding-bottom:4px}
    .face-grid{display:grid;grid-template-columns:repeat(6,1fr);gap:5px}
    .face-stat{background:#1c2632;border:1px solid #263445;padding:6px 2px;text-align:center;border-radius:5px}
    .face-stat .fv{font:800 15px/1 var(--grot,sans-serif)}
    .face-stat .fl{font-size:8.5px;color:#7a8a9a;text-transform:uppercase;margin-top:3px}
    .sub-cats-wrapper{display:grid;grid-template-columns:repeat(2,1fr);gap:8px}
    .sub-cat{background:#18222d;border:1px solid #222e3c;border-radius:6px;padding:7px 8px}
    .sub-h{font:700 9.5px/1 var(--mono,monospace);color:#7a8a9a;text-transform:uppercase;margin-bottom:5px;letter-spacing:.08em}
    .sub-grid{display:flex;flex-direction:column;gap:2.5px}
    .sub-row{display:flex;justify-content:space-between;font-size:10.5px}
    .sub-l{color:#9ab0c4}
    .sub-v{font-weight:700;font-family:monospace}
    .hi90{color:#3ecf6a!important}.hi80{color:#2ea5ff!important}.mid{color:#e0eaf4!important}.lo{color:#7a8a9a!important}
    .ps-grid{display:flex;flex-wrap:wrap;gap:5px}
    .ps-item{display:flex;align-items:center;gap:5px;background:#1c2632;border:1px solid #263445;padding:3px 7px;border-radius:5px;font-size:10.5px}
    .ps-item.plus{border-color:#7d6320;background:rgba(155,120,25,.18);color:#e5b638}

    #fcevo .opts{display:flex;gap:14px;align-items:center;flex-wrap:wrap;font:10.5px/1.4 var(--mono);text-transform:uppercase;letter-spacing:.06em;color:var(--ash)}
    #fcevo .go{background:linear-gradient(135deg, #1f6feb 0%, #33d6c1 100%);color:#fff;border:0;border-radius:6px;padding:12px;cursor:pointer;
      font:800 12px/1 var(--grot);text-transform:uppercase;letter-spacing:.12em;box-shadow:0 4px 14px rgba(51,214,193,0.3);transition:all .15s}
    #fcevo .go:hover{filter:brightness(1.1);box-shadow:0 6px 18px rgba(51,214,193,0.45)}
    #fcevo .go:disabled{opacity:.4;cursor:not-allowed}#fcevo .stop{background:var(--bad);color:#fff}
    #fcevo .mini{background:var(--char);color:var(--ash);border:1px solid var(--line2);border-radius:5px;padding:6px 10px;cursor:pointer;
      font:600 10.5px/1 var(--mono);text-transform:uppercase;letter-spacing:.06em;white-space:nowrap;transition:all .15s}
    #fcevo .mini:hover{color:var(--bone);border-color:var(--ash);background:var(--char2)}
    #fcevo .mini.sugbtn{color:var(--acc);border-color:var(--acc);background:rgba(51,214,193,0.1)}
    #fcevo .mini.sugbtn:hover{background:rgba(51,214,193,0.2)}
    #fcevo .mini.rmevo{color:var(--bad);border-color:#5a2b24}
    #fcevo .mini.rmevo:hover{color:#fff;background:var(--bad);border-color:var(--bad)}
    #fcevo .status{font:12px/1.4 var(--grot);color:var(--ash);padding:4px 0 2px;min-height:18px;white-space:normal;overflow-wrap:anywhere}
    #fcevo .status.ok{color:var(--good)}#fcevo .status.err{color:var(--bad)}#fcevo .status.warn{color:var(--warn)}#fcevo .status.head{color:var(--acc)}#fcevo .status.dim{color:var(--ash)}
    #fcevo .count{color:var(--bone);font-weight:700;font-variant-numeric:tabular-nums}#fcevo .count.over{color:var(--bad)}#fcevo .muted{color:var(--ash)}
    #fcevo .clubstat{margin-top:8px;padding:7px 10px;font:10px/1.4 var(--mono);text-transform:uppercase;letter-spacing:.08em;background:var(--char);border:1px solid var(--line);border-left:3px solid var(--line2);border-radius:4px;cursor:pointer}
    #fcevo .clubstat.load{color:var(--warn);border-left-color:var(--warn)}#fcevo .clubstat.ok{color:var(--good);border-left-color:var(--good)}#fcevo .clubstat.err{color:var(--bad);border-left-color:var(--bad)}
    #fcevo-tip{position:fixed;z-index:2147483647;max-width:260px;background:#0b0f14;border:1px solid #394653;border-radius:8px;
      padding:9px 12px;pointer-events:none;box-shadow:0 16px 38px -14px #000;font:11.5px/1.45 var(--grot);color:#c4ccd4}
    #fcevo-tip b{display:block;font:700 10.5px/1.2 var(--mono);letter-spacing:.08em;text-transform:uppercase;color:#33d6c1;margin-bottom:5px}
    #fcevo-tip span{display:block}
    `;
    document.head.appendChild(s);
  }

  function build() {
    css();
    const root = document.createElement("div");
    root.id = "fcevo";
    root.innerHTML = `
      <header>
        <b class="wm">Evo&nbsp;Helper <span style="font-size:9px;background:linear-gradient(135deg,#ec4899,#8b5cf6);color:#fff;padding:2px 6px;border-radius:10px;vertical-align:middle;margin-left:4px;font-weight:700;box-shadow:0 0 8px rgba(236,72,153,0.5);">v2.2.1</span></b>
        <i class="dia" aria-hidden="true"></i>
        <a class="upd" id="fcevo-upd" href="${INSTALL_URL}" target="_blank" rel="noopener noreferrer" title="New version available — click to update" style="display:none">⬆ update</a>
        <span class="sp"></span>
        <button data-act="settings" class="hbtn" title="Settings">⚙</button>
        <button data-act="min" title="Collapse"><svg class="chev" viewBox="0 0 14 9" width="12" height="8" aria-hidden="true"><path d="M1 6.5L7 1.5L13 6.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
        <button data-act="close" class="xbtn" title="Close (until page reload)">✕</button>
      </header>
      <div class="notice-overlay" id="fcevo-notice" data-act="notice-hide" style="display:none"><div class="notice-card"><div class="notice-title" id="fcevo-notice-title"></div><div class="notice-body" id="fcevo-notice-body"></div><a class="notice-link" id="fcevo-notice-link" target="_blank" rel="noopener noreferrer" style="display:none"></a><button class="notice-x" data-act="notice-hide">Got it</button></div></div>
      <div class="setpanel" id="fcevo-settings" style="display:none">
        <label title="Add the player to each slot, then claim/finish it so the PlayStyle is locked in."><input type="checkbox" id="fcevo-claim" checked> claim &amp; finish</label>
        <label>delay <input type="number" id="fcevo-delay" value="300" min="200" step="100" style="width:54px"> ms</label>
        <label title="When on, the panel loads collapsed each time you open the web app."><input type="checkbox" id="fcevo-startmin"> start minimized</label>
        <div class="setfoot">${runningVersion() ? "v" + runningVersion() + " · " : ""}<a href="${REPO_URL}" target="_blank" rel="noopener noreferrer">GitHub&nbsp;↗</a></div>
      </div>
      <div class="body">
        <div class="sec">
          <h4><span class="ix">01</span> Select Player from Club</h4>
          <input type="text" id="fcevo-search" placeholder="search player name or rarity…">
          <div class="row" style="margin-top:6px;gap:6px">
            <button class="mini rarbtn" data-act="rar" id="fcevo-rarbtn" style="flex:1">Rarity: all ▾</button>
            <button class="mini trdbtn" data-act="trd" id="fcevo-trdbtn" title="Filter by Tradeable / Untradeable status" style="flex:1">Trade: 🔒 UNT</button>
            <button class="mini psfilterbtn" data-act="psfilter" id="fcevo-psfilterbtn" title="Filter by PlayStyles: All / Clean (0 PS) / Has PS" style="flex:1">PS: ⚪ 0 PS</button>
          </div>
          <div class="rarpanel" id="fcevo-rarpanel"></div>
          <div class="clubstat" id="fcevo-clubstat" data-act="reloadclub" title="Click to reload the club">Club: waiting for app…</div>
          <div class="plist" id="fcevo-list"></div>
        </div>

        <div class="sec" id="fcevo-preview" style="display:none"></div>

        <div class="sec" id="fcevo-evosec">
          <h4><span class="ix">02</span> Position &amp; Role</h4>
          <div id="fcevo-selplayer-banner" style="display:none;padding:7px 10px;border-radius:6px;background:rgba(51,214,193,0.12);border:1px solid rgba(51,214,193,0.35);margin-bottom:9px;font-size:11.5px;color:var(--bone);align-items:center;box-shadow:0 0 10px rgba(51,214,193,0.15)"></div>
          <div class="rolebox">
            <div class="row">
              <select id="fcevo-pos" style="flex:1" title="Player Position"></select>
              <select id="fcevo-role" style="flex:1.4" title="Tactical Role"></select>
            </div>
            <div class="row" style="gap:6px">
              <button class="mini sugbtn" data-act="suggest" data-tip="Auto-Suggest|Recalculate recommended PlayStyles for this role — top 3/4 as PS+, rest as basic." style="flex:1.2">✨ Re-Suggest</button>
              <button class="mini" data-act="togglesort" id="fcevo-sortbtn" title="Toggle sorting order: Category / Alphabetical A-Z" style="flex:1">Sort: Category ▾</button>
              <button class="mini" data-act="clearsel" style="flex:1">Clear all</button>
            </div>
          </div>
          <div class="tabs" style="margin-top:10px">
            <button data-tab="PS+">PlayStyle+ (36)</button>
            <button data-tab="PS">PlayStyle (36)</button>
            <button data-tab="GH4" class="gh4tab disabled" data-tip="4th PlayStyle+|FUTTIES, Glory Hunters, and special cards can hold a 4th PS+ — pick an eligible card to choose a 4th PS+.">4th PS+</button>
          </div>

          <div class="ps-search-wrap">
            <input type="text" class="ps-search-input" id="fcevo-pssearch" placeholder="🔍 Type playstyle name to search/select (e.g. fin, tri, ant)…" autocomplete="off">
            <div class="ps-quick-list" id="fcevo-psmatches" style="display:none"></div>
          </div>

          <div class="sel-ps-strip-wrap" id="fcevo-selstrip-wrap" style="display:none">
            <div class="sel-ps-strip-hdr">
              <span>Apply Sequence (<span id="fcevo-sel-count">0</span>)</span>
              <span class="cursor-pos-badge" id="fcevo-cursor-badge" title="Cursor position (use ◄/► arrow keys or click spots to move)">📍 Cursor: #0</span>
              <button class="reserve-btn" data-act="mv-after-to-reserve" id="fcevo-mvafterbtn" title="Move all PlayStyles after cursor to Temporary Reserve" style="display:none">⬇ Move rest to Reserve</button>
            </div>
            <div class="sel-ps-strip" id="fcevo-selstrip" tabindex="0" title="Click spots or use ◄/► arrow keys to move cursor"></div>
          </div>

          <div class="reserve-strip-wrap" id="fcevo-reserve-wrap" style="display:none">
            <div class="reserve-strip-hdr">
              <span>📦 Temporary Reserve (<span id="fcevo-reserve-count">0</span>)</span>
              <button class="reserve-action-btn" data-act="restore-all-reserve" title="Move all reserved PlayStyles back to active sequence">⬆ Restore All to Main</button>
            </div>
            <div class="reserve-strip" id="fcevo-reservestrip"></div>
          </div>

          <div class="grid" id="fcevo-grid"></div>
        </div>

        <div class="opts">
          <span class="count" id="fcevo-count">0 selected</span>
        </div>
        <div class="row">
          <button class="go" data-act="run" id="fcevo-runbtn" style="flex:1">Apply selected</button>
          <button class="go stop" data-act="stop" style="display:none;flex:1">Stop</button>
        </div>
        <div class="status" id="fcevo-status">Ready.</div>
      </div>`;
    document.body.appendChild(root);
    els = {
      root, search: q("#fcevo-search"), preview: q("#fcevo-preview"), grid: q("#fcevo-grid"),
      count: q("#fcevo-count"), status: q("#fcevo-status"), run: q('[data-act="run"]'), stop: q('[data-act="stop"]'),
      claim: q("#fcevo-claim"), delay: q("#fcevo-delay"),
      settings: q("#fcevo-settings"), startmin: q("#fcevo-startmin"),
      rarbtn: q("#fcevo-rarbtn"),
      trdbtn: q("#fcevo-trdbtn"),
      psfilterbtn: q("#fcevo-psfilterbtn"),
      rarpanel: q("#fcevo-rarpanel"), clubstat: q("#fcevo-clubstat"),
      pos: q("#fcevo-pos"), role: q("#fcevo-role"),
      sortbtn: q("#fcevo-sortbtn"),
      selplayerbanner: q("#fcevo-selplayer-banner"),
      pssearch: q("#fcevo-pssearch"), psmatches: q("#fcevo-psmatches"),
      selstripwrap: q("#fcevo-selstrip-wrap"), selstrip: q("#fcevo-selstrip"),
      reservewrap: q("#fcevo-reserve-wrap"), reservestrip: q("#fcevo-reservestrip"),
      selcount: q("#fcevo-sel-count"), cursorbadge: q("#fcevo-cursor-badge"), mvafterbtn: q("#fcevo-mvafterbtn"),
      reservecount: q("#fcevo-reserve-count"), restoreallbtn: q('[data-act="restore-all-reserve"]'),
      runbtn: q("#fcevo-runbtn"), clearsel: q('[data-act="clearsel"]'),
      evosec: q("#fcevo-evosec"), list: q("#fcevo-list"),
    };
    function q(s) { return root.querySelector(s); }
    function clampPanel() {
      const w = root.offsetWidth, h = root.offsetHeight || 60, m = 8;
      const r = root.getBoundingClientRect();
      let left = r.left, top = r.top, fix = false;
      const maxLeft = Math.max(m, window.innerWidth - w - m);
      const maxTop = Math.max(m, window.innerHeight - Math.min(h, 60));
      if (left > maxLeft) { left = maxLeft; fix = true; }
      if (left < m) { left = m; fix = true; }
      if (top > maxTop) { top = maxTop; fix = true; }
      if (top < m) { top = m; fix = true; }
      if (fix) { root.style.right = "auto"; root.style.left = left + "px"; root.style.top = top + "px"; }
    }

    root.addEventListener("click", onClick);
    els.search.addEventListener("input", (e) => { searchQ = e.target.value.trim().toLowerCase(); renderList(); });
    els.search.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); els.search.value = ""; searchQ = ""; renderList(); } });
    if (els.trdbtn) els.trdbtn.addEventListener("click", onTrdToggle);
    if (els.psfilterbtn) els.psfilterbtn.addEventListener("click", onPsFilterToggle);
    els.search.addEventListener("focus", (e) => { if (state.item) e.target.select(); });
    els.pos.addEventListener("change", onPosChange);
    els.role.addEventListener("change", onRoleChange);

    if (els.pssearch) {
      els.pssearch.addEventListener("input", onPsSearchInput);
      els.pssearch.addEventListener("keydown", onPsSearchKeydown);
    }

    document.addEventListener("keydown", (e) => {
      if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.isContentEditable)) return;
      if (!state.selectedOrder || !state.selectedOrder.length) return;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        state.cursorIndex = Math.max(0, (state.cursorIndex || 0) - 1);
        renderSelectedStrip();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        state.cursorIndex = Math.min(state.selectedOrder.length, (state.cursorIndex || 0) + 1);
        renderSelectedStrip();
      }
    });

    try { if (document.fonts && document.fonts.ready) document.fonts.ready.then(markGlyphs); } catch (_) {}
    populatePositions();
    makeDraggable(root, root.querySelector("header"));
    initTips();
    if (ELIGIBLE_RARITIES && ELIGIBLE_RARITIES.length) {
      ELIGIBLE_RARITIES.forEach((id) => state.rarities.add(id));
      els.rarbtn.textContent = "Rarity: " + state.rarities.size + " ▾";
    }
    setTab("PS+");
    updateGHTab();

    // Restore persisted preferences
    if (Number.isFinite(prefs.delay)) els.delay.value = prefs.delay;
    if (typeof prefs.claim === "boolean") els.claim.checked = prefs.claim;
    if (prefs.pos && prefs.pos.left) { root.style.right = "auto"; root.style.left = prefs.pos.left; root.style.top = prefs.pos.top; }
    clampPanel();
    if (prefs.startMin) { root.classList.add("min"); const mb = root.querySelector('[data-act="min"]'); if (mb) mb.title = "Expand"; }
    els.delay.addEventListener("change", () => savePrefs({ delay: +els.delay.value }));
    els.claim.addEventListener("change", () => savePrefs({ claim: els.claim.checked }));
    els.startmin.checked = !!prefs.startMin;
    els.startmin.addEventListener("change", () => savePrefs({ startMin: els.startmin.checked }));

    window.addEventListener("resize", () => { closeRar(); clampPanel(); });
    // Close the rarity dropdown / settings when clicking outside them.
    document.addEventListener("mousedown", (e) => {
      if (els.rarpanel.classList.contains("open") && !els.rarpanel.contains(e.target) && !els.rarbtn.contains(e.target)) closeRar();
      if (els.settings.style.display !== "none" && !els.settings.contains(e.target) && !e.target.closest('[data-act="settings"]')) closeSettings();
    });
    root.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        if (!state.running) requestRun({ delayMs: +els.delay.value, claim: els.claim.checked });
      } else if (e.key === "Escape" && state.running) { state.abort = true; }
    });
    log("Ready.", "head");
    if (ELIGIBLE_RARITIES.length) log("Search limited to " + ELIGIBLE_RARITIES.length + " eligible rarities (adjust via Rarity ▾).", "dim");
    checkUpdate();
    checkNotice();
    renderList();
    try { new Image().src = METRICS_URL + "?p=/evo/load&t=" + encodeURIComponent("Evo Helper"); } catch (_) {} // anonymous cookieless load ping, best-effort
  }

  // Compare dotted versions: 1 if a>b, -1 if a<b, 0 equal.
  function cmpVer(a, b) {
    const pa = String(a).split("."), pb = String(b).split(".");
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const x = +pa[i] || 0, y = +pb[i] || 0;
      if (x !== y) return x > y ? 1 : -1;
    }
    return 0;
  }
  // Running version straight from the userscript manager, so @version stays the
  // single source of truth (no duplicated literal). null if the manager hides it.
  function runningVersion() {
    try { if (typeof GM_info !== "undefined" && GM_info.script && GM_info.script.version) return GM_info.script.version; } catch (_) {}
    return null;
  }
  // Header "update" badge when main's @version is newer than what's running.
  function checkUpdate() {
    const running = runningVersion();
    if (!running) return; // manager didn't expose it — skip (Tampermonkey still auto-updates)
    fetch(INSTALL_URL + "?t=" + Date.now()).then((r) => r.text()).then((t) => {
      const m = t.match(/@version\s+([0-9.]+)/);
      if (!m || cmpVer(m[1], running) <= 0) return;
      const b = document.getElementById("fcevo-upd");
      if (b) { b.textContent = "⬆ v" + m[1]; b.style.display = ""; }
    }).catch(() => {});
  }
  // Centered popup for an optional broadcast (title/body/link from notice.json).
  function checkNotice() {
    fetch(NOTICE_URL + "?t=" + Date.now()).then((r) => r.json()).then((n) => {
      if (!n) return;
      const title = (n.title || "").trim();
      const body = (n.body || n.message || "").trim();
      if (title || body) {
        const id = "msg|" + title + "|" + body; // remember dismissal per message
        try { if (localStorage.getItem("fcevo:notice-seen") === id) return; } catch (_) {}
        const box = document.getElementById("fcevo-notice");
        const tEl = document.getElementById("fcevo-notice-title");
        const bEl = document.getElementById("fcevo-notice-body");
        const lEl = document.getElementById("fcevo-notice-link");
        if (!box || !tEl || !bEl) return;
        tEl.textContent = title;
        bEl.textContent = body;
        if (lEl) {
          if (n.url) { lEl.textContent = ((n.linkText || "Open").trim()) + " ↗"; lEl.href = n.url; lEl.style.display = ""; }
          else { lEl.style.display = "none"; }
        }
        box.dataset.noticeId = id;
        box.style.display = "";
      }
    }).catch(() => {});
  }

  function onClick(e) {
    const act = e.target.getAttribute("data-act");
    const t = e.target.getAttribute("data-tab");
    if (t) return setTab(t);
    if (act === "min") {
      const r = els.root, rect = r.getBoundingClientRect();
      const mn = r.classList.toggle("min");
      if (mn) {
        r.dataset.exLeft = r.style.left || ""; r.dataset.exRight = r.style.right || "";
        r.style.left = "auto";
        r.style.right = Math.max(4, Math.round(window.innerWidth - rect.right)) + "px";
        closeSettings(); closeRar();
      } else {
        r.style.left = r.dataset.exLeft || ""; r.style.right = r.dataset.exRight || "";
      }
      e.target.closest("button").title = mn ? "Expand" : "Collapse";
      return;
    }
    if (act === "close") { closeSettings(); closeRar(); els.root.remove(); return; }
    if (act === "notice-hide") {
      const box = document.getElementById("fcevo-notice");
      if (box) { try { localStorage.setItem("fcevo:notice-seen", box.dataset.noticeId || "1"); } catch (_) {} box.style.display = "none"; }
      return;
    }
    if (act === "settings") { els.settings.style.display = els.settings.style.display === "none" ? "" : "none"; return; }
    if (act === "reloadclub") return startClubLoad(1, true);
    if (act === "rmevo") {
      const b = e.target.closest("button"); if (!b) return;
      if (state.running) return;
      if (b.dataset.armed === "1") { b.dataset.armed = ""; return removeLastEvo(); }
      b.dataset.armed = "1"; b.textContent = "Confirm remove?"; b.classList.add("armed");
      setTimeout(() => { if (b && b.dataset.armed === "1") { b.dataset.armed = ""; b.textContent = "Remove last evo"; b.classList.remove("armed"); } }, 3500);
      return;
    }
    if (act === "rar") return toggleRarPanel();
    if (act === "psfilter") return onPsFilterToggle();
    if (act === "suggest") return suggest(false);
    if (act === "togglesort") {
      state.sortOrder = state.sortOrder === "cat" ? "alpha" : "cat";
      if (els.sortbtn) {
        els.sortbtn.textContent = state.sortOrder === "alpha" ? "Sort: A-Z ▾" : "Sort: Category ▾";
      }
      renderGrid();
      return;
    }
    if (act === "none") {
      current().forEach((x) => {
        state.selected.delete(x.s);
        state.selectedOrder = state.selectedOrder.filter((s) => s !== x.s);
      });
      renderSelectedStrip(); renderGrid(); updateCount(); updateRunBtn();
      return;
    }
    if (act === "mv-after-to-reserve") {
      const cidx = Math.max(0, Math.min(state.cursorIndex || 0, state.selectedOrder.length));
      const toMove = state.selectedOrder.slice(cidx);
      state.selectedOrder = state.selectedOrder.slice(0, cidx);
      toMove.forEach((s) => {
        if (!state.reserveOrder.includes(s)) state.reserveOrder.push(s);
      });
      renderSelectedStrip();
      updateCount();
      return;
    }
    if (act === "restore-all-reserve") {
      const cidx = Math.max(0, Math.min(state.cursorIndex || 0, state.selectedOrder.length));
      const items = (state.reserveOrder || []).slice();
      items.forEach((s, idx) => {
        state.selectedOrder.splice(cidx + idx, 0, s);
      });
      state.cursorIndex = cidx + items.length;
      state.reserveOrder = [];
      renderSelectedStrip();
      updateCount();
      return;
    }
    if (act === "run") return requestRun({ delayMs: +els.delay.value, claim: els.claim.checked });
    if (act === "stop") return (state.abort = true);
    if (act === "clearsel") {
      state.selected.clear();
      state.selectedOrder = [];
      state.reserveOrder = [];
      state.cursorIndex = 0;
      renderSelectedStrip(); renderGrid(); updateCount(); updateRunBtn();
      log("Selection cleared.", "dim");
      return;
    }
    const rmps = e.target.getAttribute("data-rmps");
    if (rmps != null) {
      const sid = Number(rmps);
      state.selected.delete(sid);
      state.selectedOrder = state.selectedOrder.filter((s) => s !== sid);
      renderSelectedStrip();
      renderGrid();
      updateCount();
      updateRunBtn();
      return;
    }
  }

  const current = () => (tab === "GH4" ? ghForPlayer(state.item) : tab === "PS+" ? PSP : PS);
  function setTab(t) { if (t === "GH4" && ghDisabledReason()) return; tab = t; els.root.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("on", b.getAttribute("data-tab") === t)); renderGrid(); }

  // ---- rarity multi-select ----
  // Anchor the rarity dropdown under its button (right-aligned, since the button
  // sits at the right of the row), clamped to the viewport.
  function positionRar() {
    const r = els.rarbtn.getBoundingClientRect(), p = els.rarpanel, w = 244;
    let left = r.right - w;
    if (left < 8) left = 8;
    p.style.left = Math.round(left) + "px";
    p.style.top = Math.round(r.bottom + 3) + "px";
    p.style.width = w + "px";
  }
  function closeRar() { els.rarpanel.classList.remove("open"); }
  function closeSettings() { if (els.settings) els.settings.style.display = "none"; }
  function toggleRarPanel() {
    const open = els.rarpanel.classList.toggle("open");
    if (!open) return;
    if (!els.rarpanel.dataset.built) renderRarPanel(); else renderRarList();
    positionRar();
    const s = els.rarpanel.querySelector(".rarsearch");
    if (s) s.focus();
  }
  // All rarities (full map ∪ club ids), with club counts, sorted by name.
  function allRaritiesList() {
    const counts = {};
    clubPlayers().forEach((it) => { counts[it.rareflag] = (counts[it.rareflag] || 0) + 1; });
    const ids = new Set([...Object.keys(RARITIES).map(Number), ...Object.keys(counts).map(Number)]);
    return [...ids].map((id) => ({ rf: id, name: RARITIES[id] || ("Rarity " + id), count: counts[id] || 0 }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  function renderRarPanel() {
    els.rarpanel.dataset.built = "1";
    els.rarpanel.innerHTML =
      `<div class="rarhead">` +
        `<input type="text" class="rarsearch" placeholder="filter rarities…">` +
        `<label class="allrar"><input type="checkbox" id="fcevo-rarall" ${state.rarities.size ? "" : "checked"}> all rarities</label>` +
      `</div><div class="rarlist"></div>`;
    const s = els.rarpanel.querySelector(".rarsearch");
    s.value = rarQ;
    s.addEventListener("input", (e) => { rarQ = e.target.value.trim().toLowerCase(); renderRarList(); });
    s.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); closeRar(); } });
    els.rarpanel.querySelector("#fcevo-rarall").addEventListener("change", onRarChange);
    renderRarList();
  }
  function renderRarList() {
    const box = els.rarpanel.querySelector(".rarlist");
    const rs = allRaritiesList().filter((r) => !rarQ || r.name.toLowerCase().includes(rarQ));
    box.innerHTML = rs.length
      ? rs.map((r) => `<label><input type="checkbox" data-rf="${r.rf}" ${state.rarities.has(r.rf) ? "checked" : ""}> ${esc(r.name)}<span class="rc">${r.count ? "×" + r.count : ""}</span></label>`).join("")
      : `<div class="rhint">No rarity matches &ldquo;${esc(rarQ)}&rdquo;</div>`;
    box.querySelectorAll("input").forEach((cb) => cb.addEventListener("change", onRarChange));
  }
  function onRarChange(e) {
    const cb = e.target;
    if (cb.id === "fcevo-rarall") {
      if (cb.checked) state.rarities.clear();
      renderRarList();
    } else {
      const rf = Number(cb.dataset.rf);
      cb.checked ? state.rarities.add(rf) : state.rarities.delete(rf);
      const all = els.rarpanel.querySelector("#fcevo-rarall");
      if (all) all.checked = state.rarities.size === 0;
    }
    els.rarbtn.textContent = "Rarity: " + (state.rarities.size ? state.rarities.size + " ▾" : "all ▾");
    renderList();
  }

  function onTrdToggle() {
    if (state.trdFilter === "all") state.trdFilter = "trd";
    else if (state.trdFilter === "trd") state.trdFilter = "untr";
    else state.trdFilter = "all";

    if (els.trdbtn) {
      if (state.trdFilter === "trd") els.trdbtn.textContent = "Trade: 💰 TRD";
      else if (state.trdFilter === "untr") els.trdbtn.textContent = "Trade: 🔒 UNT";
      else els.trdbtn.textContent = "Trade: all ▾";
    }
    renderList();
  }

  function onPsFilterToggle() {
    if (state.psFilter === "all") state.psFilter = "none";
    else if (state.psFilter === "none") state.psFilter = "has";
    else state.psFilter = "all";

    if (els.psfilterbtn) {
      if (state.psFilter === "none") els.psfilterbtn.textContent = "PS: ⚪ 0 PS";
      else if (state.psFilter === "has") els.psfilterbtn.textContent = "PS: ⚡ Has PS";
      else els.psfilterbtn.textContent = "PS: all ▾";
    }
    renderList();
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
  const ROLE_NAMES_BY_POS = {
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

  function isUntradeableCard(it) {
    if (!it) return false;
    try { if (typeof it.isUntradeable === "function") return !!it.isUntradeable(); } catch (_) {}
    try { if (typeof it.isTradeable === "function") return !it.isTradeable(); } catch (_) {}
    try { if (it.untradeable != null) return !!it.untradeable; } catch (_) {}
    try { if (it._untradeable != null) return !!it._untradeable; } catch (_) {}
    try { if (it.untradable != null) return !!it.untradable; } catch (_) {}
    try { if (it.tradeable != null) return !it.tradeable; } catch (_) {}
    try { if (it._tradeable != null) return !it._tradeable; } catch (_) {}
    try { if (it._itemData && (it._itemData.untradeable || it._itemData._untradeable)) return true; } catch (_) {}
    try { if (it._itemData && typeof it._itemData.isUntradeable === "function") return !!it._itemData.isUntradeable(); } catch (_) {}
    return false;
  }

  const POS_LABEL = {
     0:"GK", 1:"CB", 2:"RB", 3:"LB", 4:"SW", 5:"CB", 6:"CB",
     7:"RWB",8:"LWB",9:"CDM",10:"CDM",11:"CDM",12:"RM",13:"CM",
    14:"CM",15:"CM",16:"LM",17:"CAM",18:"CAM",19:"CAM",20:"RW",
    21:"ST",22:"LW",23:"RW",24:"CF",25:"ST",26:"ST",27:"LW",
  };
  function getPlayerPositions(it) {
    if (!it) return { mainPos: "—", alts: [], all: [] };
    const mainId = it.preferredPosition;
    const mainPos = POS_LABEL[mainId] || "—";
    let altIds = null;
    try { if (Array.isArray(it.possiblePositions)) altIds = it.possiblePositions; } catch (_) {}
    if (!altIds) { try { altIds = it.getBasePossiblePositions(); } catch (_) {} }
    altIds = altIds || [];
    const alts = altIds.filter((id) => id !== mainId).map((id) => POS_LABEL[id] || String(id));
    const all = [...new Set([mainPos, ...alts])];
    return { mainPos, alts, all };
  }
  const SUB_LABELS = {
    "acceleration":"Acceleration", "sprintspeed":"Sprint Speed", "finishing":"Finishing", "shotpower":"Shot Power", "longshots":"Long Shots", "volleys":"Volleys",
    "penalties":"Penalties", "fkaccuracy":"FK Accuracy", "heading":"Heading Accuracy", "curve":"Curve", "shortpassing":"Short Passing", "longpassing":"Long Passing",
    "crossing":"Crossing", "vision":"Vision", "dribbling":"Dribbling", "ballcontrol":"Ball Control", "agility":"Agility", "balance":"Balance",
    "reactions":"Reactions", "composure":"Composure", "interceptions":"Interceptions", "defaware":"Def. Awareness", "standtackle":"Standing Tackle",
    "slidetackle":"Sliding Tackle", "jumping":"Jumping", "stamina":"Stamina", "strength":"Strength", "aggression":"Aggression", "positioning":"Att. Positioning",
    "gkdiving":"GK Diving", "gkhandling":"GK Handling", "gkkicking":"GK Kicking", "gkreflexes":"GK Reflexes", "gkpositioning":"GK Positioning"
  };
  const FACE_OUT = ["PAC", "SHO", "PAS", "DRI", "DEF", "PHY"];
  const FACE_GK  = ["DIV", "HAN", "KIC", "REF", "SPD", "POS"];
  const WORK_RATE = { 0: "Low", 1: "Medium", 2: "High" };
  const FOOT = { 1: "Right", 2: "Left" };
  const BODY_TYPE = { 0: "Lean", 1: "Normal", 2: "Stocky", 3: "Lean (Tall)", 4: "Normal (Tall)", 5: "Stocky (Tall)", 6: "Unique" };

  function calcAge(bd) {
    try {
      const d = typeof bd === "number" && bd < 1e10 ? new Date(bd * 1000) : new Date(bd);
      if (isNaN(d.getTime())) return null;
      const now = new Date();
      let age = now.getFullYear() - d.getFullYear();
      const m = now.getMonth() - d.getMonth();
      if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--;
      return age > 10 && age < 60 ? age : null;
    } catch (_) { return null; }
  }

  function formatDOB(bd) {
    try {
      if (!bd) return "—";
      const d = typeof bd === "number" && bd < 1e10 ? new Date(bd * 1000) : new Date(bd);
      if (isNaN(d.getTime())) return String(bd);
      return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    } catch (_) { return "—"; }
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
  const POS_GROUP_NAME = {
    "GK": "GK", "CB": "CB", "RB": "RB / LB", "LB": "RB / LB", "RWB": "RB / LB", "LWB": "RB / LB",
    "CDM": "CDM", "CM": "CM", "CAM": "CAM", "RM": "RM / LM", "LM": "RM / LM",
    "RW": "RW / LW", "LW": "RW / LW", "ST": "ST", "CF": "ST"
  };
  function getPositionRoles(posList) {
    const out = [];
    (posList || []).forEach((posName) => {
      const group = POS_GROUP_NAME[posName] || posName;
      const roles = ROLE_NAMES_BY_POS[group] || ROLE_NAMES_BY_POS[posName];
      if (roles) out.push({ pos: posName, roles });
    });
    return out;
  }
  function getPlayerFullName(it) {
    if (!it) return "Unknown";
    const { commonName, firstName, lastName, name } = getPlayerNameParts(it);
    const full = [firstName, lastName].filter(Boolean).join(" ");
    if (commonName) return commonName + (full ? ` (${full})` : "");
    return full || name || playerName(it);
  }

  function updateSelPlayerBanner() {
    const banner = els.selplayerbanner || document.getElementById("fcevo-selplayer-banner");
    if (!banner) return;
    if (!state.item) {
      banner.style.display = "none";
      banner.innerHTML = "";
      return;
    }
    const it = state.item;
    const posInfo = getPlayerPositions(it);
    const prefPos = posInfo.mainPos || "—";
    const isUntr = isUntradeableCard(it);
    banner.style.display = "flex";
    banner.innerHTML = `
      <div style="display:flex;align-items:center;gap:6px;width:100%">
        <span style="font-size:13px">👤</span>
        <span style="color:var(--ash);font-size:11px">Working on:</span>
        <b style="color:var(--acc);font-size:12px">${esc(playerName(it))}</b>
        <span class="pos-chip" style="margin:0">${it.rating ?? "?"} ${esc(prefPos)}</span>
        <span class="trd-badge ${isUntr ? "untr" : "trd"}" style="margin:0">${isUntr ? "UNT" : "TRD"}</span>
        <button class="view-btn" data-act="view-attrs-banner" style="margin-left:auto" title="View all attributes & details">View stats ↗</button>
      </div>
    `;
    const vb = banner.querySelector('[data-act="view-attrs-banner"]');
    if (vb) vb.addEventListener("click", () => openAttrModal(it));
  }

  function openAttrModal(it) {
    if (!it) return;
    let modal = document.getElementById("fcevo-attr-modal");
    if (!modal) {
      modal = document.createElement("div");
      modal.id = "fcevo-attr-modal";
      document.body.appendChild(modal);
    }
    modal.className = "fcevo-modal-overlay open";
    modal.style.display = "flex";

    try {
      const sd = (it.getStaticData ? it.getStaticData() : it._staticData) || {};
      const name = playerName(it);
      const fullName = getPlayerFullName(it);
      const rarity = rarityName(it);
      const isGK = isGKItem(it);
      const isUntr = isUntradeableCard(it);
      const is1stOwner = safe(() => (typeof it.isFirstOwner === "function" ? it.isFirstOwner() : !!it.firstOwner)) || false;

      // Positions & Roles
      const posInfo = getPlayerPositions(it);
      const mainPosBadge = `<span class="pos-badge main">${esc(posInfo.mainPos)}</span>`;
      const altPosBadges = posInfo.alts.length
        ? posInfo.alts.map((p) => `<span class="pos-badge alt">${esc(p)}</span>`).join(" ")
        : '<span class="muted" style="font-size:11px">None</span>';

      const posRoles = getPositionRoles(posInfo.all);
      const posRolesHtml = posRoles.map((r) => `
        <div class="sub-cat" style="margin-bottom:4px">
          <div class="sub-h" style="color:#2ea5ff">${esc(r.pos)} Roles</div>
          <div style="font-size:11px;color:#e0eaf4">${esc(r.roles.join(" · "))}</div>
        </div>
      `).join("") || '<div class="muted" style="font-size:11px">Standard position roles</div>';

      // Club / League / Nation
      const nationId = safe(() => sd.nationality ?? it.nationality ?? it.nation);
      const teamId = safe(() => it.teamId ?? sd.teamId);
      const leagueId = safe(() => it.leagueId ?? sd.leagueId);

      const nationName = getNationName(nationId) || (nationId != null ? "Nation " + nationId : "—");
      const teamName = getTeamName(teamId) || (teamId != null ? "Team " + teamId : "—");
      const leagueName = getLeagueName(leagueId) || (leagueId != null ? "League " + leagueId : "—");

      // Match & Chem
      const pStats = getPlayerStats(it);
      const chemStyle = getChemStyleName(it);
      const injStatus = getInjuryDetails(it);

      // Age / DOB
      const dobStr = sd.birthdate || it.birthdate || null;
      const dobFormatted = formatDOB(dobStr);
      const age = safe(() => it.age) ?? safe(() => sd.age) ?? calcAge(dobStr);

      // Physical & Play
      const foot = FOOT[sd.preferredFoot ?? safe(() => it.foot)] || "Right";
      const sm = sd.skillMoves ?? safe(() => it.skillMoves) ?? "?";
      const wf = sd.weakFoot ?? safe(() => it.weakFoot) ?? "?";
      const attWr = WORK_RATE[sd.attackWorkRate ?? safe(() => it.attackWorkRate)] || "Med";
      const defWr = WORK_RATE[sd.defenseWorkRate ?? safe(() => it.defenseWorkRate)] || "Med";
      const height = sd.height ? sd.height + " cm" : (it.height ? it.height + " cm" : "—");
      const weight = sd.weight ? sd.weight + " kg" : (it.weight ? it.weight + " kg" : "—");
      const bodyType = BODY_TYPE[sd.bodyType ?? safe(() => it.bodyType)] || "Average";

      // Face stats
      const faceRaw = safe(() => it.getAttributes ? it.getAttributes() : null)
        || safe(() => Array.isArray(it.attributes) ? it.attributes : null) || [];
      const faceKeys = isGK ? FACE_GK : FACE_OUT;
      const faceStatsHtml = faceKeys.map((k, i) => {
        const val = faceRaw[i] != null ? +faceRaw[i] : "—";
        const cls = typeof val === "number" ? (val >= 90 ? "hi90" : val >= 80 ? "hi80" : val >= 70 ? "mid" : "lo") : "";
        return `<div class="face-stat ${cls}"><div class="fv">${val}</div><div class="fl">${k}</div></div>`;
      }).join("");

      // Sub-attributes
      const subMap = {};
      (safe(() => it.getSubAttributes()) || []).forEach((s) => {
        const key = SUB_ATTR[s && s.type];
        if (key && s.rating > 0) subMap[key] = s.rating;
      });

      const categories = isGK ? [
        { name: "Goalkeeping", keys: ["gkdiving", "gkhandling", "gkkicking", "gkreflexes", "gkpositioning"] },
        { name: "Physicality & Pace", keys: ["acceleration", "sprintspeed", "reactions", "jumping", "strength"] }
      ] : [
        { name: "Pace", keys: ["acceleration", "sprintspeed"] },
        { name: "Shooting", keys: ["positioning", "finishing", "shotpower", "longshots", "volleys", "penalties"] },
        { name: "Passing", keys: ["vision", "crossing", "fkaccuracy", "shortpassing", "longpassing", "curve"] },
        { name: "Dribbling", keys: ["agility", "balance", "reactions", "composure", "ballcontrol", "dribbling"] },
        { name: "Defending", keys: ["interceptions", "heading", "defaware", "standtackle", "slidetackle"] },
        { name: "Physicality", keys: ["jumping", "stamina", "strength", "aggression"] }
      ];

      const subCatsHtml = categories.map((cat) => {
        const rows = cat.keys.map((k) => {
          const label = SUB_LABELS[k] || k;
          const val = subMap[k] != null ? subMap[k] : "—";
          const cls = typeof val === "number" ? (val >= 90 ? "hi90" : val >= 80 ? "hi80" : val >= 70 ? "mid" : "lo") : "";
          return `<div class="sub-row"><span class="sub-l">${label}</span><span class="sub-v ${cls}">${val}</span></div>`;
        }).join("");
        return `<div class="sub-cat"><div class="sub-h">${cat.name}</div><div class="sub-grid">${rows}</div></div>`;
      }).join("");

      // PlayStyles safely extracted
      const rawPS = safe(() => (typeof it.getPlayStyles === "function" ? it.getPlayStyles() : it._playStyles)) || [];
      const psHtml = (Array.isArray(rawPS) ? rawPS : []).map((p) => {
        const nm = traitName[p && p.traitId] || ("PlayStyle " + (p && p.traitId != null ? p.traitId : ""));
        const isPlus = !!(p && (p.isIcon || p.isPlus));
        return `<div class="ps-item ${isPlus ? "plus" : "base"}"><span>${isPlus ? "🌟 " : "🔹 "}${esc(nm)}${isPlus ? " +" : ""}</span></div>`;
      }).join("") || '<div class="muted" style="font-size:11px">No PlayStyles</div>';

      modal.innerHTML = `
        <div class="fcevo-modal-dialog">
          <button class="fcevo-modal-close" id="fcevo-attr-close">&times;</button>
          <div class="attr-hdr">
            <div class="attr-ovr">${it.rating ?? "?"}</div>
            <div class="attr-info">
              <div class="attr-name">${esc(fullName)} ${isGK ? '<span class="gk">GK</span>' : ""}</div>
              <div class="attr-meta">
                <span>${esc(rarity)}</span> ·
                <span class="trd-badge ${isUntr ? "untr" : "trd"}">${isUntr ? "🔒 UNTRADEABLE" : "💰 TRADEABLE"}</span>
                ${is1stOwner ? '<span class="trd-badge trd" style="margin-left:2px">1ST OWNER</span>' : ""}
              </div>
            </div>
          </div>

          <div class="attr-sec-title">Positions &amp; Biography</div>
          <div class="attr-meta-strip full-bio">
            <div class="mitem"><small>Primary Position</small><b>${mainPosBadge}</b></div>
            <div class="mitem"><small>Alternate Positions</small><div style="margin-top:2px">${altPosBadges}</div></div>
            <div class="mitem"><small>Club / Team</small><b>${esc(teamName)}</b></div>
            <div class="mitem"><small>League</small><b>${esc(leagueName)}</b></div>
            <div class="mitem"><small>Nation / Country</small><b>${esc(nationName)}</b></div>
            <div class="mitem"><small>Date of Birth / Age</small><b>${dobFormatted} ${age != null ? `(${age} yrs)` : ""}</b></div>
          </div>

          <div class="attr-sec-title">Match Statistics &amp; Chemistry</div>
          <div class="attr-meta-strip full-bio">
            <div class="mitem"><small>Chemistry Style</small><b>🧪 ${esc(chemStyle)}</b></div>
            <div class="mitem"><small>Games Played</small><b>🏟️ ${pStats.games} matches</b></div>
            <div class="mitem"><small>Goals / Assists</small><b>⚽ ${pStats.goals} goals / 🅰️ ${pStats.assists} assists</b></div>
            <div class="mitem"><small>Cards</small><b>🟨 ${pStats.yellowCards} yellow / 🟥 ${pStats.redCards} red</b></div>
            <div class="mitem"><small>Injury Details</small><b>${injStatus.includes("Injured") ? "🚑 " + esc(injStatus) : "🟢 Healthy"}</b></div>
            <div class="mitem"><small>Ownership</small><b>${is1stOwner ? "✨ First Owner" : "💼 Bought / Traded"}</b></div>
          </div>

          <div class="attr-sec-title">Position Roles (FC 26)</div>
          <div class="sub-cats-wrapper" style="grid-template-columns:1fr">
            ${posRolesHtml}
          </div>

          <div class="attr-sec-title">Physical &amp; Skill Attributes</div>
          <div class="attr-meta-strip">
            <div class="mitem"><small>Preferred Foot</small><b>${foot}</b></div>
            <div class="mitem"><small>Skill Moves</small><b>${sm}★</b></div>
            <div class="mitem"><small>Weak Foot</small><b>${wf}★</b></div>
            <div class="mitem"><small>Work Rates (Att / Def)</small><b>${attWr} / ${defWr}</b></div>
            <div class="mitem"><small>Height / Weight</small><b>${height} / ${weight}</b></div>
            <div class="mitem"><small>Body Type</small><b>${bodyType}</b></div>
          </div>

          <div class="attr-sec-title">Face Stats</div>
          <div class="face-grid">${faceStatsHtml}</div>

          <div class="attr-sec-title">Detailed Sub-Attributes</div>
          <div class="sub-cats-wrapper">${subCatsHtml}</div>

          <div class="attr-sec-title">PlayStyles</div>
          <div class="ps-grid">${psHtml}</div>
        </div>
      `;

      const closeModal = () => {
        modal.classList.remove("open");
        modal.style.display = "none";
        document.removeEventListener("keydown", onEsc);
      };
      const onEsc = (e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          closeModal();
        }
      };
      document.addEventListener("keydown", onEsc);

      const closeBtn = modal.querySelector("#fcevo-attr-close");
      if (closeBtn) closeBtn.onclick = closeModal;
      modal.onclick = (e) => {
        if (e.target === modal) closeModal();
      };
    } catch (err) {
      console.error("[FCEvo] openAttrModal failed:", err);
      modal.classList.remove("open");
      modal.style.display = "none";
    }
  }

  // ---- player results ----
  // Colored PS+/PS usage chips (green=room, red=at cap). Shared by both lists.
  function psChips(it) {
    try {
      const np = numPlus(it), nb = numBasic(it);
      if (np == null && nb == null) return "";
      const cp = capPlus(it) || 4, cb = capBasic(it) || 8;
      const plusFull = (np ?? 0) >= cp, baseFull = (nb ?? 0) >= cb;
      return '<span class="psc">'
        + '<span class="pchip ' + (plusFull ? "full" : "room") + '" title="PlayStyle+ used / cap">+' + (np ?? "?") + '/' + cp + '</span>'
        + '<span class="pchip ' + (baseFull ? "full" : "room") + '" title="Basic PlayStyles used / cap">' + (nb ?? "?") + '/' + cb + '</span>'
        + '</span>';
    } catch (_) { return ""; }
  }
  // Unified club row for BOTH modes: OVR, name, GK, PS+/PS usage chips. Single mode
  // selects the player on click; Auto mode toggles them in the queue on click.
  const LIST_CAP = 500;
  let listCapOverride = null;
  function playerRow(it) {
    const row = document.createElement("div");
    const hasEvos = (numPlus(it) ?? 0) > 0 || (numBasic(it) ?? 0) > 0;
    const active = state.item && state.item.id === it.id;
    row.className = "pr" + (hasEvos ? " hasps" : "") + (active ? " on" : "");
    const isUntr = isUntradeableCard(it);
    const posInfo = getPlayerPositions(it);
    const prefPos = posInfo.mainPos || "—";
    const rar = rarityName(it);
    const posBadge = `<span class="pos-chip" title="Preferred Position: ${esc(prefPos)}">${esc(prefPos)}</span>`;
    const rarBadge = rar ? `<span class="pos-chip rar-chip" style="background:rgba(139,92,246,0.15);color:#a78bfa;border:1px solid rgba(139,92,246,0.3);margin-left:3px" title="Card Rarity: ${esc(rar)}">${esc(rar)}</span>` : "";
    const trdBadge = `<span class="trd-badge ${isUntr ? "untr" : "trd"}" title="${isUntr ? "Untradeable card" : "Tradeable card"}">${isUntr ? "UNT" : "TRD"}</span>`;
    row.innerHTML =
      `<span class="ov">${it.rating ?? "?"}</span>`
      + `<span class="nm">${esc(playerName(it))}${posBadge}${rarBadge}${trdBadge}</span>`
      + psChips(it)
      + `<button class="view-btn" data-act="view-attrs" title="View all attributes & details">View</button>`;
    row.addEventListener("click", (e) => {
      if (e.target.closest("[data-act='view-attrs']")) {
        e.stopPropagation();
        openAttrModal(it);
        return;
      }
      selectPlayer(it);
    });
    return row;
  }

  function renderList() {
    const box = els.list; if (!box) return; box.innerHTML = "";
    const all = clubPlayers().filter((it) => !!it);
    if (!all.length) { box.innerHTML = clubPlayers().length ? `<div class="rhint">No evolvable players &mdash; all owned or ineligible.</div>` : ``; updateRunBtn(); return; }
    const matches = (searchQ || state.trdFilter !== "all" || state.psFilter !== "all" ? all.filter((it) => {
      const isUntr = isUntradeableCard(it);
      if (state.trdFilter === "trd" && isUntr) return false;
      if (state.trdFilter === "untr" && !isUntr) return false;

      const nP = numPlus(it) ?? 0;
      const nB = numBasic(it) ?? 0;
      const totalPS = nP + nB;

      if (state.psFilter === "none" && totalPS > 0) return false;
      if (state.psFilter === "has" && totalPS === 0) return false;

      if (!searchQ) return true;
      const { commonName, firstName, lastName, name } = getPlayerNameParts(it);
      const pName = playerName(it).toLowerCase();
      const fName = getPlayerFullName(it).toLowerCase();
      const rName = rarityName(it).toLowerCase();
      const q = searchQ.toLowerCase();
      return pName.includes(q) ||
             fName.includes(q) ||
             rName.includes(q) ||
             (commonName && commonName.toLowerCase().includes(q)) ||
             (firstName && firstName.toLowerCase().includes(q)) ||
             (lastName && lastName.toLowerCase().includes(q)) ||
             (name && name.toLowerCase().includes(q));
    }) : all)
      .sort((a, b) => (b.rating || 0) - (a.rating || 0));
    if (!matches.length) { box.innerHTML = `<div class="rhint">No player matches search or trade filter</div>`; updateRunBtn(); return; }
    
    const cap = listCapOverride || LIST_CAP;
    const visible = matches.slice(0, cap);
    visible.forEach((it) => box.appendChild(playerRow(it)));
    if (visible.some((it) => playerName(it).startsWith("Player #"))) {
      ensureItemDefinitionsLoaded(visible).then(() => { try { renderList(); } catch (_) {} });
    }
    const extra = matches.length - cap;
    if (extra > 0) {
      const hint = document.createElement("div");
      hint.className = "rhint";
      hint.style.display = "flex";
      hint.style.alignItems = "center";
      hint.style.justifyContent = "space-between";
      hint.innerHTML = `<span>+${extra} more &mdash; type to filter</span> <button class="mini showallbtn" style="padding:2px 7px;cursor:pointer">Show all ${matches.length}</button>`;
      hint.querySelector(".showallbtn").addEventListener("click", () => {
        listCapOverride = matches.length + 100;
        renderList();
      });
      box.appendChild(hint);
    } else {
      box.insertAdjacentHTML("beforeend", `<div class="rhint">${matches.length} evolvable players</div>`);
    }
    updateRunBtn();
  }

  function openEntity() {
    if (typeof window.getAppMain !== "function") return null;
    let root; try { root = window.getAppMain().getRootViewController(); } catch (_) { return null; }
    if (!root || typeof root !== "object") return null;
    const seen = new Set(), stack = [root], hits = [];
    const isItem = (v) => v && typeof v.isPlayer === "function" && typeof v.getAttributes === "function";
    for (let i = 0; i < 500 && stack.length; i++) {
      const vc = stack.shift();
      if (!vc || typeof vc !== "object" || seen.has(vc)) continue;
      seen.add(vc);
      let kids = [];
      try {
        kids = [].concat(vc.childViewControllers || [])
          .concat(vc.currentController || [])
          .concat((vc.presentationController && vc.presentationController.presentedViewController) || [])
          .concat((vc.getPresentedViewController && vc.getPresentedViewController()) || []);
      } catch (_) {}
      for (const k of kids) if (k && !seen.has(k)) stack.push(k);
      let keys = []; try { keys = Object.keys(vc); } catch (_) {}
      for (const key of keys) {
        let v; try { v = vc[key]; } catch (_) { continue; }
        if (isItem(v)) { hits.push(v); break; }
      }
    }
    return hits.length ? hits[hits.length - 1] : null;
  }

  function selectPlayer(it) {
    if (!it) {
      state.item = null;
      renderPreview();
      renderList();
      updateSelPlayerBanner();
      populatePositions();
      return;
    }
    state.item = it;
    state.selected.clear();
    state.selectedOrder = [];
    state.suggestedSlots.clear();
    searchQ = "";
    if (els.search) els.search.value = playerName(it);
    renderList();
    renderPreview();
    updateSelPlayerBanner();
    populatePositions(); // populates positions restricted to this player

    // Auto-resolve primary position & default role
    const rr = autoResolveRole(it);
    if (rr) {
      if (els.pos && rr.pos) els.pos.value = rr.pos;
      populateRoles();
      if (els.role && rr.role) els.role.value = rr.role;
    }

    // Auto-suggest and pre-select playstyles right away!
    suggest(true);

    renderPreview();
    renderGrid();
    renderSelectedStrip();
    updateCount();
    updateRunBtn();
    log("🎯 Selected " + playerName(it) + " (" + (it.rating ?? "?") + " " + (rr ? rr.pos : "") + ") — PlayStyles auto-suggested.", "head");
    updateGHTab();
  }

  function ghTabBtn() { return els.root && els.root.querySelector('.tabs button[data-tab="GH4"]'); }
  const ghKinds = () => new Set(GH.map((g) => g.n)).size;
  function ghDisabledReason() {
    const it = state.item;
    if (!it) return "Select a player first";
    if (!is4PSPlusEligible(it)) return "FUTTIES, Glory Hunters, or 4-PS+ cards only";
    const np = numPlus(it) ?? 0;
    if (np >= 4) return "Already has 4 PS+";
    return "";
  }
  function updateGHTab() {
    const btn = ghTabBtn(); if (!btn) return;
    const reason = ghDisabledReason();
    const enabled = !reason;
    btn.classList.toggle("disabled", !enabled);
    btn.setAttribute("data-tip", "4th PlayStyle+|" + (enabled
      ? "Add a 4th PS+ to this card via a reward evo — pick one below."
      : reason));
    const paint = () => {
      const b = ghTabBtn(); if (!b) return;
      b.textContent = "4th PS+" + (ghLoaded && ghKinds() ? " (" + ghKinds() + ")" : "");
      if (state.item && !ghDisabledReason() && tab === "GH4") { renderGrid(); updateCount(); }
    };
    if (!enabled) { if (tab === "GH4") setTab("PS+"); paint(); return; }
    if (ghLoaded) { paint(); return; }
    log("Loading 4th PlayStyle+ evos…", "dim");
    loadGHEvos().then(() => {
      paint();
      if (GH.length) log(`4th PlayStyle+ evos ready — ${ghKinds()} playstyle${ghKinds() === 1 ? "" : "s"}.`, "head");
      else if (ghLoaded) log("No 4th PS+ reward evos on this account.", "warn");
      else log("Couldn't load 4th PS+ evos — will retry on next select.", "warn");
    });
  }

  // ---- role-based suggestion ----
  function populatePositions() {
    if (state.item) {
      const groups = playerPositionGroups(state.item);
      const list = groups.length ? groups : Object.keys(ROLES);
      els.pos.innerHTML = list.map((p) => `<option value="${esc(p)}">${esc(p)}</option>`).join("");
    } else {
      els.pos.innerHTML = '<option value="">position…</option>' + Object.keys(ROLES).map((p) => `<option value="${esc(p)}">${esc(p)}</option>`).join("");
    }
    populateRoles();
  }
  function populateRoles() {
    const pos = els.pos ? els.pos.value : "";
    const rs = pos && ROLES[pos] ? Object.keys(ROLES[pos]) : [];
    if (els.role) {
      els.role.innerHTML = rs.length
        ? rs.map((r) => `<option value="${esc(r)}">${esc(r)}</option>`).join("")
        : '<option value="">role…</option>';
    }
  }
  function onPosChange() {
    populateRoles();
    if (state.item && els.pos.value && els.role.value) {
      suggest(true);
    }
  }
  function onRoleChange() {
    if (state.item && els.pos.value && els.role.value) {
      suggest(true);
    }
  }

  function suggestedSlots(it, pos, role) {
    const names = (ROLES[pos] && ROLES[pos][role]) || [];
    const gk = isGKItem(it);
    const maxPlus = capPlus(it) || (is4PSPlusEligible(it) ? 4 : 3);
    const maxBasic = capBasic(it) || 8;
    let plusUsed = numPlus(it) ?? 0, baseUsed = numBasic(it) ?? 0, owned = 0;
    const slots = [], skip = [];
    names.forEach((name, idx) => {
      const wantPlus = idx < maxPlus && plusUsed < maxPlus;
      const evo = wantPlus ? pspByName[name] : psByName[name];
      if (!evo) { skip.push(name); return; }
      if (evo.g && !gk) { skip.push(name + " (GK-only)"); return; }
      if (hasEvo(it, evo)) { owned++; return; }
      if (evo.kind === "PS") { let po = false; try { po = !!it.hasPlusPlayStyle(evoTrait(evo)); } catch (_) {} if (po) { owned++; return; } }
      if (wantPlus) { if (plusUsed >= maxPlus) { skip.push(name + "+ (no room)"); return; } plusUsed++; }
      else { if (baseUsed >= maxBasic) { skip.push(name + " (no room)"); return; } baseUsed++; }
      slots.push(evo.s);
    });
    return { slots, owned, skip };
  }

  function suggest(isAuto = false) {
    if (!state.item) return log("✋ Select a player first.", "warn");
    const pos = els.pos ? els.pos.value : "";
    const role = els.role ? els.role.value : "";
    if (!pos || !role || !ROLES[pos] || !ROLES[pos][role]) {
      if (!isAuto) log("✋ Pick a position and role.", "warn");
      return;
    }
    const { slots, owned, skip } = suggestedSlots(state.item, pos, role);
    state.suggestedSlots = new Set(slots);
    state.selected.clear();
    state.selectedOrder = [];
    slots.forEach((s) => {
      state.selected.add(s);
      state.selectedOrder.push(s);
    });
    setTab(idxTab());
    renderGrid();
    renderSelectedStrip();
    updateCount();
    updateRunBtn();
    const msg = `✨ Preselected ${slots.length} evo${slots.length === 1 ? "" : "s"} for ${pos} · ${role}${owned ? ` (${owned} owned)` : ""}.`;
    log(msg, "head");
    if (skip.length && !isAuto) log("   skipped: " + skip.join(", "), "dim");
  }

  const ATT = (it, i) => { try { const a = (it.getAttributes && it.getAttributes()) || it.attributes; return a && a[i] != null ? +a[i] : null; } catch (_) { return null; } };
  const FACE_LABELS = ["PAC", "SHO", "PAS", "DRI", "DEF", "PHY"];
  const GK_LABELS = ["DIV", "HAN", "KIC", "REF", "SPD", "POS"];
  function statRow(it) {
    const labels = isGKItem(it) ? GK_LABELS : FACE_LABELS;
    const cells = labels.map((lab, i) => {
      const v = ATT(it, i);
      const tier = v == null ? "" : v >= 85 ? "hi" : v >= 70 ? "mid" : "lo";
      return `<div class="stat ${tier}"><b>${v ?? "—"}</b><small>${lab}</small></div>`;
    }).join("");
    return `<div class="statrow">${cells}</div>`;
  }
  const DEFAULT_ROLE = {
    "ST": "Advanced Forward", "RW / LW": "Inside Forward", "RM / LM": "Inside Forward",
    "CAM": "Shadow Striker", "CM": "Box to Box", "CDM": "Deep Lying Playmaker",
    "RB / LB": "Fullback", "CB": "Defender", "GK": "Goalkeeper",
    "RW": "Inside Forward", "LW": "Inside Forward", "RM": "Inside Forward", "LM": "Inside Forward",
    "RB": "Fullback", "LB": "Fullback", "RWB": "Wingback", "LWB": "Wingback"
  };
  const CM_DLP_RATIO = 0.94;
  function autoResolveRole(it) {
    let pos = POS_GROUP[it && it.preferredPosition];
    if (!pos) { const g = playerPositionGroups(it); pos = g && g[0]; }
    if (!pos) pos = "ST";
    let role = DEFAULT_ROLE[pos] || (ROLES[pos] ? Object.keys(ROLES[pos])[0] : "Advanced Forward");
    if (pos === "CM") {
      const sho = ATT(it, 1), def = ATT(it, 4);
      if (sho != null && def != null && def > 0) {
        if (sho / def <= CM_DLP_RATIO) role = "Deep Lying Playmaker";
        else if (def < 80 && sho > def) role = "Playmaker";
      }
    }
    if (!ROLES[pos] || !ROLES[pos][role]) role = ROLES[pos] ? Object.keys(ROLES[pos])[0] : role;
    return { pos, role };
  }

  function updateRunBtn() {
    if (!els.runbtn) return;
    clearTimeout(_armTimer); els.runbtn.dataset.armed = ""; els.runbtn.classList.remove("armed");
    const n = state.selected.size;
    els.runbtn.textContent = n ? `Apply ${n} Selected Evolution${n > 1 ? "s" : ""}` : "Apply Selected Evolutions";
    if (els.clearsel) els.clearsel.style.display = n > 0 ? "" : "none";
  }
  function disarmRun() { clearTimeout(_armTimer); if (els.runbtn) { els.runbtn.dataset.armed = ""; els.runbtn.classList.remove("armed"); } updateRunBtn(); }
  function requestRun(opts) {
    if (state.running) return;
    if (!state.item) return log("✋ No player selected — select a player from the list.", "warn");
    if (!state.selected.size) return log("✋ No evolutions selected — select playstyles to apply.", "warn");

    // Confirmation if the card is tradeable
    const isUntr = isUntradeableCard(state.item);
    if (!isUntr) {
      const pName = playerName(state.item);
      const msg = `⚠️ TRADEABLE CARD WARNING!\n\n` +
        `"${pName}" is currently a TRADEABLE card.\n\n` +
        `Applying PlayStyle evolutions will permanently convert this card into an UNTRADEABLE card that cannot be sold on the Transfer Market.\n\n` +
        `Are you sure you want to apply ${state.selected.size} evolution(s) to this tradeable card?`;
      if (!window.confirm(msg)) {
        log(`✋ Evolution cancelled: "${pName}" is tradeable.`, "warn");
        return;
      }
    }

    return runDispatch(opts);
  }

  function dumpEntity() {
    const it = state.item;
    if (!it) { log("✋ Select a player first.", "warn"); return null; }
    const numeric = Object.keys(it).filter((k) => typeof it[k] === "number");
    const dump = {
      id: it.id, rating: it.rating, height: it.height, weight: it.weight,
      numericProps: numeric, ownKeys: Object.keys(it),
      protoMethods: Object.getOwnPropertyNames(Object.getPrototypeOf(it) || {}),
      attributeList: it.attributeList, attributeArray: it.attributeArray,
      coverage: readAttrs(it)._coverage,
    };
    console.log("[FCEvo] entity dump:", dump);
    log("🔬 Entity dumped to console.", "head");
    return dump;
  }
  function idxTab() {
    const selPlus = [...state.selected].filter((s) => byId(s) && byId(s).kind === "PS+").length;
    return selPlus >= state.selected.size - selPlus ? "PS+" : "PS";
  }

  function renderPreview() {
    const box = els.preview;
    if (!box) return;
    if (!state.item) { box.style.display = "none"; return; }
    const it = state.item;
    const gk = (() => { try { return it.isGK(); } catch (_) { return false; } })();
    const nb = numBasic(it), np = numPlus(it), cp = capPlus(it), cb = capBasic(it);
    const basicFull = nb != null && nb >= cb, plusFull = np != null && np >= cp;
    const posInfo = getPlayerPositions(it);
    const prefPos = posInfo.mainPos || "—";
    const isUntr = isUntradeableCard(it);
    box.style.display = "";
    box.innerHTML = `
      <div class="card" style="border:1px solid rgba(51,214,193,0.5);background:rgba(51,214,193,0.06);box-shadow:0 4px 14px rgba(51,214,193,0.12)">
        <div class="ov">${it.rating ?? "?"}</div>
        <div class="meta">
          <div class="pn">${esc(playerName(it))} ${gk ? '<span class="gk" style="font-size:10px;color:var(--acc)">GK</span>' : ""}</div>
          <div class="muted" style="display:flex;align-items:center;gap:4px;margin-top:2px">
            <span class="pos-chip" style="margin:0">${esc(prefPos)}</span>
            <span>${esc(rarityName(it))}</span>
            <span class="trd-badge ${isUntr ? "untr" : "trd"}" style="margin:0">${isUntr ? "UNT" : "TRD"}</span>
            <button class="view-btn" data-act="view-attrs-preview" style="margin-left:auto" title="View all attributes & details">View stats ↗</button>
          </div>
        </div>
      </div>
      ${statRow(it)}
      <div class="caps">
        <div class="cap ${plusFull ? "full" : ""}"><b>${np ?? "?"}/${cp}</b><small>PS+ capacity</small></div>
        <div class="cap ${basicFull ? "full" : ""}"><b>${nb ?? "?"}/${cb}</b><small>Basic capacity</small></div>
      </div>
      <div class="psrow">${currentPlayStyles(it).map((p) => {
        const nm = traitName[p.traitId] || ("trait " + p.traitId);
        return `<div class="chip ${p.isIcon ? "ic" : ""}" data-ini="${esc(initials(nm))}" data-tip="${esc(dispName(nm))}${p.isIcon ? " +" : ""}|${esc(psDesc(nm))}"><i class="${iconClass(p.isIcon, p.traitId)}"></i></div>`;
      }).join("") || '<span class="muted">no playstyles</span>'}</div>` +
      (canRemoveEvo(it) && evoRemovalEnabled()
        ? `<div class="row" style="margin-top:9px;justify-content:flex-end"><button class="mini rmevo" data-act="rmevo" data-tip="Remove last evo|Removes the most recently applied PlayStyle upgrade from this player. Click once to arm, again to confirm.">Remove last evo</button></div>`
        : "");
    
    const vb = box.querySelector('[data-act="view-attrs-preview"]');
    if (vb) vb.addEventListener("click", () => openAttrModal(it));
    markGlyphs();
  }

  // ---- evo grid ----
  function evoCard(evo, it, gkPlayer) {
    const owned = it ? hasEvo(it, evo) : false;
    let plusBlocked = false;
    if (it && evo.kind === "PS") {
      let plusOwned = false; try { plusOwned = !!it.hasPlusPlayStyle(evoTrait(evo)); } catch (_) {}
      const plusSel = [...state.selected].some((s) => { const e = byId(s); return e && e.kind === "PS+" && e.r === evo.r; });
      plusBlocked = plusOwned || plusSel;
    }
    const wrongScope = it ? (!!evo.g && !gkPlayer) : false;
    const dis = wrongScope || owned || !!evo.disGH || plusBlocked;
    const isSuggested = state.suggestedSlots && state.suggestedSlots.has(evo.s);
    const sel = state.selected.has(evo.s);
    const card = document.createElement("div");
    card.className = "ec" + (evo.kind === "PS+" ? " psp" : "") + (sel ? " sel" : "") + (isSuggested ? " sug-pick" : "") + (owned ? " owned" : "") + (dis ? " dis" : "");
    const nm = dispName(baseName(evo));
    const tipTitle = nm + (evo.kind === "PS+" ? " +" : "")
      + (isSuggested ? " · ✨ Recommended for role" : "")
      + (wrongScope ? " · goalkeepers only" : "") + (owned ? " · already owned" : "")
      + (plusBlocked && !owned ? " · + version already applied/selected" : "")
      + (evo.disGH && !owned ? " · needs 3 PS+ first" : "");
    card.setAttribute("data-tip", tipTitle + "|" + psDesc(baseName(evo)));
    card.innerHTML = `<div class="ico" data-ini="${esc(initials(nm))}"><i class="${iconClass(evo.kind === "PS+", evoTrait(evo))}"></i></div>` +
      `<div class="nm">${esc(nm)}</div>` +
      (isSuggested && !owned ? '<span class="sug-badge" title="Recommended for role">✨</span>' : '') +
      (owned ? '<span class="own" aria-label="owned"></span>' : "");
    if (!dis) card.addEventListener("click", () => toggleEvo(evo, card));
    return card;
  }
  function hidePsMatches() {
    if (els.psmatches) {
      els.psmatches.style.display = "none";
      els.psmatches.innerHTML = "";
    }
  }

  let draggedSlotId = null;
  let draggedSource = "main"; // "main" | "reserve"

  function renderReserveStrip() {
    const wrap = els.reservewrap || document.getElementById("fcevo-reserve-wrap");
    const box = els.reservestrip || document.getElementById("fcevo-reservestrip");
    const countEl = els.reservecount || document.getElementById("fcevo-reserve-count");
    if (!box) return;

    state.reserveOrder = (state.reserveOrder || []).filter((s) => state.selected.has(s));

    if (!state.reserveOrder.length) {
      if (wrap) wrap.style.display = "none";
      box.style.display = "none";
      box.innerHTML = "";
      return;
    }

    if (wrap) wrap.style.display = "block";
    box.style.display = "flex";
    if (countEl) countEl.textContent = String(state.reserveOrder.length);
    box.innerHTML = "";

    // Reserve drop zone (accepts items dragged from main sequence)
    box.addEventListener("dragover", (e) => {
      e.preventDefault();
      try { e.dataTransfer.dropEffect = "move"; } catch (_) {}
      box.classList.add("drag-over");
    });
    box.addEventListener("dragleave", () => {
      box.classList.remove("drag-over");
    });
    box.addEventListener("drop", (e) => {
      e.preventDefault();
      box.classList.remove("drag-over");
      if (draggedSlotId == null || draggedSource !== "main") return;
      const sid = draggedSlotId;
      state.selectedOrder = state.selectedOrder.filter((s) => s !== sid);
      if (!state.reserveOrder.includes(sid)) state.reserveOrder.push(sid);
      state.cursorIndex = Math.min(state.cursorIndex || 0, state.selectedOrder.length);
      renderSelectedStrip();
      renderReserveStrip();
      updateCount();
    });

    state.reserveOrder.forEach((sid) => {
      const evo = byId(sid);
      if (!evo) return;
      const isPlus = evo.kind === "PS+";
      const nm = dispName(baseName(evo));

      const chip = document.createElement("div");
      chip.className = `reserve-chip ${isPlus ? "psp" : ""}`;
      chip.draggable = true;
      chip.dataset.slotid = sid;
      chip.setAttribute("title", `Reserved: ${nm}${isPlus ? "+" : ""} (Drag to active sequence or click ⬆ Main)`);

      chip.innerHTML = `
        <span class="drag-grip">⠿</span>
        <span>${esc(nm)}${isPlus ? "+" : ""}</span>
        <button class="chip-rest" data-act="to-main" title="Restore to main sequence at cursor">⬆ Main</button>
        <button class="chip-x" data-act="rm-reserve" title="Remove ${esc(nm)}">✕</button>
      `;

      chip.addEventListener("dragstart", (e) => {
        draggedSlotId = sid;
        draggedSource = "reserve";
        chip.classList.add("dragging");
        try {
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", String(sid));
        } catch (_) {}
      });

      chip.addEventListener("dragend", () => {
        draggedSlotId = null;
        chip.classList.remove("dragging");
      });

      chip.addEventListener("click", (e) => {
        const act = e.target.getAttribute("data-act");
        if (act === "to-main") {
          e.stopPropagation();
          state.reserveOrder = state.reserveOrder.filter((s) => s !== sid);
          const cidx = Math.max(0, Math.min(state.cursorIndex || 0, state.selectedOrder.length));
          state.selectedOrder.splice(cidx, 0, sid);
          state.cursorIndex = cidx + 1;
          renderSelectedStrip();
          renderReserveStrip();
          updateCount();
        } else if (act === "rm-reserve") {
          e.stopPropagation();
          state.selected.delete(sid);
          state.reserveOrder = state.reserveOrder.filter((s) => s !== sid);
          renderSelectedStrip();
          renderReserveStrip();
          renderGrid();
          updateCount();
          updateRunBtn();
        }
      });

      box.appendChild(chip);
    });
  }

  function renderSelectedStrip() {
    const wrap = els.selstripwrap || document.getElementById("fcevo-selstrip-wrap");
    const box = els.selstrip || document.getElementById("fcevo-selstrip");
    const countEl = els.selcount || document.getElementById("fcevo-sel-count");
    const badgeEl = els.cursorbadge || document.getElementById("fcevo-cursor-badge");
    const mvBtn = els.mvafterbtn || document.getElementById("fcevo-mvafterbtn");
    if (!box) return;

    // Sync selectedOrder & reserveOrder with selected Set
    state.selectedOrder = (state.selectedOrder || []).filter((s) => state.selected.has(s) && !(state.reserveOrder || []).includes(s));
    state.reserveOrder = (state.reserveOrder || []).filter((s) => state.selected.has(s));

    // Any items in selected Set not in selectedOrder or reserveOrder go to selectedOrder
    state.selected.forEach((s) => {
      if (!state.selectedOrder.includes(s) && !state.reserveOrder.includes(s)) {
        const cidx = Math.max(0, Math.min(state.cursorIndex || 0, state.selectedOrder.length));
        state.selectedOrder.splice(cidx, 0, s);
        state.cursorIndex = cidx + 1;
      }
    });

    state.cursorIndex = Math.max(0, Math.min(state.cursorIndex || 0, state.selectedOrder.length));

    if (!state.selectedOrder.length && !state.reserveOrder.length) {
      if (wrap) wrap.style.display = "none";
      box.style.display = "none";
      box.innerHTML = "";
      renderReserveStrip();
      return;
    }

    if (wrap) wrap.style.display = "block";
    box.style.display = "flex";
    if (countEl) countEl.textContent = String(state.selectedOrder.length);
    if (badgeEl) badgeEl.textContent = `📍 Cursor: #${state.cursorIndex}`;

    if (mvBtn) {
      const restCount = state.selectedOrder.length - state.cursorIndex;
      if (restCount > 0) {
        mvBtn.style.display = "";
        mvBtn.textContent = `⬇ Move rest (${restCount}) to Reserve`;
      } else {
        mvBtn.style.display = "none";
      }
    }

    box.innerHTML = "";
    const total = state.selectedOrder.length;

    for (let i = 0; i <= total; i++) {
      // Render cursor spot before item i (or after last item when i === total)
      const spot = document.createElement("div");
      spot.className = `cursor-spot ${i === state.cursorIndex ? "active" : ""}`;
      spot.dataset.cidx = i;
      spot.setAttribute("title", `Click to place cursor here (Position #${i})`);
      spot.innerHTML = `<div class="cursor-line"></div>`;

      spot.addEventListener("click", (e) => {
        e.stopPropagation();
        state.cursorIndex = i;
        renderSelectedStrip();
      });

      spot.addEventListener("dragover", (e) => {
        e.preventDefault();
        try { e.dataTransfer.dropEffect = "move"; } catch (_) {}
        spot.classList.add("drag-over");
      });

      spot.addEventListener("dragleave", () => {
        spot.classList.remove("drag-over");
      });

      spot.addEventListener("drop", (e) => {
        e.preventDefault();
        spot.classList.remove("drag-over");
        if (draggedSlotId == null) return;
        const sid = draggedSlotId;

        if (draggedSource === "reserve") {
          state.reserveOrder = state.reserveOrder.filter((s) => s !== sid);
          state.selectedOrder.splice(i, 0, sid);
          state.cursorIndex = i + 1;
        } else {
          const fromIdx = state.selectedOrder.indexOf(sid);
          if (fromIdx !== -1) {
            state.selectedOrder.splice(fromIdx, 1);
            const insertIdx = i > fromIdx ? i - 1 : i;
            state.selectedOrder.splice(insertIdx, 0, sid);
            state.cursorIndex = insertIdx + 1;
          }
        }
        renderSelectedStrip();
        renderReserveStrip();
        updateCount();
      });

      box.appendChild(spot);

      // Render chip at index i if i < total
      if (i < total) {
        const sid = state.selectedOrder[i];
        const evo = byId(sid);
        if (!evo) continue;
        const isPlus = evo.kind === "PS+";
        const nm = dispName(baseName(evo));

        const chip = document.createElement("div");
        chip.className = `sel-chip ${isPlus ? "psp" : ""}`;
        chip.draggable = true;
        chip.dataset.slotid = sid;
        chip.dataset.index = i;
        chip.setAttribute("title", `Step ${i + 1}: ${nm}${isPlus ? "+" : ""} (Drag to reorder or click ⬇ Reserve)`);

        chip.innerHTML = `
          <span class="drag-grip" title="Drag to reorder">⠿</span>
          <span class="chip-num">${i + 1}</span>
          <span>${esc(nm)}${isPlus ? "+" : ""}</span>
          ${i > 0 ? `<button class="chip-arrow" data-act="mvleft" title="Move earlier">◀</button>` : ""}
          ${i < total - 1 ? `<button class="chip-arrow" data-act="mvright" title="Move later">▶</button>` : ""}
          <button class="chip-arrow" data-act="to-reserve" title="Move to Temporary Reserve">⬇</button>
          <button class="chip-x" data-act="rmps" title="Remove ${esc(nm)}">✕</button>
        `;

        chip.addEventListener("dragstart", (e) => {
          draggedSlotId = sid;
          draggedSource = "main";
          chip.classList.add("dragging");
          try {
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData("text/plain", String(sid));
          } catch (_) {}
        });

        chip.addEventListener("dragend", () => {
          draggedSlotId = null;
          chip.classList.remove("dragging");
        });

        chip.addEventListener("click", (e) => {
          const act = e.target.getAttribute("data-act");
          if (act === "rmps") {
            e.stopPropagation();
            state.selected.delete(sid);
            state.selectedOrder = state.selectedOrder.filter((s) => s !== sid);
            state.cursorIndex = Math.min(state.cursorIndex, state.selectedOrder.length);
            renderSelectedStrip();
            renderReserveStrip();
            renderGrid();
            updateCount();
            updateRunBtn();
          } else if (act === "to-reserve") {
            e.stopPropagation();
            state.selectedOrder = state.selectedOrder.filter((s) => s !== sid);
            if (!state.reserveOrder.includes(sid)) state.reserveOrder.push(sid);
            state.cursorIndex = Math.min(state.cursorIndex, state.selectedOrder.length);
            renderSelectedStrip();
            renderReserveStrip();
            updateCount();
          } else if (act === "mvleft") {
            e.stopPropagation();
            if (i > 0) {
              const temp = state.selectedOrder[i - 1];
              state.selectedOrder[i - 1] = state.selectedOrder[i];
              state.selectedOrder[i] = temp;
              state.cursorIndex = i;
              renderSelectedStrip();
              updateCount();
            }
          } else if (act === "mvright") {
            e.stopPropagation();
            if (i < total - 1) {
              const temp = state.selectedOrder[i + 1];
              state.selectedOrder[i + 1] = state.selectedOrder[i];
              state.selectedOrder[i] = temp;
              state.cursorIndex = i + 2;
              renderSelectedStrip();
              updateCount();
            }
          } else {
            // Clicking chip body positions cursor after this chip
            state.cursorIndex = i + 1;
            renderSelectedStrip();
          }
        });

        box.appendChild(chip);
      }
    }

    renderReserveStrip();
  }

  function onPsSearchInput(e) {
    const q = e.target.value.trim().toLowerCase();
    state.psSearchQ = q;
    renderGrid();
    if (!q) {
      hidePsMatches();
      return;
    }
    const box = els.psmatches;
    if (!box) return;
    const it = state.item;
    const isGK = it ? (() => { try { return it.isGK(); } catch (_) { return false; } })() : false;
    
    const candidates = Array.isArray(ALL) ? ALL : [];
    const matches = candidates.filter((evo) => {
      if (evo.g && !isGK) return false;
      const nm = dispName(baseName(evo)).toLowerCase();
      const bnm = baseName(evo).toLowerCase();
      return nm.includes(q) || bnm.includes(q);
    });

    if (!matches.length) {
      box.innerHTML = `<div class="rhint">No playstyle matches &ldquo;${esc(q)}&rdquo;</div>`;
      box.style.display = "block";
      return;
    }

    box.innerHTML = matches.slice(0, 8).map((evo) => {
      const nm = dispName(baseName(evo));
      const isPlus = evo.kind === "PS+";
      const isSel = state.selected.has(evo.s);
      return `<div class="ps-quick-item ${isPlus ? "psp" : ""} ${isSel ? "sel" : ""}" data-qsid="${evo.s}">` +
        `<span class="qbadge">${isPlus ? "PS+" : "PS"}</span>` +
        `<span>${esc(nm)}</span>` +
        (isSel ? '<span style="margin-left:auto;font-size:10px;color:var(--good)">✓ Selected</span>' : '') +
        `</div>`;
    }).join("");
    box.style.display = "block";

    box.querySelectorAll(".ps-quick-item").forEach((el) => {
      el.addEventListener("click", () => {
        const sid = Number(el.dataset.qsid);
        const evo = byId(sid);
        if (evo) {
          if (!state.selected.has(evo.s)) {
            if (checkCap(evo)) {
              if (Array.isArray(ALL)) {
                const cp = ALL.find((x) => x && x.r === evo.r && x.kind !== evo.kind);
                if (cp && state.selected.has(cp.s)) {
                  state.selected.delete(cp.s);
                  state.selectedOrder = state.selectedOrder.filter((s) => s !== cp.s);
                }
              }
              state.selected.add(evo.s);
              if (!state.selectedOrder.includes(evo.s)) state.selectedOrder.push(evo.s);
              log(`✨ Selected ${dispName(baseName(evo))}${evo.kind === "PS+" ? "+" : ""}`, "head");
            }
          } else {
            state.selected.delete(evo.s);
            state.selectedOrder = state.selectedOrder.filter((s) => s !== evo.s);
          }
          if (els.pssearch) els.pssearch.value = "";
          state.psSearchQ = "";
          hidePsMatches();
          renderSelectedStrip();
          renderGrid();
          updateCount();
          updateRunBtn();
        }
      });
    });
  }

  function onPsSearchKeydown(e) {
    if (e.key === "Escape") {
      e.stopPropagation();
      if (els.pssearch) els.pssearch.value = "";
      state.psSearchQ = "";
      hidePsMatches();
      renderGrid();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const first = els.psmatches && els.psmatches.querySelector(".ps-quick-item");
      if (first) {
        first.click();
      }
    }
  }

  function renderGrid() {
    const box = els.grid; box.innerHTML = "";
    const it = state.item;
    const gkPlayer = it ? (() => { try { return it.isGK(); } catch (_) { return false; } })() : null;
    let list = current();
    
    // Filter by quick search if typed
    if (state.psSearchQ) {
      list = list.filter((evo) => {
        const nm = dispName(baseName(evo)).toLowerCase();
        const bnm = baseName(evo).toLowerCase();
        return nm.includes(state.psSearchQ) || bnm.includes(state.psSearchQ);
      });
    }

    if (!list.length) {
      box.innerHTML = `<div class="rhint">No playstyles match &ldquo;${esc(state.psSearchQ)}&rdquo;</div>`;
      renderSelectedStrip();
      markGlyphs();
      return;
    }

    if (state.sortOrder === "alpha") {
      // Sort alphabetically A-Z
      const sorted = list.slice().sort((a, b) => dispName(baseName(a)).localeCompare(dispName(baseName(b))));
      const sec = document.createElement("div");
      sec.innerHTML = `<div class="gcat-h">Alphabetical (A–Z) · ${sorted.length}</div>`;
      const row = document.createElement("div"); row.className = "gcat-row";
      sorted.forEach((evo) => row.appendChild(evoCard(evo, it, gkPlayer)));
      sec.appendChild(row);
      box.appendChild(sec);
    } else {
      // Bucket by EA category, then render each non-empty category in game order.
      const groups = {};
      list.forEach((evo) => { const c = CAT_OF[baseName(evo)] || "Other"; (groups[c] || (groups[c] = [])).push(evo); });
      CAT_ORDER.concat("Other").forEach((cat) => {
        const evos = groups[cat];
        if (!evos || !evos.length) return;
        const sec = document.createElement("div");
        sec.innerHTML = `<div class="gcat-h">${esc(cat)} (${evos.length})</div>`;
        const row = document.createElement("div"); row.className = "gcat-row";
        evos.forEach((evo) => row.appendChild(evoCard(evo, it, gkPlayer)));
        sec.appendChild(row);
        box.appendChild(sec);
      });
    }
    renderSelectedStrip();
    markGlyphs();
  }

  // EA's icon font fills the diamonds/hexagons on the live app. If a glyph isn't
  // rendering (font not yet loaded, or a genuinely blank glyph), fall back to the
  // playstyle's initials so a shape is never empty. Toggles both ways so it self-
  // corrects once document.fonts settles.
  function markGlyphs() {
    if (!els.root) return;
    els.root.querySelectorAll(".ec .ico, .psrow .chip, .qps .chip").forEach((el) => {
      const g = el.querySelector("i");
      el.classList.toggle("noglyph", !g || g.getBoundingClientRect().width < 4);
    });
  }

  function toggleEvo(evo, card) {
    try {
      if (!evo || evo.s == null || !state.selected) return;
      const on = !state.selected.has(evo.s);
      if (on) {
        if (!checkCap(evo)) return;
        // base & + of the same playstyle are mutually exclusive
        if (Array.isArray(ALL)) {
          const cp = ALL.find((x) => x && x.r === evo.r && x.kind !== evo.kind);
          if (cp && state.selected.has(cp.s)) {
            state.selected.delete(cp.s);
            state.selectedOrder = state.selectedOrder.filter((s) => s !== cp.s);
            log("↔ Replaced " + (cp.n || "") + " with " + (evo.n || "") + " (same PlayStyle).", "dim");
          }
        }
        state.selected.add(evo.s);
        if (!state.selectedOrder.includes(evo.s)) state.selectedOrder.push(evo.s);
      } else {
        state.selected.delete(evo.s);
        state.selectedOrder = state.selectedOrder.filter((s) => s !== evo.s);
      }
      if (card && card.classList) card.classList.toggle("sel", on);
      renderSelectedStrip();
      updateCount();
      updateRunBtn();
    } catch (_) {}
  }

  function checkCap(evo) {
    if (!state.item) return true;
    const it = state.item;
    try {
      const kind = evo.kind || getEvoKind(evo.s);
      if (kind === "PS+") {
        const used = numPlus(it) ?? 0;
        const cap = capPlus(it) || 4;
        let selPlusAll = 0;
        state.selected.forEach((s) => { if (getEvoKind(s) === "PS+") selPlusAll++; });
        if (used + selPlusAll >= cap) {
          log("✋ PS+ cap: player has " + used + "/" + cap + " PS+, " + selPlusAll + " queued. No room.", "info");
          return false;
        }
      } else {
        const used = numBasic(it) ?? 0;
        const cap = capBasic(it) || 8;
        let selB = 0;
        state.selected.forEach((s) => { if (getEvoKind(s) === "PS") selB++; });
        if (used + selB >= cap) {
          log("✋ Basic cap: player has " + used + "/" + cap + " basic, " + selB + " queued. No room.", "info");
          return false;
        }
      }
    } catch (_) {}
    return true;
  }

  function updateCount() {
    try {
      if (!els || !els.count) return;
      let selPlus = 0, selB = 0;
      state.selected.forEach((s) => {
        if (getEvoKind(s) === "PS+") selPlus++;
        else selB++;
      });
      let txt = state.selected.size + " selected (" + selPlus + " PS+, " + selB + " PS)";
      let over = false;
      if (state.item) {
        const cp = capPlus(state.item) || 4;
        const cb = capBasic(state.item) || 8;
        const np = numPlus(state.item) ?? 0;
        const nb = numBasic(state.item) ?? 0;
        const pp = np + selPlus;
        const pb = nb + selB;
        txt += " \u2192 " + pp + "/" + cp + " PS+, " + pb + "/" + cb + " basic";
        over = pp > cp || pb > cb;
      }
      if (els && els.count) {
        els.count.textContent = txt;
        if (els.count.classList) {
          els.count.classList.toggle("over", !!over);
        }
      }
      renderSelectedStrip();
    } catch (_) {}
  }

  function setRunning(on) {
    try {
      if (!els) return;
      if (els.run) els.run.disabled = on;
      if (els.stop) els.stop.style.display = on ? "" : "none";
      if (els.run) els.run.style.display = on ? "none" : "";
      if (els.clearsel) els.clearsel.style.display = on ? "none" : (state.selected.size ? "" : "none");
    } catch (_) {}
  }

  // Latest message shows in the status line (full history goes to the console).
  // Strip any leading status glyph/emoji — state is conveyed by colour, not icons.
  const deglyph = (s) => {
    try { return String(s).replace(/^(?:\p{Extended_Pictographic}|[\u2190-\u21FF\u2300-\u27FF\u2900-\u29FF\u2B00-\u2BFF\uFE0F\u200D])+\s*/u, ""); }
    catch (_) { return String(s).replace(/^[^\w\s]+\s*/, ""); }
  };
  function log(msg, cls) {
    const shown = deglyph(msg);
    try {
      if (els && els.status) { els.status.textContent = shown; els.status.className = "status " + (cls || ""); }
    } catch (_) {}
    (cls === "err" ? console.error : cls === "warn" ? console.warn : console.log)("[FCEvo]", msg);
  }
  const initials = (n) => n.replace(/\+$/, "").split(/\s+/).map((w) => w[0]).join("").slice(0, 3).toUpperCase();

  function makeDraggable(el, handle) {
    let sx, sy, ox, oy;
    // Attach move/up only for the duration of a drag, so we aren't running a
    // handler on every mouse move across the whole page for the app's lifetime.
    const onMove = (e) => { el.style.left = ox + e.clientX - sx + "px"; el.style.top = oy + e.clientY - sy + "px"; };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp);
      savePrefs({ pos: { left: el.style.left, top: el.style.top } });
    };
    handle.addEventListener("mousedown", (e) => {
      if (e.target.tagName === "BUTTON" || e.target.closest("a")) return;
      sx = e.clientX; sy = e.clientY;
      const r = el.getBoundingClientRect(); ox = r.left; oy = r.top;
      el.style.right = "auto"; el.style.left = ox + "px"; el.style.top = oy + "px"; e.preventDefault();
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    });
  }

  // Hover tooltips for any [data-tip="Title|Body"] element. The tip lives on
  // <body> (not inside the panel) so the panel's overflow:hidden can't clip it,
  // and is placed beside the panel, clamped to the viewport.
  function initTips() {
    const tip = document.createElement("div");
    tip.id = "fcevo-tip"; tip.style.display = "none";
    document.body.appendChild(tip);
    let cur = null;
    const place = (el) => {
      const er = el.getBoundingClientRect(), pr = els.root.getBoundingClientRect(), tr = tip.getBoundingClientRect(), gap = 8;
      let left = pr.left - tr.width - gap;
      if (left < 8) left = Math.min(pr.right + gap, window.innerWidth - tr.width - 8);
      let top = er.top + er.height / 2 - tr.height / 2;
      top = Math.max(8, Math.min(top, window.innerHeight - tr.height - 8));
      tip.style.left = Math.round(left) + "px"; tip.style.top = Math.round(top) + "px";
    };
    els.root.addEventListener("mouseover", (e) => {
      const el = e.target.closest("[data-tip]");
      if (!el || el === cur) return;
      cur = el;
      const p = (el.getAttribute("data-tip") || "").split("|");
      tip.innerHTML = "<b>" + esc(p[0]) + "</b>" + (p[1] ? "<span>" + p[1] + "</span>" : "");
      tip.style.display = "block";
      place(el);
    });
    els.root.addEventListener("mouseout", (e) => {
      const el = e.target.closest("[data-tip]");
      if (el && (!e.relatedTarget || !el.contains(e.relatedTarget))) { cur = null; tip.style.display = "none"; }
    });
  }

  // Check if the user is authenticated and the main Web App UI is active (not on login/landing view)
  function isAppLoggedInAndReady() {
    try {
      const auth = window.services?.Authentication;
      if (auth && typeof auth.isLoggedIn === "function" && !auth.isLoggedIn()) {
        return false;
      }
      const userSvc = window.services?.User;
      if (userSvc && typeof userSvc.getUser === "function") {
        const u = userSvc.getUser();
        if (!u || (!u.personaId && !u.id && !u.selectedPersona)) return false;
      }
      if (typeof window.getAppMain === "function") {
        const main = window.getAppMain();
        if (!main) return false;
        const rootVC = typeof main.getRootViewController === "function" ? main.getRootViewController() : null;
        if (!rootVC) return false;
        const vcName = (rootVC.className || rootVC.constructor?.name || "").toLowerCase();
        if (vcName.includes("landing") || vcName.includes("login") || vcName.includes("auth")) {
          return false;
        }
      }
      if (document.querySelector(".ut-login-client-view, .ut-landing-view, .ut-login-container, .ut-click-shield-view")) {
        return false;
      }
      const hasNav = !!document.querySelector(".ut-tab-bar-view, .ut-navigation-container-view, .ut-tab-bar-item, button.ut-tab-bar-item, nav");
      const hasServices = !!(window.services?.Club?.search && (window.services?.Academy || window.repositories?.Academy));
      return hasNav && hasServices;
    } catch (_) {
      return false;
    }
  }

  // --- boot -----------------------------------------------------------------
  function boot() {
    let booted = false;
    const checkAndInit = () => {
      if (booted) return;
      if (!isAppLoggedInAndReady()) return;

      booted = true;
      clearInterval(iv);
      if (!document.getElementById("fcevo")) build();
      window.FCEvo = { applyEvo, claimEvo, removeEvoUpgrade, removeLastEvo, canRemoveEvo, runBatch, runDispatch, state, PS, PSP, RARITIES, clubPlayers, selectPlayer, scrapeRarities, clubRaritiesDump, eligibleRarities, loadClub, startClubLoad, readAttrs, dumpEntity, openEntity, freshItemById, reloadAndReselect, autoResolveRole, suggestedSlots, suggest, requestRun };
      
      setClubStatus("Club: waiting for squad…", "load");
      let waited = 0;
      const checkSquad = () => {
        if (squadReady() || waited >= 12000) {
          clearInterval(gate);
          startClubLoad(1);
          return;
        }
        waited += 250;
      };
      const gate = setInterval(checkSquad, 250);
      checkSquad();
    };

    const iv = setInterval(checkAndInit, 1000);
    checkAndInit();
  }
  if (document.readyState !== "loading") boot(); else window.addEventListener("DOMContentLoaded", boot);
})();
