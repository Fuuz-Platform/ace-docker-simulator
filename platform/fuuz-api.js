/*
 * Shim. In the Fuuz monorepo this re-exports packages/fuuz-api, which three accelerators share.
 * This repo is a standalone extract, so it re-exports the vendored copy instead — the require
 * paths inside orchestrator/ and docdrop/ are unchanged, and there is still exactly ONE
 * implementation rather than copies that quietly drift.
 */
'use strict';
module.exports = require('../vendor/fuuz-api/index.js');
