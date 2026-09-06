#!/usr/bin/env node
/*
 * ace-sim — an OPC UA server that pretends to be a plant.
 *
 * Exists so the Fuuz device gateway has something real to browse and subscribe to. Deliberately
 * mirrors the WorkUnit codes already in the ProveIT site2 tenant (HOU-PKG-CAP-001 and friends), so
 * tags discovered through the gateway are bindable by the same ACE profiles that scored the
 * synthetic corpus — the whole chain stays end-to-end testable.
 *
 * Address space:  Objects/Plant/<AREA>/<UNIT>/<Signal>
 *   e.g. Objects/Plant/PKG/CAP-001/MotorTemp
 *
 * Values move the way real ones do, because the classifier's behaviour lane reads them:
 *   booleans flip occasionally            -> STATE
 *   counters only ever increase           -> COUNTER
 *   process variables wander in-range     -> PROCESS_VAR
 *   setpoints sit still                   -> SETPOINT
 * Engineering units and EU ranges are published as real OPC UA properties (EngineeringUnits /
 * EURange), which is exactly where the ACE classifier looks first.
 */
'use strict';
const { OPCUAServer, Variant, DataType, DataValue, StatusCodes, StatusCode, makeEUInformation } = require('node-opcua');

/* Map our numeric status codes onto node-opcua StatusCode objects. */
function coerceStatus(code) {
  if (!code) { return StatusCodes.Good; }
  if (code === 0x808A0000) { return StatusCodes.BadNotConnected; }
  if (code === 0x803C0000) { return StatusCodes.BadOutOfRange; }
  if (code === 0x40900000) { return StatusCodes.UncertainLastUsableValue; }
  return StatusCodes.Good;
}

const PORT = parseInt(process.env.OPCUA_PORT || '4840', 10);
const CONTROL_PORT = parseInt(process.env.CONTROL_PORT || '4841', 10);

/* Tunables live in one mutable object rather than as consts, so the control API can change the
   plant's behaviour while it runs. A monitoring UI that can only watch is half a tool — being able
   to inject a fault and see it propagate through gateway, historian and matcher is the point. */
const tunables = {
  tickMs: parseInt(process.env.TICK_MS || '2000', 10),
  /* probability a unit picks a NON-NONE fault when its current condition expires */
  faultRate: parseFloat(process.env.FAULT_RATE || '0.5'),
  noise: parseFloat(process.env.NOISE || '1.0'),        /* multiplier on per-tick analog movement */
  paused: false
};

/* Mirrors the live site2 WorkUnit catalogue. */
const UNITS = [
  { area: 'PKG', code: 'CAP-001', kind: 'Capper' },
  { area: 'PKG', code: 'CP-002',  kind: 'CasePacker' },
  { area: 'PKG', code: 'FIL-003', kind: 'Filler' },
  { area: 'PKG', code: 'PAL-001', kind: 'Palletizer' },
  { area: 'UTL', code: 'CHL-002', kind: 'Chiller' },
  { area: 'UTL', code: 'CMP-001', kind: 'Compressor' },
  { area: 'UTL', code: 'PMP-003', kind: 'Pump' },
  { area: 'UTL', code: 'BLR-001', kind: 'Boiler' }
];

/* A real plant is not eight float tags. Discrete, counters, enums and string context all live in
   the same historian and each needs different treatment downstream. */
const SIGNALS = [
  { name: 'Running',     kind: 'bool',    unit: '',     lo: 0,  hi: 1,       type: 'DISCRETE' },
  { name: 'Faulted',     kind: 'bool',    unit: '',     lo: 0,  hi: 1,       type: 'DISCRETE' },
  { name: 'MotorTemp',   kind: 'analog',  unit: 'degF', lo: 60, hi: 220,     type: 'PROCESS'  },
  { name: 'Speed',       kind: 'analog',  unit: 'RPM',  lo: 0,  hi: 1800,    type: 'PROCESS'  },
  { name: 'Vibration',   kind: 'analog',  unit: 'mm/s', lo: 0,  hi: 12,      type: 'PROCESS'  },
  { name: 'Pressure',    kind: 'analog',  unit: 'psi',  lo: 0,  hi: 150,     type: 'PROCESS'  },
  { name: 'GoodCount',   kind: 'counter', unit: 'ea',   lo: 0,  hi: 1000000, type: 'COUNTER'  },
  { name: 'RejectCount', kind: 'counter', unit: 'ea',   lo: 0,  hi: 1000000, type: 'COUNTER'  },
  { name: 'SpeedSP',     kind: 'setpoint',unit: 'RPM',  lo: 0,  hi: 1800,    type: 'PROCESS'  },
  { name: 'Mode',        kind: 'enum',    unit: '',     lo: 0,  hi: 4,       type: 'ENUM',
    states: ['Stopped', 'Starting', 'Running', 'Holding', 'Fault'] },
  { name: 'BatchId',     kind: 'string',  unit: '',     lo: 0,  hi: 0,       type: 'STRING'   }
];

/* ── data-quality realism ──────────────────────────────────────────────────────────────────
 * Real historian data is not clean, and code that only ever sees clean data is untested code.
 * Each unit independently drifts through these conditions:
 *   COMMS LOSS  — quality goes Bad, values stop changing (a gap in the trend)
 *   STALE       — device stops updating but still answers: Uncertain/LastUsable, value frozen
 *   SPIKE       — a single wild sample, still flagged Good, which is what makes it dangerous
 *   FLATLINE    — sensor stuck on a plausible value
 *   DRIFT       — slow calibration drift out of range, eventually Bad/OutOfRange
 *   COUNTER RESET — PLC restart takes a tally back to zero, breaking monotonicity
 */
/* Signals added at runtime, per unit. The base SIGNALS list is what every unit gets; anything the
   console adds lands here so a bespoke tag on one asset does not appear on all eight. */
const extraSignals = {};                       /* unitCode -> [signal] */

/* Runtime additions PERSIST. Without this, adding an asset through the console and then restarting
   the container silently loses it — which makes the feature a trap rather than a tool. The file
   holds only what was added at runtime; the built-in plant stays in code. */
const STATE_FILE = process.env.PLANT_FILE || '/data/plant.json';
function savePlant() {
  try {
    require('fs').mkdirSync(require('path').dirname(STATE_FILE), { recursive: true });
    require('fs').writeFileSync(STATE_FILE, JSON.stringify({
      addedUnits: UNITS.filter(u => u.added), extraSignals
    }, null, 2));
  } catch (e) { console.error('[sim] could not persist plant: ' + e.message); }
}
function loadPlant() {
  try {
    const raw = require('fs').readFileSync(STATE_FILE, 'utf8');
    const d = JSON.parse(raw);
    (d.addedUnits || []).forEach(u => { if (!UNITS.some(x => x.code === u.code)) { UNITS.push(u); } });
    Object.keys(d.extraSignals || {}).forEach(k => { extraSignals[k] = d.extraSignals[k]; });
    const n = (d.addedUnits || []).length;
    const t = Object.values(d.extraSignals || {}).reduce((a, v) => a + v.length, 0);
    if (n || t) { console.log('[sim] restored ' + n + ' added assets and ' + t + ' custom tags'); }
  } catch (e) { /* no file yet is the normal first-boot case */ }
}
const signalsFor = u => SIGNALS.concat(extraSignals[u.code] || []);

const FAULTS = ['NONE', 'NONE', 'NONE', 'NONE', 'COMMS', 'STALE', 'FLATLINE', 'DRIFT'];
const unitFault = {};
const unitFaultUntil = {};

/* Deterministic PRNG so a restart replays the same plant rather than a different one. */
let seed = 0x1f2e3d4c;
const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x100000000; };

const state = {};   /* nodeKey -> current value */

/* OPC UA status codes, matching what a real collector reports. */
const SC = { GOOD: 0, UNCERTAIN_LAST_USABLE: 0x40900000, BAD_NOT_CONNECTED: 0x808A0000, BAD_OUT_OF_RANGE: 0x803C0000 };

function initial(sig) {
  if (sig.kind === 'bool') { return sig.name === 'Faulted' ? false : true; }
  if (sig.kind === 'counter') { return Math.floor(rnd() * 5000); }
  if (sig.kind === 'setpoint') { return Math.round((sig.lo + (sig.hi - sig.lo) * 0.65) * 10) / 10; }
  if (sig.kind === 'enum') { return 2; }
  if (sig.kind === 'string') { return 'B-' + (100000 + Math.floor(rnd() * 9000)); }
  return Math.round((sig.lo + rnd() * (sig.hi - sig.lo)) * 10) / 10;
}

function step(sig, cur, fault) {
  if (fault === 'STALE' || fault === 'FLATLINE' || fault === 'COMMS') { return cur; }
  if (sig.kind === 'bool') { return rnd() < 0.03 ? !cur : cur; }
  if (sig.kind === 'enum') { return rnd() < 0.02 ? Math.floor(rnd() * sig.states.length) : cur; }
  if (sig.kind === 'string') { return rnd() < 0.004 ? 'B-' + (100000 + Math.floor(rnd() * 9000)) : cur; }
  if (sig.kind === 'counter') {
    if (rnd() < 0.0008) { return 0; }                    /* PLC restart: tally resets to zero */
    return cur + Math.floor(rnd() * 3);
  }
  if (sig.kind === 'setpoint') { return rnd() < 0.005 ? Math.round((sig.lo + rnd() * (sig.hi - sig.lo)) * 10) / 10 : cur; }
  let v = cur + (rnd() - 0.5) * (sig.hi - sig.lo) * 0.04 * tunables.noise;
  if (fault === 'DRIFT') { v = cur + (sig.hi - sig.lo) * 0.01 * tunables.noise; }   /* creeping out of range */
  if (rnd() < 0.002) { v = sig.hi * (1.2 + rnd()); }                         /* spike, still Good */
  if (fault !== 'DRIFT') {
    if (v < sig.lo) { v = sig.lo; }
    if (v > sig.hi) { v = sig.hi; }
  }
  return Math.round(v * 10) / 10;
}

/* Quality is a function of the unit's current fault state and whether the value is in range. */
function qualityFor(sig, v, fault) {
  if (fault === 'COMMS') { return SC.BAD_NOT_CONNECTED; }
  if (fault === 'STALE' || fault === 'FLATLINE') { return SC.UNCERTAIN_LAST_USABLE; }
  if (typeof v === 'number' && sig.kind !== 'counter' && (v > sig.hi * 1.1 || v < sig.lo - Math.abs(sig.lo * 0.1))) {
    return SC.BAD_OUT_OF_RANGE;
  }
  return SC.GOOD;
}

(async () => {
  const server = new OPCUAServer({
    port: PORT,
    resourcePath: '/UA/AceSim',
    /* OPC UA advertises its endpoint URL in GetEndpoints and clients validate it. The container
       only knows its own hostname, so without alternates the Fuuz gateway (a different compose
       project, reaching in via host.docker.internal) gets an endpoint it cannot match. */
    alternateHostname: (process.env.OPCUA_ALT_HOSTS || 'host.docker.internal,localhost,127.0.0.1,ace-sim').split(','),
    /* Anonymous + None: this is a lab simulator on a private docker network, and the point is to
       exercise the gateway's OPC UA client, not its certificate handling. */
    allowAnonymous: true,
    securityPolicies: [require('node-opcua').SecurityPolicy.None],
    securityModes: [require('node-opcua').MessageSecurityMode.None],
    buildInfo: { productName: 'ACE Plant Simulator', buildNumber: '1', buildDate: new Date(0) }
  });
  await server.initialize();

  loadPlant();

  const addressSpace = server.engine.addressSpace;
  const ns = addressSpace.getOwnNamespace();
  const objects = addressSpace.rootFolder.objects;
  const plant = ns.addFolder(objects, { browseName: 'Plant' });

  const areas = {};
  const unitFolders = {};
  let count = 0;

  /* Node creation is a function, not a loop body, so the control API can call it later. OPC UA
     address spaces are mutable at runtime — a client that re-browses sees new nodes immediately. */
  function ensureArea(name) {
    if (!areas[name]) { areas[name] = ns.addFolder(plant, { browseName: name }); }
    return areas[name];
  }
  function ensureUnit(u) {
    if (unitFolders[u.code]) { return unitFolders[u.code]; }
    unitFolders[u.code] = ns.addObject({
      organizedBy: ensureArea(u.area), browseName: u.code,
      description: u.kind + ' ' + u.code
    });
    return unitFolders[u.code];
  }
  function addSignalNode(u, sig) {
    const unitFolder = ensureUnit(u);
      const key = u.area + '/' + u.code + '/' + sig.name;
      state[key] = initial(sig);

      const isBool = sig.kind === 'bool';
      const isStr = sig.kind === 'string';
      const isEnum = sig.kind === 'enum';

      /* AnalogItem publishes EngineeringUnits + EURange as real OPC UA properties, which is what a
         browse walk (and the ACE classifier) reads. Booleans are plain variables. */
      if (isBool || isStr || isEnum) {
        ns.addVariable({
          componentOf: unitFolder, browseName: sig.name, nodeId: 's=' + key,
          dataType: isBool ? 'Boolean' : (isStr ? 'String' : 'Int32'),
          description: u.kind + ' ' + u.code + ' ' + sig.name +
            (isEnum ? ' [' + sig.states.join('|') + ']' : ''),
          /* quality travels with the value — a historian without it is just a number store */
          value: { timestamped_get: () => new DataValue({
            value: new Variant({
              dataType: isBool ? DataType.Boolean : (isStr ? DataType.String : DataType.Int32),
              value: state[key]
            }),
            statusCode: coerceStatus(qualityFor(sig, state[key], unitFault[u.code] || 'NONE')),
            sourceTimestamp: new Date()
          }) }
        });
      } else {
        ns.addAnalogDataItem({
          componentOf: unitFolder, browseName: sig.name, nodeId: 's=' + key,
          dataType: sig.kind === 'counter' ? 'Int32' : 'Double',
          description: u.kind + ' ' + u.code + ' ' + sig.name,
          /* node-opcua ships a fixed standardUnits table; the plant's literal unit string is what
             the ACE classifier's UOM lane matches on, so publish a custom EUInformation. */
          engineeringUnits: makeEUInformation(sig.unit || 'unitless', sig.unit || '', sig.unit || 'unitless'),
          engineeringUnitsRange: { low: sig.lo, high: sig.hi },
          value: {
            timestamped_get: () => new DataValue({
              value: new Variant({
                dataType: sig.kind === 'counter' ? DataType.Int32 : DataType.Double,
                value: sig.kind === 'counter' ? Math.round(state[key]) : state[key]
              }),
              statusCode: coerceStatus(qualityFor(sig, state[key], unitFault[u.code] || 'NONE')),
              sourceTimestamp: new Date()
            })
          }
        });
      }
    count++;
  }

  for (const u of UNITS) { for (const sig of signalsFor(u)) { addSignalNode(u, sig); } }

  /* The handshake cell is a different KIND of thing from the eight units above: those free-run and
     are sampled, this one waits to be answered. It gets its own area so a browse walk cannot
     mistake a protocol tag for a process signal, and its own module so the timing code sits next to
     the tags it times rather than being sprinkled through the plant loop. */
  const handshake = require('./handshake.js').build({
    ns, plantFolder: ensureArea(require('./handshake.js').AREA), DataType, Variant, DataValue, StatusCodes
  });
  console.log('[sim] handshake cell at Plant/' + require('./handshake.js').AREA + '/' +
    require('./handshake.js').CELL + '  (' + require('./handshake.js').MAX_RESULT_TAGS + ' result tags available)');

  /* Units drift in and out of fault conditions independently, so the historian sees overlapping
     good and degraded periods rather than a clean global switch. */
  let lastTick = 0;
  setInterval(() => {
    if (tunables.paused) { return; }
    const nowMs = Date.now();
    if (nowMs - lastTick < tunables.tickMs) { return; }
    lastTick = nowMs;
    const now = Date.now();
    for (const u of UNITS) {
      if (!unitFaultUntil[u.code] || now > unitFaultUntil[u.code]) {
        /* A manual injection sets faultUntil far in the future; leave it alone until cleared. */
        const next = rnd() < tunables.faultRate
          ? FAULTS.filter(f => f !== 'NONE')[Math.floor(rnd() * (FAULTS.length - 4))] || 'NONE'
          : 'NONE';
        unitFault[u.code] = next;
        unitFaultUntil[u.code] = now + (next === 'NONE' ? 60000 + rnd() * 120000 : 15000 + rnd() * 45000);
        if (next !== 'NONE') { console.log('[sim] ' + u.code + ' -> ' + next + ' for ' + Math.round((unitFaultUntil[u.code]-now)/1000) + 's'); }
      }
      const fault = unitFault[u.code] || 'NONE';
      for (const sig of signalsFor(u)) {
        const key = u.area + '/' + u.code + '/' + sig.name;
        state[key] = step(sig, state[key], fault);
      }
    }
  }, 250);   /* fixed cadence; the tick rate is enforced inside via tunables.tickMs */

  /* ── control API ───────────────────────────────────────────────────────────────────────────
     A plain http listener beside the OPC UA server. Read-only endpoints let a dashboard show what
     the plant is doing without an OPC UA client in the browser (there is no such thing); the write
     endpoints let it change the plant. Deliberately unauthenticated and bound inside the compose
     network only — this is a simulator, and adding auth would imply it is not. */
  const http = require('http');
  const snapshot = () => UNITS.map(u => ({
    area: u.area, code: u.code, kind: u.kind,
    fault: unitFault[u.code] || 'NONE',
    faultEndsInMs: Math.max(0, (unitFaultUntil[u.code] || 0) - Date.now()),
    signals: signalsFor(u).map(sig => {
      const key = u.area + '/' + u.code + '/' + sig.name;
      const q = qualityFor(sig, state[key], unitFault[u.code] || 'NONE');
      return { name: sig.name, type: sig.type, unit: sig.unit, value: state[key],
               quality: q === SC.GOOD ? 'Good' : q === SC.UNCERTAIN_LAST_USABLE ? 'Uncertain' : 'Bad',
               qualityCode: q, lo: sig.lo, hi: sig.hi };
    })
  }));

  http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*',
                            'access-control-allow-headers': 'content-type',
                            'access-control-allow-methods': 'GET,POST,OPTIONS' });
      res.end(JSON.stringify(obj));
    };
    if (req.method === 'OPTIONS') { return send(204, {}); }

    /* ROOT IS A HEALTH ROUTE, not decoration.
     *
     * The Fuuz device gateway health-probes an HTTPClient device by GETting its baseUrl. With no
     * route at "/", every probe returned 404 and the aceSimControl device sat permanently red in
     * the gateway UI while /state, /params and /faults all answered perfectly well. A device that
     * cries wolf is worse than one with no health check: it trains you to ignore the colour, and
     * this environment already has one genuinely broken connection worth noticing. */
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
      return send(200, {
        ok: true,
        service: 'ace-sim control API',
        opcuaEndpoint: server.getEndpointUrl(),
        paused: tunables.paused,
        routes: ['GET /', 'GET /health', 'GET /state', 'GET /params', 'GET /faults', 'POST /params', 'POST /fault']
      });
    }

    if (req.method === 'GET' && url.pathname === '/state') {
      return send(200, { endpoint: server.getEndpointUrl(), tickMs: tunables.tickMs,
                         paused: tunables.paused, faultRate: tunables.faultRate, noise: tunables.noise,
                         unitCount: UNITS.length, signalsPerUnit: SIGNALS.length,
                         tagCount: UNITS.length * SIGNALS.length, units: snapshot() });
    }
    if (req.method === 'GET' && url.pathname === '/params') { return send(200, tunables); }

    /* The namespace as a broker sees it: Plant > Area > Asset > Tag, with the OPC UA node id that
       actually addresses each leaf. The console browses this; it is also exactly what a gateway's
       browse walk would discover. */
    if (req.method === 'GET' && url.pathname === '/tree') {
      const byArea = {};
      UNITS.forEach(u => {
        (byArea[u.area] = byArea[u.area] || []).push({
          code: u.code, kind: u.kind, fault: unitFault[u.code] || 'NONE',
          tags: signalsFor(u).map(sig => {
            const key = u.area + '/' + u.code + '/' + sig.name;
            const q = qualityFor(sig, state[key], unitFault[u.code] || 'NONE');
            return { name: sig.name, type: sig.type, kind: sig.kind, unit: sig.unit,
                     lo: sig.lo, hi: sig.hi, value: state[key],
                     quality: q === SC.GOOD ? 'Good' : q === SC.UNCERTAIN_LAST_USABLE ? 'Uncertain' : 'Bad',
                     nodeId: 'ns=1;s=' + key, path: 'Plant/' + key,
                     custom: (extraSignals[u.code] || []).some(x => x.name === sig.name) };
          })
        });
      });
      return send(200, {
        plant: 'Plant', endpoint: server.getEndpointUrl(),
        areas: Object.keys(byArea).sort().map(a => ({ name: a, assets: byArea[a] }))
      });
    }
    if (req.method === 'GET' && url.pathname === '/faults') { return send(200, { available: [...new Set(FAULTS)] }); }

    /* The handshake cell brings its own routes. Dispatching by "METHOD /path" rather than merging
       them into the if-chain keeps the plant's control surface and the cell's stopwatch separable —
       the cell can be lifted out whole. */
    const gwKey = 'GET ' + url.pathname;
    if (req.method === 'GET' && handshake.routes[gwKey]) {
      return send(200, handshake.routes[gwKey](url.searchParams));
    }

    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      let p = {};
      try { p = body ? JSON.parse(body) : {}; } catch (e) { return send(400, { error: 'bad JSON' }); }

      const pwKey = 'POST ' + url.pathname;
      if (req.method === 'POST' && handshake.routes[pwKey]) {
        return send(200, handshake.routes[pwKey](p));
      }

      if (req.method === 'POST' && url.pathname === '/params') {
        /* Clamp rather than reject: a dashboard slider should not be able to wedge the plant with a
           0ms tick or a negative rate, and silently refusing would look like a broken control. */
        if (p.tickMs != null) { tunables.tickMs = Math.min(60000, Math.max(100, Number(p.tickMs) || 2000)); }
        if (p.faultRate != null) { tunables.faultRate = Math.min(1, Math.max(0, Number(p.faultRate))); }
        if (p.noise != null) { tunables.noise = Math.min(10, Math.max(0, Number(p.noise))); }
        if (p.paused != null) { tunables.paused = !!p.paused; }
        console.log('[sim] params -> ' + JSON.stringify(tunables));
        return send(200, tunables);
      }

      if (req.method === 'POST' && url.pathname === '/fault') {
        /* Inject or clear a condition on one unit. holdMs of 0 hands the unit back to the random
           scheduler; anything else pins it, which is what makes a demo reproducible. */
        const unit = String(p.unit || '');
        if (!UNITS.some(u => u.code === unit)) { return send(404, { error: 'unknown unit ' + unit }); }
        const fault = String(p.fault || 'NONE').toUpperCase();
        if (FAULTS.indexOf(fault) === -1) { return send(400, { error: 'unknown fault ' + fault }); }
        unitFault[unit] = fault;
        unitFaultUntil[unit] = Date.now() + (Number(p.holdMs) || (fault === 'NONE' ? 0 : 600000));
        console.log('[sim] MANUAL ' + unit + ' -> ' + fault);
        return send(200, { unit, fault, holdMs: unitFaultUntil[unit] - Date.now() });
      }
      /* ── create an asset ──────────────────────────────────────────────────────────────────
         Adds the unit and its full standard signal set to the LIVE address space. A client that
         re-browses sees it at once. What will NOT see it automatically: the bridge and the Fuuz
         DeviceSubscription both monitor a node list fixed at subscribe time, so new tags are
         collected only after those re-subscribe. Said plainly rather than left as a surprise. */
      if (req.method === 'POST' && url.pathname === '/assets') {
        const area = String(p.area || '').trim().toUpperCase();
        const code = String(p.code || '').trim().toUpperCase();
        const kind = String(p.kind || 'Asset').trim();
        if (!/^[A-Z0-9]{2,10}$/.test(area)) { return send(400, { error: 'area must be 2-10 alphanumerics' }); }
        if (!/^[A-Z0-9-]{3,20}$/.test(code)) { return send(400, { error: 'code must be 3-20 of A-Z 0-9 -' }); }
        if (UNITS.some(u => u.code === code)) { return send(409, { error: code + ' already exists' }); }
        const u = { area, code, kind, added: true };
        UNITS.push(u);
        signalsFor(u).forEach(sig => addSignalNode(u, sig));
        savePlant();
        console.log('[sim] ADDED asset ' + area + '/' + code + ' (' + kind + ')');
        return send(201, { area, code, kind, tags: signalsFor(u).length });
      }

      /* ── create a tag on an existing asset ─────────────────────────────────────────────── */
      if (req.method === 'POST' && url.pathname === '/tags') {
        const u = UNITS.find(x => x.code === String(p.asset || '').trim().toUpperCase());
        if (!u) { return send(404, { error: 'unknown asset ' + p.asset }); }
        const name = String(p.name || '').trim();
        if (!/^[A-Za-z][A-Za-z0-9_]{1,30}$/.test(name)) { return send(400, { error: 'tag name must start with a letter, 2-31 chars' }); }
        if (signalsFor(u).some(sig => sig.name === name)) { return send(409, { error: name + ' already exists on ' + u.code }); }
        const kind = ['analog', 'bool', 'counter', 'setpoint', 'enum', 'string'].indexOf(String(p.kind)) >= 0 ? String(p.kind) : 'analog';
        const lo = Number(p.lo); const hi = Number(p.hi);
        const sig = {
          name, kind, unit: String(p.unit || ''),
          lo: Number.isFinite(lo) ? lo : 0,
          hi: Number.isFinite(hi) && hi > (Number.isFinite(lo) ? lo : 0) ? hi : 100,
          type: kind === 'bool' ? 'DISCRETE' : kind === 'counter' ? 'COUNTER'
              : kind === 'enum' ? 'ENUM' : kind === 'string' ? 'STRING' : 'PROCESS'
        };
        if (kind === 'enum') { sig.states = ['S0', 'S1', 'S2', 'S3', 'S4']; }
        (extraSignals[u.code] = extraSignals[u.code] || []).push(sig);
        addSignalNode(u, sig);
        savePlant();
        console.log('[sim] ADDED tag ' + u.area + '/' + u.code + '/' + name + ' (' + kind + ')');
        return send(201, { asset: u.code, name, kind, nodeId: 'ns=1;s=' + u.area + '/' + u.code + '/' + name });
      }

      send(404, { error: 'no route ' + req.method + ' ' + url.pathname });
    });
  }).listen(CONTROL_PORT, '0.0.0.0');

  await server.start();
  const endpoint = server.getEndpointUrl();
  console.log('ACE plant simulator (OPC UA)');
  console.log('  endpoint : ' + endpoint);
  console.log('  units    : ' + UNITS.length + '  signals/unit: ' + SIGNALS.length + '  total tags: ' + count);
  console.log('  tick     : ' + tunables.tickMs + 'ms   control API: http://0.0.0.0:' + CONTROL_PORT);
  console.log('  browse   : Objects/Plant/<AREA>/<UNIT>/<Signal>   e.g. Plant/PKG/CAP-001/MotorTemp');
  /* Print every advertised endpoint + security combination. OPC UA clients match on the endpoint
     URL string, so "which URLs does this server actually claim" is the first question worth
     answering when a client cannot open a secure channel. */
  for (const ep of server.endpoints) {
    for (const d of ep.endpointDescriptions()) {
      console.log('  ADVERTISED ' + d.endpointUrl +
        '  [' + d.securityMode.toString() + ' / ' + String(d.securityPolicyUri).split('#').pop() + ']');
    }
  }
})().catch(e => { console.error('FATAL ' + e.message); process.exit(1); });
