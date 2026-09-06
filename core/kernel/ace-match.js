/*
 * ctx-deterministic-match — first-pass contextualization kernel.
 *
 * PURE FUNCTION. No I/O, no clock, no randomness, no $state. Same input => same output, always.
 * Runs BOTH as a Fuuz Saved Script (JavaScript) and under plain node for local scoring:
 *   - Fuuz : `module` is undefined -> falls through to the trailing `return ctxMatch($)`.
 *   - node : module.exports is assigned BEFORE the trailing return, so require() works.
 *
 * Sandbox rules honoured: ES5 only. No Date, Map, Set, Infinity, optional chaining, spread,
 * arrow functions, template literals, const/let. Plain-object dictionaries only.
 *
 * INPUT ($):
 * {
 *   profile:    <MatchProfile row>   see profiles/*.json
 *   targets:    [ { id, fields: { <destination model fields> } } ]
 *   candidates: [ { id, externalId, externalLabel, externalKeyPath, rawMetadata } ]
 * }
 *
 * OUTPUT:
 * { summary: {...}, results: [ { candidateId, decision, method, tier, targetId, confidence,
 *                               alternatives, evidence } ] }
 *
 * The kernel NEVER hard-codes a destination field name. Field names arrive via
 * profile.facetFields / profile.textFields, so the destination model can look any way we want.
 */

/* ─────────────────────────── string primitives ─────────────────────────── */

function isStr(v) { return typeof v === 'string'; }

function upper(s) { return isStr(s) ? s.toUpperCase() : ''; }

/* Strip every non-alphanumeric character. "CHL-002" and "CHL002" collapse to the same key. */
function alnum(s) {
  if (!isStr(s)) { return ''; }
  return s.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function padNum(n, width) {
  var s = '' + n;
  while (s.length < width) { s = '0' + s; }
  return s;
}

function uniq(arr) {
  var seen = {};
  var out = [];
  var i;
  for (i = 0; i < arr.length; i++) {
    var k = arr[i];
    if (k !== '' && k != null && !seen[k]) { seen[k] = true; out.push(k); }
  }
  return out;
}

function keysOf(o) {
  var out = [];
  var k;
  for (k in o) { if (Object.prototype.hasOwnProperty.call(o, k)) { out.push(k); } }
  return out;
}

/* Jaro-Winkler. Best general-purpose comparator for short industrial identifiers:
   rewards a shared prefix, which is exactly how equipment codes are built. */
function jaro(a, b) {
  if (a === b) { return 1; }
  var la = a.length;
  var lb = b.length;
  if (la === 0 || lb === 0) { return 0; }
  var window = Math.floor(Math.max(la, lb) / 2) - 1;
  if (window < 0) { window = 0; }
  var aFlags = [];
  var bFlags = [];
  var i;
  for (i = 0; i < la; i++) { aFlags.push(false); }
  for (i = 0; i < lb; i++) { bFlags.push(false); }
  var matches = 0;
  for (i = 0; i < la; i++) {
    var lo = Math.max(0, i - window);
    var hi = Math.min(i + window + 1, lb);
    var j;
    for (j = lo; j < hi; j++) {
      if (!bFlags[j] && a.charAt(i) === b.charAt(j)) {
        aFlags[i] = true; bFlags[j] = true; matches++; break;
      }
    }
  }
  if (matches === 0) { return 0; }
  var transpositions = 0;
  var k = 0;
  for (i = 0; i < la; i++) {
    if (aFlags[i]) {
      var m;
      for (m = k; m < lb; m++) { if (bFlags[m]) { k = m + 1; break; } }
      if (a.charAt(i) !== b.charAt(m)) { transpositions++; }
    }
  }
  transpositions = transpositions / 2;
  return (matches / la + matches / lb + (matches - transpositions) / matches) / 3;
}

function jaroWinkler(a, b) {
  var j = jaro(a, b);
  if (j < 0.7) { return j; }
  var prefix = 0;
  var max = Math.min(4, Math.min(a.length, b.length));
  var i;
  for (i = 0; i < max; i++) {
    if (a.charAt(i) === b.charAt(i)) { prefix++; } else { break; }
  }
  return j + prefix * 0.1 * (1 - j);
}

/* Sorensen-Dice over character bigrams. Robust to word order and small edits in descriptions. */
function diceBigram(a, b) {
  if (a === b) { return a.length ? 1 : 0; }
  if (a.length < 2 || b.length < 2) { return 0; }
  var grams = {};
  var i;
  var total = 0;
  for (i = 0; i < a.length - 1; i++) {
    var g = a.substr(i, 2);
    grams[g] = (grams[g] || 0) + 1;
    total++;
  }
  var hits = 0;
  for (i = 0; i < b.length - 1; i++) {
    var h = b.substr(i, 2);
    if (grams[h] > 0) { grams[h]--; hits++; }
  }
  return (2 * hits) / (total + (b.length - 1));
}

/* Jaccard over token sets. Catches "CHILLER 2 MTR VIB" vs "Chiller 2". */
function jaccardTokens(aTokens, bTokens) {
  if (!aTokens.length || !bTokens.length) { return 0; }
  var inA = {};
  var i;
  for (i = 0; i < aTokens.length; i++) { inA[aTokens[i]] = true; }
  var inter = 0;
  var inB = {};
  for (i = 0; i < bTokens.length; i++) {
    var t = bTokens[i];
    if (!inB[t]) { inB[t] = true; if (inA[t]) { inter++; } }
  }
  var union = keysOf(inA).length + keysOf(inB).length - inter;
  return union > 0 ? inter / union : 0;
}

/* ─────────────────────────── tokenisation ─────────────────────────── */

/* Split a raw path/identifier into ordered segments, then tokens.
   Also emits alpha|digit splits so "Filler2" yields ["FILLER2","FILLER","2"]. */
function tokenize(raw, profile) {
  var text = isStr(raw) ? raw : '';
  var i;

  var strip = profile.tokenizer.stripPrefixes || [];
  for (i = 0; i < strip.length; i++) {
    var p = strip[i];
    while (text.indexOf(p) === 0) { text = text.substr(p.length); }
  }

  var delims = profile.tokenizer.delimiters || '/\\.:_- ';
  var SEP = String.fromCharCode(1);
  var norm = '';
  for (i = 0; i < text.length; i++) {
    var ch = text.charAt(i);
    norm += (delims.indexOf(ch) >= 0) ? SEP : ch;
  }

  var rawSegs = norm.split(SEP);
  var segments = [];
  for (i = 0; i < rawSegs.length; i++) {
    var s = rawSegs[i];
    if (s !== '') { segments.push(s.toUpperCase()); }
  }

  var stop = {};
  var stopList = profile.tokenizer.stopTokens || [];
  for (i = 0; i < stopList.length; i++) { stop[upper(stopList[i])] = true; }

  var tokens = [];
  for (i = 0; i < segments.length; i++) {
    var seg = segments[i];
    if (stop[seg]) { continue; }
    tokens.push(seg);
    /* alpha/digit boundary split: FILLER2 -> FILLER, 2 */
    var m = seg.match(/^([A-Z]+)(\d+)$/);
    if (m) { tokens.push(m[1]); tokens.push(m[2]); }
  }

  var kept = [];
  for (i = 0; i < segments.length; i++) { if (!stop[segments[i]]) { kept.push(segments[i]); } }

  /* Folder identity for the sibling tier is a property of the PATH HIERARCHY only — split on
     real path separators, never on the token delimiters. Otherwise `Unit1/FIL002_Speed` and
     `Unit1/Running` land in different groups (because `_` is a token delimiter) and folder
     consensus never fires. */
  var folderSegs = [];
  var rawFolder = text.split(/[\/\\]+/);
  for (i = 0; i < rawFolder.length; i++) {
    if (rawFolder[i] !== '') { folderSegs.push(rawFolder[i].toUpperCase()); }
  }

  return {
    segments: kept,
    leaf: kept.length ? kept[kept.length - 1] : '',
    parentPath: folderSegs.length > 1 ? folderSegs.slice(0, folderSegs.length - 1).join('/') : '',
    tokens: uniq(tokens),
    alnum: alnum(text)
  };
}

/* Parse a segment into { prefix, num } when it looks like an equipment code. */
function parseCode(seg) {
  var m = seg.match(/^([A-Z]{2,8})[ _\-]?0*(\d{1,5})$/);
  if (!m) { return null; }
  return { prefix: m[1], num: parseInt(m[2], 10) };
}

/* Pull every string leaf out of rawMetadata, skipping `_`-prefixed keys (anti-leak rule). */
function metaStrings(meta, depth) {
  var out = [];
  if (!meta || typeof meta !== 'object' || depth > 3) { return out; }
  var ks = keysOf(meta);
  var i;
  for (i = 0; i < ks.length; i++) {
    var k = ks[i];
    if (k.charAt(0) === '_') { continue; }
    var v = meta[k];
    if (isStr(v)) { out.push(v); }
    else if (v && typeof v === 'object') { out = out.concat(metaStrings(v, depth + 1)); }
  }
  return out;
}

/* Resolve a dotted path against an object. Needed because the identity of a platform
   DeviceSubscription is not a top-level column — it sits at `configuration.tagPath` and its
   hierarchy context at `deviceGatewayDevice.device.name`. Refuses to walk `_`-prefixed keys
   so the anti-leak rule cannot be bypassed by declaring a path into them. */
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

/* Read a declared field off a candidate: top-level first, then rawMetadata. Names may be
   dotted paths. */
function pickField(cand, names) {
  if (!names || !names.length) { return ''; }
  var i;
  var meta = cand.rawMetadata || {};
  for (i = 0; i < names.length; i++) {
    var n = names[i];
    if (n.charAt(0) === '_') { continue; }
    var v = getPath(cand, n);
    if (v !== '') { return v; }
    v = getPath(meta, n);
    if (v !== '') { return v; }
  }
  return '';
}

/* ─────────────────────────── target index ─────────────────────────── */

/* Build every lookup structure once per run. Facet vocabularies are DERIVED FROM THE TARGETS,
   so the kernel learns this tenant's site/area/prefix words without any configuration. */
function buildIndex(targets, profile) {
  var ff = profile.facetFields || {};
  var textFields = profile.textFields || [];
  /* Scope facets are the categorical columns that PARTITION the target set. For equipment that
     is site/area; for a material catalogue it might be [family]; for a vendor list [country].
     Declaring them as a list is what makes this engine destination-agnostic — the tier logic
     below never names one. Defaults to site/area so existing equipment profiles keep working. */
  var scopeNames = (ff.scope && ff.scope.length) ? ff.scope : ['site', 'area'];

  var idx = {
    byAlnum: {},        /* alnum(code|qualifiedCode) -> [targetId] */
    byCodeNum: {},      /* PREFIX#NUM               -> [targetId] */
    byPrefix: {},       /* PREFIX                   -> [targetId] */
    byAlnumSuffix: {},  /* trailing fragment of a code -> [targetId] */
    byBlock: {},        /* blocking key -> [targetId] — candidate generation, NOT scoring */
    scopeNames: scopeNames,
    scopeVocab: {},     /* facetName -> { VALUE: VALUE } */
    prefixVocab: {},
    typeWordPrefix: {}, /* HUMANTYPE word           -> PREFIX (auto-derived alias) */
    typeWordConflict: {},
    numWidth: 3,
    target: {}          /* targetId -> derived bundle */
  };
  var i, j;
  var widthSeen = 0;

  for (i = 0; i < targets.length; i++) {
    var t = targets[i];
    var f = t.fields || {};
    var codeVals = [];
    if (ff.code && f[ff.code]) { codeVals.push('' + f[ff.code]); }
    if (ff.qualifiedCode && f[ff.qualifiedCode]) { codeVals.push('' + f[ff.qualifiedCode]); }

    for (j = 0; j < codeVals.length; j++) {
      var a = alnum(codeVals[j]);
      if (!a) { continue; }
      if (!idx.byAlnum[a]) { idx.byAlnum[a] = []; }
      idx.byAlnum[a].push(t.id);
      /* Index the trailing fragments too. Master-data systems almost never store the canonical
         code — they store the bare number and the canonical form prefixes a domain tag onto it
         (`600024` -> `WO-600024`, `50012` -> `V-50012`, `800027` -> `LOT-800027`). Indexing
         suffixes catches every such derivation without a per-domain template to maintain. */
      var minAff = profile.minAffixLength || 4;
      var sp;
      for (sp = 1; sp <= a.length - minAff; sp++) {
        var suf = a.substr(sp);
        if (!idx.byAlnumSuffix[suf]) { idx.byAlnumSuffix[suf] = []; }
        idx.byAlnumSuffix[suf].push(t.id);
      }
    }

    var prefix = ff.prefix && f[ff.prefix] ? upper('' + f[ff.prefix]) : '';
    var num = ff.num != null && f[ff.num] != null ? parseInt(f[ff.num], 10) : null;
    var scopeFromCode = {};

    /* Real destination models rarely carry site/area/prefix/num as columns — the hierarchy is
       encoded in the code itself (`HOU-PKG-CAP-001`). codeFacetPattern declares how to take it
       apart: an ordered capture pattern plus the facet each group means. Data, not code, so a
       tenant whose codes read `CAP001@HOU` just writes a different pattern. */
    if (profile.codeFacetPattern && profile.codeFacetPattern.pattern && codeVals.length) {
      var cfp = profile.codeFacetPattern;
      var re = new RegExp(cfp.pattern);
      var mm = upper(codeVals[0]).match(re);
      if (mm) {
        var names = cfp.facets || [];
        for (j = 0; j < names.length; j++) {
          var cap = mm[j + 1];
          if (cap == null) { continue; }
          if (names[j] === 'prefix') { if (!prefix) { prefix = upper(cap); } }
          else if (names[j] === 'num') { if (num == null) { num = parseInt(cap, 10); } }
          else { scopeFromCode[names[j]] = upper(cap); }   /* any declared scope facet */
        }
      }
    }
    /* Fall back to parsing the code when the model carries no prefix/num columns. */
    if ((!prefix || num == null) && codeVals.length) {
      var segs = upper(codeVals[0]).split(/[^A-Z0-9]+/);
      var k;
      for (k = segs.length - 1; k >= 0; k--) {
        var pc = parseCode(segs[k]);
        if (pc) {
          if (!prefix) { prefix = pc.prefix; }
          if (num == null) { num = pc.num; widthSeen = Math.max(widthSeen, segs[k].replace(/[^0-9]/g, '').length); }
          break;
        }
      }
    }
    if (prefix && num != null) {
      var key = prefix + '#' + num;
      if (!idx.byCodeNum[key]) { idx.byCodeNum[key] = []; }
      idx.byCodeNum[key].push(t.id);
    }
    if (prefix) {
      if (!idx.byPrefix[prefix]) { idx.byPrefix[prefix] = []; }
      idx.byPrefix[prefix].push(t.id);
      idx.prefixVocab[prefix] = prefix;
    }

    var scope = {};
    for (j = 0; j < scopeNames.length; j++) {
      var sn = scopeNames[j];
      var col = ff[sn];
      var literal = (col && f[col] != null && f[col] !== '') ? upper('' + f[col]) : '';
      var derived = scopeFromCode[sn] || '';
      /* A literal column and codeFacetPattern disagreeing is a CONFIGURATION ERROR, not something
         to resolve silently — e.g. Area.code is site-qualified (`HOU-PKG`) while the code pattern
         yields `PKG`, so every scope comparison fails and the run returns nothing with no clue why.
         The literal still wins, but the disagreement is counted and surfaced. */
      if (literal && derived && literal !== derived) {
        idx.facetConflicts = idx.facetConflicts || {};
        var ck = sn + ': column=' + literal + ' vs code=' + derived;
        idx.facetConflicts[ck] = (idx.facetConflicts[ck] || 0) + 1;
      }
      var val = literal || derived;
      if (val) {
        scope[sn] = val;
        if (!idx.scopeVocab[sn]) { idx.scopeVocab[sn] = {}; }
        idx.scopeVocab[sn][val] = val;
      }
    }

    /* auto-alias: humanType word -> prefix, dropped if any word maps to two prefixes */
    if (ff.typeWord && f[ff.typeWord] && prefix) {
      var tw = upper('' + f[ff.typeWord]).replace(/[^A-Z]/g, '');
      if (tw) {
        if (idx.typeWordPrefix[tw] && idx.typeWordPrefix[tw] !== prefix) { idx.typeWordConflict[tw] = true; }
        else { idx.typeWordPrefix[tw] = prefix; }
      }
    }

    /* BLOCKING KEYS (spec §5.2, B11). Without these the fuzzy tier scores every candidate against
       every target — fine for 22 work units, fatal at 10^5 records. Keys are deliberately cheap and
       over-generate: blocking decides what is *comparable*, scoring decides what matches. */
    var blockKeys = [];
    for (j = 0; j < codeVals.length; j++) {
      var ca = alnum(codeVals[j]);
      if (ca.length >= 4) { blockKeys.push('C4:' + ca.substr(0, 4)); }
      if (ca.length >= 4) { blockKeys.push('CT:' + ca.substr(ca.length - 4)); }
    }
    if (prefix && num != null) { blockKeys.push('PN:' + prefix + '#' + num); }
    if (prefix) { blockKeys.push('P:' + prefix); }

    /* comparison text for the fuzzy tier */
    var textParts = [];
    for (j = 0; j < textFields.length; j++) {
      if (f[textFields[j]]) { textParts.push('' + f[textFields[j]]); }
    }
    var blob = upper(textParts.join(' '));
    var tks = uniq(blob.split(/[^A-Z0-9]+/));

    for (j = 0; j < tks.length; j++) {
      if (tks[j].length >= 4) { blockKeys.push('T4:' + tks[j].substr(0, 4)); }
      else if (tks[j].length >= 2) { blockKeys.push('T:' + tks[j]); }
    }
    var bku = uniq(blockKeys);
    for (j = 0; j < bku.length; j++) {
      if (!idx.byBlock[bku[j]]) { idx.byBlock[bku[j]] = []; }
      idx.byBlock[bku[j]].push(t.id);
    }

    idx.target[t.id] = {
      id: t.id,
      code: codeVals.length ? codeVals[0] : t.id,
      qualifiedCode: codeVals.length > 1 ? codeVals[1] : (codeVals.length ? codeVals[0] : ''),
      alnumCode: codeVals.length ? alnum(codeVals[0]) : '',
      prefix: prefix,
      num: num,
      scope: scope,
      blob: blob,
      tokens: tks
    };
  }

  /* Facet vocabularies are DERIVED from the target rows, which has a blind spot: a facet value
     that exists only on the candidate side is invisible, so it can neither be recognised nor
     conflict with anything. Load only Atlanta assets, feed a Houston tag, and it binds to Atlanta
     in silence. `profile.scopeVocabulary` declares the values that exist in the wider estate so an
     out-of-scope candidate is recognised as out-of-scope rather than unseen. */
  var declared = profile.scopeVocabulary || {};
  var dk = keysOf(declared);
  for (i = 0; i < dk.length; i++) {
    var dn = dk[i];
    if (!idx.scopeVocab[dn]) { idx.scopeVocab[dn] = {}; }
    var vals = declared[dn] || [];
    for (j = 0; j < vals.length; j++) {
      var dv = upper('' + vals[j]);
      if (dv && !idx.scopeVocab[dn][dv]) { idx.scopeVocab[dn][dv] = dv; idx.declaredOnly = true; }
    }
  }

  /* PRUNE DEGENERATE BLOCKING KEYS. A key held by most of the corpus (`MAKE` on every work order,
     `LOT` on every lot) has no discriminative power: it costs a full scan and buys nothing. Standard
     record-linkage practice is a frequency cap. Recall is protected because a candidate left with no
     keys falls through to the counted full-scan path rather than being dropped. */
  var nTargets = targets.length;
  /* Default 1.0 = no pruning. RECALL-FIRST BY DEFAULT: the measured sweep shows BIND drops to
     96.3% recall at share 0.25 while KEYRING is unharmed at 96%+ reduction — so the safe cap is a
     property of the corpus, not of the algorithm. `core/test/score-blocking.js` sweeps it and
     prints the tightest value that still meets the 99% gate; the rig calibrates it at scale
     (Appendix D: the rig measures, Fuuz adopts). Never guess this number. */
  var maxShare = profile.maxBlockShare != null ? profile.maxBlockShare : 1.0;
  var capN = Math.max(8, Math.floor(nTargets * maxShare));
  var bkAll = keysOf(idx.byBlock);
  idx.blockKeysPruned = 0;
  for (i = 0; i < bkAll.length; i++) {
    if (idx.byBlock[bkAll[i]].length > capN) { delete idx.byBlock[bkAll[i]]; idx.blockKeysPruned++; }
  }
  idx.blockKeysKept = keysOf(idx.byBlock).length;

  var tw = keysOf(idx.typeWordConflict);
  for (i = 0; i < tw.length; i++) { delete idx.typeWordPrefix[tw[i]]; }
  idx.numWidth = widthSeen > 0 ? widthSeen : 3;
  return idx;
}

/* ─────────────────────────── facet extraction ─────────────────────────── */

/* Read site / area / prefix / num out of the candidate's own path, using the vocabularies
   derived from the targets plus any customer-authored aliases. */
function extractFacets(tk, idx, profile) {
  var aliases = profile.aliases || [];
  var aliasMap = {};
  var i;
  for (i = 0; i < aliases.length; i++) {
    aliasMap[aliases[i].facet + ':' + upper(aliases[i].from)] = upper(aliases[i].to);
  }

  var facets = { scope: {}, prefix: null, num: null };
  var scopeNames = idx.scopeNames || ['site', 'area'];
  var evidence = [];
  var codeHits = [];   /* { prefix, num, from, known } — resolved after the scan */

  function knownPrefix(p) {
    return aliasMap['prefix:' + p] || idx.typeWordPrefix[p] || idx.prefixVocab[p] || null;
  }

  for (i = 0; i < tk.segments.length; i++) {
    var seg = tk.segments[i];
    var isLeaf = (i === tk.segments.length - 1);

    /* try each declared scope facet in order — the first unfilled one that recognises this
       segment claims it. Vocabulary comes from the targets; aliases carry the site's dialect. */
    var claimed = false;
    var sIdx;
    for (sIdx = 0; sIdx < scopeNames.length; sIdx++) {
      var sn = scopeNames[sIdx];
      if (facets.scope[sn]) { continue; }
      var aliasHit = aliasMap[sn + ':' + seg];
      var vocabHit = (idx.scopeVocab[sn] || {})[seg];
      if (aliasHit || vocabHit) {
        facets.scope[sn] = aliasHit || vocabHit;
        evidence.push({ facet: sn, from: seg, value: facets.scope[sn], via: aliasHit ? 'alias' : 'vocab' });
        claimed = true;
        break;
      }
    }
    if (claimed) { continue; }

    /* The trailing segment is usually the SIGNAL name (VIB / SPEED / Count_Good), not the
       equipment — letting it supply prefix+num is what invents phantom assets. Keep it only
       when it is a bare ordinal or a code whose prefix this tenant actually uses. */
    if (isLeaf && tk.segments.length > 1) {
      var pcLeaf = parseCode(seg);
      var leafOrdinal = /^\d{1,5}$/.test(seg);
      if (!leafOrdinal && !(pcLeaf && knownPrefix(pcLeaf.prefix))) { continue; }
    }

    var pc = parseCode(seg);
    if (pc) {
      var kp = knownPrefix(pc.prefix);
      codeHits.push({ prefix: kp || pc.prefix, num: pc.num, from: seg, known: !!kp });
      continue;
    }

    /* bare type word (or bare prefix) with the ordinal in the following segment:
       "Filler" / "2"   or   ATL1-FIL-FIL-003 -> ... FIL / 003 */
    var word = seg.replace(/[^A-Z]/g, '');
    var mapped = knownPrefix(word);
    if (mapped) {
      var nxt = tk.segments[i + 1];
      var n = (nxt && /^\d{1,5}$/.test(nxt)) ? parseInt(nxt, 10) : null;
      codeHits.push({ prefix: mapped, num: n, from: seg + (n != null ? ' ' + nxt : ''), known: true });
    }
  }

  /* Only a prefix this tenant actually uses can BE an asset identity — the prefix vocabulary is
     derived from the destination rows, so anything outside it (LINE1, STA2, UNIT3, Zone4) is
     structural noise from the folder tree. Recording it as a facet would be worse than useless:
     it fabricates an identity, blocks the fuzzy tier, and vetoes folder consensus. Keep it as
     weak evidence instead. */
  var chosen = null;
  for (i = 0; i < codeHits.length; i++) {
    if (codeHits[i].known && codeHits[i].num != null) { chosen = codeHits[i]; break; }
  }
  if (!chosen) { for (i = 0; i < codeHits.length; i++) { if (codeHits[i].known) { chosen = codeHits[i]; break; } } }
  if (chosen) {
    facets.prefix = chosen.prefix;
    facets.num = chosen.num;
    evidence.push({
      facet: 'code', from: chosen.from, known: true,
      value: chosen.prefix + (chosen.num != null ? '-' + padNum(chosen.num, idx.numWidth) : '')
    });
  } else if (codeHits.length) {
    evidence.push({ facet: 'weakCode', from: codeHits[0].from, known: false,
                    value: codeHits[0].prefix + (codeHits[0].num != null ? '-' + codeHits[0].num : '') });
  }
  return { facets: facets, evidence: evidence };
}

/* Candidate-side blocking keys — must mirror the target-side generation exactly or recall drops. */
function candidateBlockKeys(tk, facets) {
  var keys = [];
  var i;
  if (tk.alnum.length >= 4) {
    keys.push('C4:' + tk.alnum.substr(0, 4));
    keys.push('CT:' + tk.alnum.substr(tk.alnum.length - 4));
  }
  if (facets.prefix && facets.num != null) { keys.push('PN:' + facets.prefix + '#' + facets.num); }
  if (facets.prefix) { keys.push('P:' + facets.prefix); }
  for (i = 0; i < tk.tokens.length; i++) {
    var t = tk.tokens[i];
    if (t.length >= 4) { keys.push('T4:' + t.substr(0, 4)); }
    else if (t.length >= 2) { keys.push('T:' + t); }
  }
  return uniq(keys);
}

/* ─────────────────────────── scoring ─────────────────────────── */

/* Agreement over whatever scope facets this destination declares, plus the code facets. A scope
   the candidate asserts and the target contradicts is a VETO, not a low score — a Houston tag does
   not belong to an Atlanta asset no matter how well the names align. */
function facetAgreement(f, t) {
  var score = 0;
  var possible = 0;
  var veto = false;
  var names = keysOf(f.scope || {});
  var i;
  for (i = 0; i < names.length; i++) {
    var n = names[i];
    possible++;
    var tv = (t.scope || {})[n];
    if (tv && f.scope[n] === tv) { score++; }
    else if (tv) { veto = true; }
  }
  if (f.prefix) { possible++; if (t.prefix && f.prefix === t.prefix) { score++; } }
  if (f.num != null && t.num != null) { possible++; if (f.num === t.num) { score++; } }
  return { ratio: possible ? score / possible : 0, possible: possible, veto: veto };
}

/* Does a target survive the candidate's asserted scope? Used to narrow pools in tiers 2 and 3. */
function inScope(facets, t) {
  var names = keysOf(facets.scope || {});
  var i;
  for (i = 0; i < names.length; i++) {
    var tv = (t.scope || {})[names[i]];
    if (tv && tv !== facets.scope[names[i]]) { return false; }
  }
  return true;
}

function scoreTarget(cand, tk, facets, t, profile) {
  var w = profile.weights;
  var fa = facetAgreement(facets, t);
  if (fa.veto && profile.vetoOnFacetMismatch) { return { total: 0, veto: true, parts: {} }; }

  var jw = jaroWinkler(tk.alnum, t.alnumCode);
  var dice = diceBigram(upper(cand.externalLabel || ''), t.blob);
  var jac = jaccardTokens(tk.tokens, t.tokens);

  var total = (w.jw * jw) + (w.dice * dice) + (w.jaccard * jac) + (w.facet * fa.ratio);
  if (fa.veto) { total = total * 0.4; }
  return {
    total: total,
    veto: fa.veto,
    parts: { jw: jw, dice: dice, jaccard: jac, facet: fa.ratio }
  };
}

/* ACE routing band (spec §5.1). Our `decision` is the ranker's own verdict; `band` is the label the
   rest of the ACE pipeline routes on. Kept as two fields deliberately — collapsing them would make
   every measured number in the corpora shift for a naming reason. */
function aceBand(confidence, veto, thresholds, hasTarget) {
  var T = thresholds || {};
  var auto = T.auto != null ? T.auto : 0.92;
  var llm = T.propose != null ? T.propose : (T.llm != null ? T.llm : 0.70);
  var review = T.review != null ? T.review : 0.55;
  if (!hasTarget) { return 'NO_MATCH'; }
  if (veto) { return confidence >= review ? 'REVIEW' : 'NO_MATCH'; }
  if (confidence >= auto) { return 'AUTO'; }
  if (confidence >= llm) { return 'LLM'; }
  if (confidence >= review) { return 'REVIEW'; }
  return 'NO_MATCH';
}

/* ─────────────────── ACE precision guards (ported from ace-first-pass.js v1.1.0) ───────────────
 * Two protections this kernel was missing. The spec's own battery found them the hard way, so we
 * import them rather than rediscover them.
 *
 * 1. STRONG-ID VETO — the same identifier asserted on both sides with DIFFERENT values is positive
 *    evidence of difference, not weak evidence of sameness. `CAP-001` vs `CAP-002` is not a near
 *    miss; it is a different machine. Caps the score below AUTO and routes to REVIEW.
 *
 * 2. EVIDENCE SUFFICIENCY — text similarity alone can never reach AUTO. "Delta Industries (MI)"
 *    and "Delta Industries (TX)" score ~1.0 on every name feature and are different companies.
 *    An identifier tier, a facet agreement, or folder consensus counts as corroboration; a high
 *    Jaro-Winkler on its own does not.
 * ============================================================================================= */

/* Which tiers constitute corroboration in their own right. Tier 4 (fuzzy) is text-only and must
   earn corroboration from an agreeing facet. */
function tierIsCorroborated(tier, method, facets, target) {
  if (tier === 1 || tier === 2 || tier === 3) { return true; }   /* identifier / facet tiers */
  if (tier === 5) { return true; }                               /* structural: folder consensus */
  if (tier === 4) {
    var fa = facetAgreement(facets, target);
    return fa.possible > 0 && fa.ratio > 0;                      /* some facet actually agreed */
  }
  return false;
}

/* Same identifier kind on both sides, different value. */
function strongIdConflict(facets, target) {
  if (facets.prefix && target.prefix && facets.num != null && target.num != null &&
      facets.prefix === target.prefix && facets.num !== target.num) {
    return 'ORDINAL:' + facets.prefix + '-' + facets.num + '!=' + target.prefix + '-' + target.num;
  }
  var names = keysOf(facets.scope || {});
  var i;
  for (i = 0; i < names.length; i++) {
    var tv = (target.scope || {})[names[i]];
    if (tv && tv !== facets.scope[names[i]]) {
      return 'SCOPE:' + names[i] + ':' + facets.scope[names[i]] + '!=' + tv;
    }
  }
  return null;
}

/* ─────────────────────────── the pass ─────────────────────────── */

function ctxMatch(input) {
  var inp = input || {};
  var profile = inp.profile || {};
  var targets = inp.targets || [];
  var candidates = inp.candidates || [];

  profile.tokenizer = profile.tokenizer || {};
  profile.weights = profile.weights || { jw: 0.35, dice: 0.20, jaccard: 0.25, facet: 0.20 };
  profile.thresholds = profile.thresholds || { auto: 0.92, propose: 0.72, margin: 0.08 };
  profile.tiers = profile.tiers || { exact: true, norm: true, faceted: true, fuzzy: true, sibling: true };

  var idx = buildIndex(targets, profile);

  /* Run scope. A per-site tenant (or a scoped run) narrows the target set — cheaper and far safer
     than teaching the matcher to guess a missing facet. This MUST run after buildIndex: a
     destination whose facets come from codeFacetPattern has no literal site/area column, so
     filtering the raw rows first would silently discard every target. */
  if (profile.scope) {
    var sk = keysOf(profile.scope);
    if (sk.length) {
      var keep = {};
      var tids0 = keysOf(idx.target);
      var dropped = 0;
      for (i = 0; i < tids0.length; i++) {
        var tsc = idx.target[tids0[i]].scope || {};
        var ok = true;
        for (j = 0; j < sk.length; j++) {
          var want = upper('' + profile.scope[sk[j]]);
          if (tsc[sk[j]] && tsc[sk[j]] !== want) { ok = false; break; }
        }
        if (ok) { keep[tids0[i]] = true; } else { delete idx.target[tids0[i]]; dropped++; }
      }
      var maps = ['byAlnum', 'byCodeNum', 'byPrefix', 'byAlnumSuffix'];
      var mi, mk;
      for (mi = 0; mi < maps.length; mi++) {
        var mp = idx[maps[mi]];
        var mkeys = keysOf(mp);
        for (j = 0; j < mkeys.length; j++) {
          mk = mkeys[j];
          var filtered = [];
          var q;
          for (q = 0; q < mp[mk].length; q++) { if (keep[mp[mk][q]]) { filtered.push(mp[mk][q]); } }
          if (filtered.length) { mp[mk] = filtered; } else { delete mp[mk]; }
        }
      }
      idx.scopeDropped = dropped;
    }
  }
  var results = [];
  var summary = { total: candidates.length, AUTO: 0, PROPOSE: 0, AMBIGUOUS: 0, UNMATCH: 0, REVIEW: 0,
                  byTier: {}, byMethod: {}, byBand: {} };
  var groups = {};   /* parentPath -> { members: [resultIndex], votes: { targetId: n } } */
  var i, j;

  for (i = 0; i < candidates.length; i++) {
    var c = candidates[i];

    /* Identity path. Which field carries the asset identity is a property of the SOURCE
       SYSTEM, not something to guess: PI puts it in tagPath, a CMMS in floc, a legacy MES in
       resourceCode. Declare it in profile.identityFields (first present wins); declare
       hierarchy hints in profile.contextFields — those are prepended so the identity segment
       stays the leaf. Label/descriptor is evidence only, never identity. */
    var pathText = pickField(c, profile.identityFields);
    if (!pathText) {
      var metas = metaStrings(c.rawMetadata, 0);
      for (j = 0; j < metas.length; j++) {
        if (metas[j].indexOf('/') >= 0 || metas[j].indexOf('\\') >= 0) { pathText = metas[j]; break; }
      }
    }
    if (!pathText) { pathText = c.externalKeyPath || c.externalId || ''; }

    /* contextFields append (unlike identityFields, which are first-wins) so a source can supply
       several distinct hints. Dedupe: a relation path and its snapshot fallback usually resolve to
       the SAME value, and repeating it just inflates the token set. */
    var ctxFields = profile.contextFields || [];
    var ctxParts = [];
    for (j = 0; j < ctxFields.length; j++) {
      var cv = pickField(c, [ctxFields[j]]);
      if (cv) { ctxParts.push(cv); }
    }
    ctxParts = uniq(ctxParts);
    if (ctxParts.length) { pathText = ctxParts.join('/') + '/' + pathText; }

    var tk = tokenize(pathText, profile);
    var idTk = tokenize(c.externalId || '', profile);
    /* the external id contributes tokens but not segments (it is not a hierarchy) */
    tk.tokens = uniq(tk.tokens.concat(idTk.tokens));

    var fx = extractFacets(tk, idx, profile);
    var facets = fx.facets;

    var res = {
      candidateId: c.id || c.externalId,
      externalId: c.externalId,
      decision: 'UNMATCH',
      method: null,
      tier: null,
      targetId: null,
      targetCode: null,
      confidence: 0,
      alternatives: [],
      evidence: {
        pathText: pathText,
        segments: tk.segments,
        leaf: tk.leaf,
        facets: facets,
        facetEvidence: fx.evidence,
        flags: []
      }
    };

    /* ── Tier 1: EXACT — the whole identifier IS a target code ── */
    if (profile.tiers.exact) {
      var hitIds = idx.byAlnum[tk.alnum] || idx.byAlnum[alnum(c.externalId)] || null;
      if (!hitIds) {
        for (j = 0; j < tk.segments.length; j++) {
          var h = idx.byAlnum[alnum(tk.segments[j])];
          if (h && h.length === 1) { hitIds = h; break; }
        }
      }
      if (hitIds && hitIds.length === 1) {
        res.decision = 'AUTO'; res.method = 'EXACT'; res.tier = 1;
        res.targetId = hitIds[0]; res.confidence = 1;
      }

      /* 1b AFFIX: the identifier IS the tail of exactly one canonical code. Requires a unique hit
         and a minimum length, so a two-digit number can never latch onto something. */
      if (res.targetId == null) {
        var minA = profile.minAffixLength || 4;
        var affKeys = [tk.alnum, alnum(c.externalId)];
        var ai;
        for (ai = 0; ai < affKeys.length; ai++) {
          var ak2 = affKeys[ai];
          if (!ak2 || ak2.length < minA) { continue; }
          var affHit = idx.byAlnumSuffix[ak2];
          if (affHit && affHit.length === 1) {
            res.decision = 'AUTO'; res.method = 'AFFIX'; res.tier = 1;
            res.targetId = affHit[0]; res.confidence = 0.93;
            res.evidence.flags.push('CODE_DERIVED_BY_PREFIX');
            break;
          } else if (affHit && affHit.length > 1) {
            res.evidence.flags.push('AFFIX_AMBIGUOUS_' + affHit.length);
          }
        }
      }
    }

    /* ── Tier 2: NORM — canonical prefix+number, disambiguated by site/area ── */
    if (res.targetId == null && profile.tiers.norm && facets.prefix && facets.num != null) {
      var pool = idx.byCodeNum[facets.prefix + '#' + facets.num] || [];
      var narrowed = [];
      for (j = 0; j < pool.length; j++) {
        if (!inScope(facets, idx.target[pool[j]])) { continue; }
        narrowed.push(pool[j]);
      }
      if (narrowed.length === 1) {
        res.decision = 'AUTO'; res.method = 'NORM'; res.tier = 2;
        res.targetId = narrowed[0]; res.confidence = 0.95;
      } else if (narrowed.length > 1) {
        res.evidence.flags.push('NORM_AMBIGUOUS_' + narrowed.length);
      }
    }

    /* ── Tier 3: FACETED — prefix + site/area but no ordinal, or ordinal but no prefix ── */
    if (res.targetId == null && profile.tiers.faceted && (facets.prefix || facets.num != null)) {
      var poolF = facets.prefix ? (idx.byPrefix[facets.prefix] || []) : keysOf(idx.target);
      var narrowedF = [];
      for (j = 0; j < poolF.length; j++) {
        var tf = idx.target[poolF[j]];
        if (!inScope(facets, tf)) { continue; }
        if (facets.num != null && tf.num != null && tf.num !== facets.num) { continue; }
        narrowedF.push(poolF[j]);
      }
      if (narrowedF.length === 1) {
        res.decision = 'PROPOSE'; res.method = 'NORM'; res.tier = 3;
        res.targetId = narrowedF[0]; res.confidence = 0.88;
      } else if (narrowedF.length > 1) {
        res.evidence.flags.push('FACETED_AMBIGUOUS_' + narrowedF.length);
        res.evidence.facetedPool = narrowedF.length;
      }
    }

    /* ── Tier 4: FUZZY — weighted blend over the (facet-narrowed) target set ── */
    if (res.targetId == null && profile.tiers.fuzzy) {
      var scored = [];

      /* Only score targets that share a blocking key. Falls back to a full scan when the block is
         empty AND the target set is small enough that scanning is honest — anything larger is
         truncated and COUNTED, never silently dropped (spec B5/B11). */
      var maxPairs = profile.maxPairsPerCandidate || 200;
      var bkeys = candidateBlockKeys(tk, facets);
      var seenT = {};
      var tids = [];
      var bi, bl, bq;
      for (bi = 0; bi < bkeys.length; bi++) {
        bl = idx.byBlock[bkeys[bi]] || [];
        for (bq = 0; bq < bl.length; bq++) {
          if (!seenT[bl[bq]]) { seenT[bl[bq]] = true; tids.push(bl[bq]); }
        }
      }
      summary.blocking = summary.blocking || { blocked: 0, fullScan: 0, truncated: 0, pairsScored: 0 };
      if (!tids.length) {
        var all = keysOf(idx.target);
        if (all.length <= maxPairs) { tids = all; summary.blocking.fullScan++; }
        else { tids = all.slice(0, maxPairs); summary.blocking.truncated++; res.evidence.flags.push('BLOCK_EMPTY_TRUNCATED'); }
      } else {
        summary.blocking.blocked++;
        if (tids.length > maxPairs) {
          tids = tids.slice(0, maxPairs);
          summary.blocking.truncated++;
          res.evidence.flags.push('PAIR_CAP_TRUNCATED');
        }
      }
      summary.blocking.pairsScored += tids.length;
      res.evidence.blockKeys = bkeys.length;
      res.evidence.blockedTo = tids.length;
      for (j = 0; j < tids.length; j++) {
        var cand = idx.target[tids[j]];
        var sc = scoreTarget(c, tk, facets, cand, profile);
        if (sc.total > 0) { scored.push({ id: tids[j], code: cand.code, score: sc.total, parts: sc.parts }); }
      }
      scored.sort(function (a, b) { return b.score - a.score; });
      var top = scored.length ? scored[0] : null;
      var second = scored.length > 1 ? scored[1] : null;
      var margin = top ? (top.score - (second ? second.score : 0)) : 0;

      if (top) {
        res.alternatives = [];
        for (j = 0; j < Math.min(3, scored.length); j++) {
          res.alternatives.push({ targetId: scored[j].id, targetCode: scored[j].code, score: Math.round(scored[j].score * 1000) / 1000 });
        }
        res.evidence.topScore = Math.round(top.score * 1000) / 1000;
        res.evidence.margin = Math.round(margin * 1000) / 1000;
        res.evidence.scoreParts = top.parts;

        if (top.score >= profile.thresholds.propose && margin >= profile.thresholds.margin) {
          res.decision = 'PROPOSE'; res.method = 'FUZZY'; res.tier = 4;
          res.targetId = top.id; res.confidence = Math.round(top.score * 100) / 100;
        } else if (top.score >= profile.thresholds.propose) {
          res.decision = 'AMBIGUOUS'; res.tier = 4;
          res.evidence.flags.push('LOW_MARGIN');
        }
      }
    }

    /* ── ACE precision guards on whatever tier won ── */
    if (res.targetId != null) {
      var guards = profile.guards || {};
      var gTarget = idx.target[res.targetId];
      var vetoCap = guards.vetoCap != null ? guards.vetoCap : 0.69;

      if (guards.vetoOnIdConflict !== false) {
        /* The candidate asserts a scope the chosen target simply does not carry — which happens
           when the target set was never loaded for that scope. Absence is not agreement. */
        var sNames = keysOf(facets.scope || {});
        var si;
        for (si = 0; si < sNames.length; si++) {
          if (!(gTarget.scope || {})[sNames[si]]) {
            res.evidence.flags.push('SCOPE_ASSERTED_BUT_TARGET_SILENT_' + sNames[si] + ':' + facets.scope[sNames[si]]);
          }
        }
        var conflict = strongIdConflict(facets, gTarget);
        if (conflict) {
          res.evidence.flags.push('STRONG_ID_VETO_' + conflict);
          res.confidence = Math.min(res.confidence, vetoCap);
          res.decision = 'REVIEW';
          res.veto = true;
        }
      }

      if (guards.requireCorroboration !== false && !res.veto) {
        var corr = tierIsCorroborated(res.tier, res.method, facets, gTarget);
        res.evidence.corroborated = corr;
        if (!corr) {
          /* uncorroborated name agreement tops out below AUTO — hand it to the LLM band */
          res.confidence = Math.min(res.confidence, profile.thresholds.auto - 0.01);
          res.decision = 'AMBIGUOUS';
          res.evidence.flags.push('UNCORROBORATED_NAME_ONLY');
        }
      }
    }

    /* ── conflict check: does the human descriptor disagree with the path? ──
       This is the "unit trap". Path wins, but the disagreement demotes AUTO to PROPOSE. */
    if (res.targetId != null) {
      var tsel = idx.target[res.targetId];
      var labelTk = tokenize(c.externalLabel || '', profile);
      var labelFacets = extractFacets(labelTk, idx, profile).facets;
      if (labelFacets.num != null && tsel.num != null && labelFacets.num !== tsel.num) {
        res.evidence.flags.push('NUM_CONFLICT_LABEL_' + labelFacets.num);
        if (res.decision === 'AUTO') { res.decision = 'PROPOSE'; res.confidence = Math.min(res.confidence, 0.8); }
      }
      res.targetCode = tsel.code;
    }

    /* record for the sibling pass */
    var gp = tk.parentPath;
    if (gp) {
      if (!groups[gp]) { groups[gp] = { members: [], votes: {} }; }
      groups[gp].members.push(results.length);
      if (res.targetId != null && res.decision !== 'AMBIGUOUS') {
        groups[gp].votes[res.targetId] = (groups[gp].votes[res.targetId] || 0) + 1;
      }
    }
    res.evidence.parentPath = gp;
    results.push(res);
  }

  /* ── Tier 5: SIBLING CONSENSUS — unresolved tags inherit their folder's decision ──
     Ignition trees are folder-per-asset; this is the single highest-yield deterministic tier. */
  if (profile.tiers.sibling) {
    var minGroup = profile.siblingMinGroup || 3;
    var minAgree = profile.siblingMinAgreement || 0.6;
    var gks = keysOf(groups);
    for (i = 0; i < gks.length; i++) {
      var g = groups[gks[i]];
      if (g.members.length < minGroup) { continue; }
      var vk = keysOf(g.votes);
      var best = null;
      var totalVotes = 0;
      for (j = 0; j < vk.length; j++) {
        totalVotes += g.votes[vk[j]];
        if (!best || g.votes[vk[j]] > g.votes[best]) { best = vk[j]; }
      }
      if (!best || totalVotes === 0) { continue; }
      var agreement = g.votes[best] / totalVotes;
      if (agreement < minAgree) { continue; }
      var modal = idx.target[best];
      for (j = 0; j < g.members.length; j++) {
        var r = results[g.members[j]];
        if (r.targetId != null) { continue; }
        /* Folder consensus is only evidence of PROXIMITY. If the member's own identifier
           contradicts the modal target it is a different asset that happens to share a parent
           node (a line or area folder, not an asset folder) — leave it for the LLM pass. */
        var mf = r.evidence.facets || {};
        if ((mf.prefix && modal.prefix && mf.prefix !== modal.prefix) ||
            (mf.num != null && modal.num != null && mf.num !== modal.num) ||
            !inScope(mf, modal)) {
          r.evidence.flags.push('SIBLING_VETOED_BY_OWN_FACETS');
          continue;
        }
        r.decision = 'PROPOSE'; r.method = 'SIBLING'; r.tier = 5;
        r.targetId = best;
        r.targetCode = idx.target[best].code;
        r.confidence = Math.round(Math.min(0.88, 0.55 + 0.35 * agreement) * 100) / 100;
        r.evidence.flags.push('SIBLING_CONSENSUS_' + Math.round(agreement * 100));
        r.evidence.siblingGroup = gks[i];
        r.evidence.siblingVotes = g.votes[best] + '/' + totalVotes;
      }
    }
  }

  /* ── promote / demote against thresholds, then summarise ── */
  for (i = 0; i < results.length; i++) {
    var rr = results[i];
    if (rr.targetId != null && rr.decision === 'AUTO' && rr.confidence < profile.thresholds.auto) {
      rr.decision = 'PROPOSE';
    }
    rr.band = aceBand(rr.confidence, rr.veto === true, profile.thresholds, rr.targetId != null);
    summary[rr.decision] = (summary[rr.decision] || 0) + 1;
    summary.byBand[rr.band] = (summary.byBand[rr.band] || 0) + 1;
    if (rr.tier != null) { summary.byTier['T' + rr.tier] = (summary.byTier['T' + rr.tier] || 0) + 1; }
    if (rr.method) { summary.byMethod[rr.method] = (summary.byMethod[rr.method] || 0) + 1; }
  }
  summary.resolved = summary.AUTO + summary.PROPOSE;
  summary.deferredToLlm = summary.AMBIGUOUS + summary.UNMATCH;

  return {
    profileId: profile.id || null,
    destinationModel: profile.destinationModel || null,
    targetCount: targets.length,
    summary: summary,
    results: results
  };
}

/* node: assign exports BEFORE the trailing return (CommonJS wraps modules in a function,
   so a top-level return simply ends module evaluation). Fuuz: `module` is undefined. */
/* Re-derive a candidate's block without scoring — lets the blocking-recall test (V-IT-11) measure
   candidate generation on its own, which is the only way to see pairs lost BEFORE scoring. */
function blockProbe(idx, profile, candidate) {
  var pathText = pickField(candidate, profile.identityFields);
  if (!pathText) {
    var metas = metaStrings(candidate.rawMetadata, 0);
    var j;
    for (j = 0; j < metas.length; j++) {
      if (metas[j].indexOf('/') >= 0 || metas[j].indexOf('\\') >= 0) { pathText = metas[j]; break; }
    }
  }
  if (!pathText) { pathText = candidate.externalKeyPath || candidate.externalId || ''; }
  profile.tokenizer = profile.tokenizer || {};
  var tk = tokenize(pathText, profile);
  tk.tokens = uniq(tk.tokens.concat(tokenize(candidate.externalId || '', profile).tokens));
  var facets = extractFacets(tk, idx, profile).facets;
  var keys = candidateBlockKeys(tk, facets);
  var seen = {};
  var ids = [];
  var i, q;
  for (i = 0; i < keys.length; i++) {
    var lst = idx.byBlock[keys[i]] || [];
    for (q = 0; q < lst.length; q++) { if (!seen[lst[q]]) { seen[lst[q]] = true; ids.push(lst[q]); } }
  }
  /* the identifier tiers are exact-lookup, not blocked — count them as always reachable */
  var direct = (idx.byAlnum[tk.alnum] || []).concat(idx.byAlnumSuffix[tk.alnum] || []);
  for (q = 0; q < direct.length; q++) { if (!seen[direct[q]]) { seen[direct[q]] = true; ids.push(direct[q]); } }
  if (facets.prefix && facets.num != null) {
    var cn = idx.byCodeNum[facets.prefix + '#' + facets.num] || [];
    for (q = 0; q < cn.length; q++) { if (!seen[cn[q]]) { seen[cn[q]] = true; ids.push(cn[q]); } }
  }
  return { keys: keys, ids: ids, facets: facets };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    ctxMatch: ctxMatch,
    blockProbe: blockProbe,
    tokenize: tokenize,
    buildIndex: buildIndex,
    jaroWinkler: jaroWinkler,
    diceBigram: diceBigram,
    alnum: alnum
  };
}

return ctxMatch(typeof $ !== 'undefined' ? $ : {});
