#!/usr/bin/env node
'use strict';

// Reuses the isolated, dependency-free Chrome/CDP regression harness.
process.env.SMOKE_FRONTEND = '1';
require('./browser-smoke.cjs');
