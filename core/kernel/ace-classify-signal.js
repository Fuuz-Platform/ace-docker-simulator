/*
 * ctx-classify-measurement — infers WHAT A TAG MEASURES and HOW IT BEHAVES.
 *
 * Companion to ctx-deterministic-match. That kernel answers "which asset owns this tag" from the
 * path PREFIX; this one answers "what does it measure" from the LEAF, the engineering unit, the
 * driver metadata, and the value history. They are independent: a ghost tag on decommissioned
 * equipment still measures a temperature, and a tag can be classified long before anyone approves
 * its equipment assignment.
 *
 * PURE FUNCTION. No I/O, no clock, no randomness. Runs as a Fuuz Saved Script and under node
 * (module.exports is assigned before the trailing return). ES5 only.
 *
 * INPUT ($):
 * { vocabulary: <measurement-vocabulary.json>,
 *   subscriptions: [ { id, name, leaf?, uom?, dataType?, configuration?, valueStats? } ] }
 *
 * OUTPUT:
 * { summary, results: [ { id, measurementTypeId, uom, role, confidence, method, decision,
 *                         evidence, alternatives } ] }
 *
 * decision: APPLY (write it) | REVIEW (queue it) | UNKNOWN (leave null — do not guess)
 *
 * The two answers are resolved by DIFFERENT evidence and must not be collapsed:
 *   type <- vocabulary  (uom, leaf tokens, driver metadata)
 *   role <- behaviour   (boolean? monotonic? flat?) with an explicit suffix as the override
 * That split is what lets an opaque tag like `Tag_47` still be correctly called a COUNTER.
 */

/* ─────────────────────────── primitives ─────────────────────────── */

function isStr(v) { return typeof v === 'string'; }
function upper(s) { return isStr(s) ? s.toUpperCase() : ''; }

function keysOf(o) {
  var out = [];
  var k;
  for (k in o) { if (Object.prototype.hasOwnProperty.call(o, k)) { out.push(k); } }
  return out;
}

function uniq(arr) {
  var seen = {};
  var out = [];
  var i;
  for (i = 0; i < arr.length; i++) {
    if (arr[i] !== '' && arr[i] != null && !seen[arr[i]]) { seen[arr[i]] = true; out.push(arr[i]); }
  }
  return out;
}

/* Split a leaf name into comparable tokens: delimiters, then alpha|digit boundaries, then the
   whole-string form. `MTR_TMP` -> MTR, TMP;  `temp1` -> TEMP1, TEMP, 1;  `press_pv` -> PRESS, PV. */
function leafTokens(name) {
  /* split camelCase BEFORE folding case, or `RejectCount` stays one opaque token and only
     matches if someone happened to add the concatenation to the vocabulary */
  var spaced = isStr(name) ? name.replace(/([a-z0-9])([A-Z])/g, '$1 $2') : '';
  var raw = upper(spaced).split(/[^A-Z0-9]+/);
  var out = [];
  var i;
  for (i = 0; i < raw.length; i++) {
    var seg = raw[i];
    if (seg === '') { continue; }
    out.push(seg);
    var m = seg.match(/^([A-Z]+)(\d+)$/);
    if (m) { out.push(m[1]); out.push(m[2]); }
    var m2 = seg.match(/^(\d+)([A-Z]+)$/);
    if (m2) { out.push(m2[2]); }
  }
  return uniq(out);
}

/* Resolve a dotted path — driver metadata hides in nested configuration objects. */
function getPath(obj, dotted) {
  if (!obj || typeof obj !== 'object') { return ''; }
  var parts = dotted.split('.');
  var cur = obj;
  var i;
  for (i = 0; i < parts.length; i++) {
    if (parts[i].charAt(0) === '_') { return ''; }
    if (cur == null || typeof cur !== 'object') { return ''; }
    cur = cur[parts[i]];
  }
  if (isStr(cur)) { return cur; }
  if (typeof cur === 'number') { return '' + cur; }
  return '';
}

/* The leaf of a browse path is the signal name; everything before it is the asset. */
function leafOf(pathish) {
  if (!isStr(pathish) || pathish === '') { return ''; }
  var parts = pathish.split(/[\/\\]+/);
  var i;
  for (i = parts.length - 1; i >= 0; i--) { if (parts[i] !== '') { return parts[i]; } }
  return '';
}

/* ─────────────────────────── role: from behaviour ─────────────────────────── */

/* Behaviour is the evidence that survives a meaningless name AND a missing unit. */
function roleFromBehaviour(stats, dataType, beh) {
  if (!stats || (stats.samples || 0) < (beh.minSamplesForBehaviour || 20)) { return null; }

  if (beh.booleanIsState && stats.isBoolean === true) {
    return { role: 'STATE', why: 'boolean value domain' };
  }
  if (beh.monotonicIsCounter && stats.isMonotonic === true) {
    return { role: 'COUNTER', why: 'monotonically non-decreasing' };
  }
  /* A small integer domain is an ENUMERATION, not a measurement — and this must be tested before
     the setpoint rule, because an operating mode is also "nearly flat" and would otherwise be
     mistaken for a target value. */
  var isInt = upper(dataType).indexOf('INT') === 0;
  if (isInt && stats.distinctCount != null && stats.distinctCount <= (beh.stateMaxDistinct || 8)) {
    return { role: 'STATE', why: 'small integer domain (' + stats.distinctCount + ' distinct)' };
  }
  /* A setpoint carries a process variable's unit but almost never moves. This is the only way to
     tell `Pressure` (a reading) from `Pressure` (a target) when nobody suffixed it. Restricted to
     continuous types for the reason above. */
  if (!isInt && stats.changeRatio != null && stats.changeRatio <= (beh.setpointMaxChangeRatio || 0.05) &&
      stats.distinctCount != null && stats.distinctCount <= (beh.setpointMaxDistinct || 6)) {
    return { role: 'SETPOINT', why: 'near-flat: ' + stats.distinctCount + ' distinct values, change ratio ' + round3(stats.changeRatio) };
  }
  return { role: 'PROCESS_VAR', why: 'continuous, ' + stats.distinctCount + ' distinct values' };
}

function round3(n) { return Math.round(n * 1000) / 1000; }

/* Role from CONFIG rather than history. Ignition's engLow/engHigh and valueSource are configured
   properties, readable in the same cheap query as the name — so they substitute for the two
   behaviours that would otherwise force sampling every tag's value history:
     monotonic-rising  ->  a huge integer engineering range (a tally, not a measurement)
     near-flat float   ->  valueSource=memory/expr (nothing upstream is writing a reading)
   Weaker than observing the real values, but free. */
function roleFromConfig(cfg, dataType, vocab) {
  var ce = vocab.configEvidence || {};
  var isInt = upper(dataType).indexOf('INT') === 0;
  var engHigh = cfg.engHigh;
  var engLow = cfg.engLow;

  if (isInt && engHigh != null && engHigh >= (ce.counterMinEngHigh || 10000)) {
    return { role: 'COUNTER', why: 'integer with engHigh ' + engHigh + ' (tally range)', confidence: 0.82 };
  }
  if (engLow != null && engHigh != null && engLow === 0 && engHigh === 1 && upper(dataType).indexOf('BOOL') === 0) {
    return { role: 'STATE', why: 'boolean with 0..1 engineering range', confidence: 0.85 };
  }
  var srcHints = ce.sourceRoleHints || {};
  var src = upper(cfg.valueSource || '');
  var keys = keysOf(srcHints);
  var i;
  for (i = 0; i < keys.length; i++) {
    if (upper(keys[i]) === src && srcHints[keys[i]]) {
      return { role: srcHints[keys[i]], why: 'valueSource=' + cfg.valueSource, confidence: 0.75 };
    }
  }
  return null;
}

/* Does the configured engineering range contradict a candidate type? Ranges overlap too much to
   classify on their own, but they are a decent veto: a "temperature" whose range runs to 1,000,000
   is a counter someone mislabelled. */
function rangeContradicts(typeId, cfg, vocab) {
  var tr = (vocab.typeRanges || {})[typeId];
  if (!tr || cfg.engHigh == null) { return false; }
  if (cfg.engLow === 0 && cfg.engHigh === 100) { return false; }  /* the default — carries no signal */
  return cfg.engHigh > tr[1] * (vocab.configEvidence && vocab.configEvidence.rangeVetoFactor ? vocab.configEvidence.rangeVetoFactor : 20);
}

/* ─────────────────────────── type: from vocabulary ─────────────────────────── */

function normaliseUom(raw, vocab) {
  var u = upper(raw).replace(/\s+/g, '');
  if (u === '') { return ''; }
  var alias = vocab.uomAliases[u];
  return alias ? alias : raw;
}

function typeFromTokens(tokens, vocab) {
  var noise = {};
  var i;
  var nl = vocab.noiseTokens || [];
  for (i = 0; i < nl.length; i++) { noise[upper(nl[i])] = true; }

  var strong = [];
  var weak = [];
  for (i = 0; i < tokens.length; i++) {
    var t = tokens[i];
    if (noise[t]) { continue; }
    if (vocab.tokenToType[t]) { strong.push({ token: t, type: vocab.tokenToType[t] }); }
    else if (vocab.weakTokenToType && vocab.weakTokenToType[t]) {
      weak.push({ token: t, type: vocab.weakTokenToType[t] });
    }
  }
  return { strong: strong, weak: weak };
}

/* ─────────────────────────── the pass ─────────────────────────── */

function ctxClassify(input) {
  var inp = input || {};
  var vocab = inp.vocabulary || {};
  var subs = inp.subscriptions || [];

  vocab.uomAliases = vocab.uomAliases || {};
  vocab.uomToType = vocab.uomToType || {};
  vocab.tokenToType = vocab.tokenToType || {};
  vocab.behaviour = vocab.behaviour || {};
  vocab.confidence = vocab.confidence || {};
  vocab.thresholds = vocab.thresholds || { autoApply: 0.8, review: 0.55 };
  var CONF = vocab.confidence;

  /* only propose types this tenant actually seeded — same anti-hallucination rule as the matcher */
  var known = {};
  var mts = vocab.measurementTypes || [];
  var i, j;
  for (i = 0; i < mts.length; i++) { known[mts[i].id] = mts[i]; }

  var results = [];
  var summary = { total: subs.length, APPLY: 0, REVIEW: 0, UNKNOWN: 0, byMethod: {}, byRole: {} };

  for (i = 0; i < subs.length; i++) {
    var s = subs[i];

    /* ── gather evidence ── */
    var leaf = s.leaf ? s.leaf : leafOf(s.name || s.tagPath || '');
    if (leaf === '') { leaf = s.name || ''; }
    var tokens = leafTokens(leaf);

    var rawUom = s.uom != null ? s.uom : (getPath(s, 'configuration.engUnit') || getPath(s, 'engUnit'));
    var uom = normaliseUom(rawUom, vocab);
    var dataType = s.dataType || getPath(s, 'configuration.dataType') || '';
    var stats = s.valueStats || null;
    var cfgObj = s.configuration || {};
    var cfg = {
      engLow:  s.engLow  != null ? s.engLow  : cfgObj.engLow,
      engHigh: s.engHigh != null ? s.engHigh : cfgObj.engHigh,
      valueSource: s.valueSource || cfgObj.valueSource || '',
      typeId: s.typeId || cfgObj.typeId || null
    };

    /* driver-supplied documentation is a legitimate extra token source (Ignition tooltips,
       UDT type names) — cheap to read, occasionally decisive on opaque leaves */
    var metaText = [
      getPath(s, 'configuration.documentation'), getPath(s, 'configuration.tooltip'),
      getPath(s, 'configuration.udtType'), getPath(s, 'configuration.typeId'),
      s.description || ''
    ].join(' ');
    var metaTokens = leafTokens(metaText);

    var res = {
      id: s.id,
      measurementTypeId: null,
      uom: uom || null,
      role: null,
      confidence: 0,
      method: null,
      decision: 'UNKNOWN',
      alternatives: [],
      evidence: { leaf: leaf, tokens: tokens, uom: uom || null, dataType: dataType, flags: [] }
    };

    /* ── ROLE: explicit suffix > behaviour > default ── */
    var roleSuffix = vocab.roleSuffix || {};
    /* Scan from the END: suffix semantics are positional, so in `press_pv_SP` the trailing `_SP`
       is the operative one — it names a setpoint FOR the process variable. */
    var suffixRole = null;
    for (j = tokens.length - 1; j >= 0; j--) {
      if (roleSuffix[tokens[j]]) { suffixRole = { role: roleSuffix[tokens[j]], why: 'trailing `' + tokens[j] + '` suffix' }; break; }
    }
    var behRole = roleFromBehaviour(stats, dataType, vocab.behaviour);
    var cfgRole = roleFromConfig(cfg, dataType, vocab);
    if (suffixRole) {
      res.role = suffixRole.role;
      res.evidence.roleWhy = suffixRole.why;
      res.evidence.roleFrom = 'SUFFIX';
      if (behRole && behRole.role !== suffixRole.role) {
        res.evidence.flags.push('ROLE_SUFFIX_OVERRODE_BEHAVIOUR_' + behRole.role);
      }
    } else if (behRole) {
      res.role = behRole.role;
      res.evidence.roleWhy = behRole.why;
      res.evidence.roleFrom = 'BEHAVIOUR';
      if (cfgRole && cfgRole.role !== behRole.role) { res.evidence.flags.push('CONFIG_DISAGREES_' + cfgRole.role); }
    } else if (cfgRole) {
      /* no value history — fall back to what the tag's own configuration implies */
      res.role = cfgRole.role;
      res.evidence.roleWhy = cfgRole.why;
      res.evidence.roleFrom = 'CONFIG';
    } else {
      res.evidence.roleFrom = 'NONE';
    }

    /* ── TYPE: uom and tokens, cross-checked ── */
    var tk = typeFromTokens(tokens, vocab);
    if (!tk.strong.length && !tk.weak.length && metaTokens.length) {
      var mtk = typeFromTokens(metaTokens, vocab);
      if (mtk.strong.length) {
        tk = mtk;
        res.evidence.flags.push('TYPE_FROM_DRIVER_METADATA');
      }
    }

    var uomTypes = uom && vocab.uomToType[uom] ? vocab.uomToType[uom] : null;
    /* Head-final: in a compound name the LAST meaningful token is the thing, and the earlier ones
       qualify it — a `RunSpeed` is a kind of speed, not a kind of run state. Taking the first
       match instead is how `RunSpeed` gets auto-applied as RUN_STATE. */
    var tokenType = tk.strong.length ? tk.strong[tk.strong.length - 1].type : null;
    if (tk.strong.length > 1) {
      res.evidence.flags.push('COMPOUND_NAME_HEAD_' + tk.strong[tk.strong.length - 1].token);
      for (j = 0; j < tk.strong.length - 1; j++) {
        res.alternatives.push({ measurementTypeId: tk.strong[j].type, from: 'qualifier token ' + tk.strong[j].token });
      }
    }

    if (tokenType && uomTypes) {
      var agrees = false;
      for (j = 0; j < uomTypes.length; j++) { if (uomTypes[j] === tokenType) { agrees = true; } }
      if (agrees && uomTypes.length === 1) {
        res.measurementTypeId = tokenType; res.confidence = CONF.tokenAndUomAgree; res.method = 'UOM+TOKEN';
      } else if (agrees) {
        /* the unit was ambiguous (ea -> good/reject/total); the token resolved it */
        res.measurementTypeId = tokenType; res.confidence = CONF.uomMultiNarrowedByToken; res.method = 'UOM_NARROWED';
      } else {
        /* Unit and name disagree. The unit is set by the driver, the name is typed by a person —
           trust the unit, but never auto-apply a contradiction. */
        res.measurementTypeId = uomTypes.length === 1 ? uomTypes[0] : null;
        res.confidence = CONF.conflict; res.method = 'CONFLICT';
        res.evidence.flags.push('UOM_TOKEN_CONFLICT_uom=' + uomTypes.join('|') + '_token=' + tokenType);
        res.alternatives.push({ measurementTypeId: tokenType, from: 'token ' + tk.strong[0].token });
      }
    } else if (tokenType) {
      res.measurementTypeId = tokenType; res.confidence = CONF.strongToken; res.method = 'TOKEN';
    } else if (uomTypes && uomTypes.length === 1) {
      res.measurementTypeId = uomTypes[0]; res.confidence = CONF.uomUnique; res.method = 'UOM';
    } else if (uomTypes) {
      /* ambiguous unit, no token to break the tie — offer the options, decide nothing */
      res.method = 'UOM_AMBIGUOUS';
      res.evidence.flags.push('UOM_AMBIGUOUS_' + uomTypes.join('|'));
      for (j = 0; j < uomTypes.length; j++) { res.alternatives.push({ measurementTypeId: uomTypes[j], from: 'uom ' + uom }); }
    } else if (tk.weak.length) {
      res.measurementTypeId = tk.weak[0].type; res.confidence = CONF.weakToken; res.method = 'WEAK_TOKEN';
    }

    /* Behaviour can still name a type when vocabulary failed entirely: a boolean with no
       recognisable name is a state of some kind, and a monotonic integer is a tally. */
    if (!res.measurementTypeId && res.role) {
      /* Behaviour narrows the FAMILY but cannot name the member: a counter could be good, reject
         or total. Offering the family as an alternative and deferring is honest; asserting
         COUNT_TOTAL would be a guess dressed as an answer. The role is still applied — that part
         we do know. */
      if (res.role === 'COUNTER') {
        res.method = 'BEHAVIOUR'; res.evidence.flags.push('COUNTER_FAMILY_UNRESOLVED');
        res.alternatives.push({ measurementTypeId: 'COUNT_TOTAL', from: 'counter behaviour, member unknown' });
        res.alternatives.push({ measurementTypeId: 'COUNT_GOOD', from: 'counter behaviour, member unknown' });
        res.alternatives.push({ measurementTypeId: 'COUNT_REJECT', from: 'counter behaviour, member unknown' });
      } else if (res.role === 'STATE') {
        /* Same reasoning as counters: behaviour proves it is discrete, not which state it reports.
           Running vs faulted vs mode is a naming question, and we have no name. */
        res.method = 'BEHAVIOUR'; res.evidence.flags.push('STATE_FAMILY_UNRESOLVED');
        res.alternatives.push({ measurementTypeId: 'RUN_STATE', from: 'discrete behaviour, member unknown' });
        res.alternatives.push({ measurementTypeId: 'FAULT_STATE', from: 'discrete behaviour, member unknown' });
        if (upper(dataType).indexOf('INT') === 0) {
          res.alternatives.push({ measurementTypeId: 'MODE', from: 'discrete behaviour, member unknown' });
        }
      }
    }

    /* the configured engineering range can contradict the name/unit — flag it, never auto-apply it */
    if (res.measurementTypeId && rangeContradicts(res.measurementTypeId, cfg, vocab)) {
      res.evidence.flags.push('ENG_RANGE_CONTRADICTS_' + res.measurementTypeId + '_engHigh=' + cfg.engHigh);
      res.confidence = Math.min(res.confidence, (vocab.confidence || {}).conflict || 0.55);
    }

    /* reject anything outside the seeded vocabulary rather than inventing a type */
    if (res.measurementTypeId && !known[res.measurementTypeId]) {
      res.evidence.flags.push('TYPE_NOT_IN_VOCABULARY_' + res.measurementTypeId);
      res.alternatives.push({ measurementTypeId: res.measurementTypeId, from: 'rejected: not seeded' });
      res.measurementTypeId = null;
      res.confidence = 0;
    }

    /* fall back to the type's default role only when behaviour told us nothing */
    if (!res.role && res.measurementTypeId && known[res.measurementTypeId]) {
      res.role = known[res.measurementTypeId].defaultRole;
      res.evidence.roleFrom = 'TYPE_DEFAULT';
      res.evidence.roleWhy = 'default role of ' + res.measurementTypeId;
    }
    /* a missing unit can be filled from the resolved type — flagged, never silent */
    if (!res.uom && res.measurementTypeId && known[res.measurementTypeId] && known[res.measurementTypeId].defaultUom) {
      res.uom = known[res.measurementTypeId].defaultUom;
      res.evidence.flags.push('UOM_DEFAULTED_FROM_TYPE');
    }

    /* ── decide ── */
    if (res.measurementTypeId && res.confidence >= vocab.thresholds.autoApply) { res.decision = 'APPLY'; }
    else if (res.measurementTypeId && res.confidence >= vocab.thresholds.review) { res.decision = 'REVIEW'; }
    else if (res.role) { res.decision = 'REVIEW'; }   /* role alone is still worth writing after a look */
    else { res.decision = 'UNKNOWN'; }

    res.confidence = round3(res.confidence);
    res.evidence.udtTypeId = cfg.typeId;
    summary[res.decision] = (summary[res.decision] || 0) + 1;
    if (res.method) { summary.byMethod[res.method] = (summary.byMethod[res.method] || 0) + 1; }
    if (res.role) { summary.byRole[res.role] = (summary.byRole[res.role] || 0) + 1; }
    results.push(res);
  }

  /* ── UDT TEMPLATE CONSENSUS ──
     Ignition stamps `typeId` on every member of a UDT instance, so a plant with 500 motors has
     500 tags named `Speed` that are all the same decision. Learn the (typeId, member) pair once
     from the instances that resolved confidently, then apply it to the instances that did not.
     This is the classification analogue of the matcher's folder consensus, and it is what makes
     thousands of tags tractable: the human reviews templates, not tags. */
  var templates = {};
  for (i = 0; i < results.length; i++) {
    var rr = results[i];
    var tid = rr.evidence.udtTypeId;
    if (!tid || rr.decision !== 'APPLY' || !rr.measurementTypeId) { continue; }
    var key = tid + '|' + upper(rr.evidence.leaf);
    if (!templates[key]) { templates[key] = { votes: {}, roles: {}, n: 0 }; }
    var tpl = templates[key];
    tpl.votes[rr.measurementTypeId] = (tpl.votes[rr.measurementTypeId] || 0) + 1;
    if (rr.role) { tpl.roles[rr.role] = (tpl.roles[rr.role] || 0) + 1; }
    tpl.n++;
  }

  var applied = 0;
  for (i = 0; i < results.length; i++) {
    var r2 = results[i];
    if (r2.decision === 'APPLY') { continue; }
    var tid2 = r2.evidence.udtTypeId;
    if (!tid2) { continue; }
    var t2 = templates[tid2 + '|' + upper(r2.evidence.leaf)];
    if (!t2 || t2.n < ((vocab.behaviour || {}).udtMinInstances || 2)) { continue; }

    var bestType = null;
    var vk = keysOf(t2.votes);
    for (j = 0; j < vk.length; j++) { if (!bestType || t2.votes[vk[j]] > t2.votes[bestType]) { bestType = vk[j]; } }
    if (!bestType) { continue; }
    var agree = t2.votes[bestType] / t2.n;
    if (agree < ((vocab.behaviour || {}).udtMinAgreement || 0.75)) { continue; }

    /* never overrule a candidate's own contradicting evidence — same veto the matcher uses */
    if (r2.measurementTypeId && r2.measurementTypeId !== bestType) {
      r2.evidence.flags.push('UDT_TEMPLATE_VETOED_BY_OWN_EVIDENCE');
      continue;
    }

    var bestRole = null;
    var rk = keysOf(t2.roles);
    for (j = 0; j < rk.length; j++) { if (!bestRole || t2.roles[rk[j]] > t2.roles[bestRole]) { bestRole = rk[j]; } }

    summary[r2.decision] = summary[r2.decision] - 1;
    r2.measurementTypeId = bestType;
    if (!r2.role && bestRole) { r2.role = bestRole; r2.evidence.roleFrom = 'UDT_TEMPLATE'; }
    r2.confidence = round3(Math.min(0.9, 0.6 + 0.3 * agree));
    r2.method = 'UDT_TEMPLATE';
    r2.decision = r2.confidence >= vocab.thresholds.autoApply ? 'APPLY' : 'REVIEW';
    r2.evidence.flags.push('UDT_TEMPLATE_' + tid2 + '_' + t2.votes[bestType] + '/' + t2.n);
    summary[r2.decision] = (summary[r2.decision] || 0) + 1;
    summary.byMethod.UDT_TEMPLATE = (summary.byMethod.UDT_TEMPLATE || 0) + 1;
    applied++;
  }
  summary.udtTemplatesLearned = keysOf(templates).length;
  summary.udtTemplateApplied = applied;

  return { vocabularyId: vocab.id || null, summary: summary, results: results };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    ctxClassify: ctxClassify,
    leafTokens: leafTokens,
    roleFromBehaviour: roleFromBehaviour,
    normaliseUom: normaliseUom
  };
}

return ctxClassify(typeof $ !== 'undefined' ? $ : {});
