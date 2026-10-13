#!/usr/bin/env node
'use strict';
// Extend the isolated real Chrome column regression with custom field user flows.
process.env.SMOKE_CUSTOM_FIELDS = '1';
require('./column-resize-smoke.cjs');
