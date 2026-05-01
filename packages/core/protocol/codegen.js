#!/usr/bin/env node
/**
 * codegen.js — emit JSON-Schema + native-language stubs from schema.ts.
 *
 * Until @sinclair/typebox is a dependency you can run
 *   npx tsx protocol/codegen.js
 * to compile + execute. For now this is a skeleton; the actual emit logic
 * lands together with the mnemo-pc-agent build-out (Phase 2).
 *
 * Targets planned:
 *   - protocol/dist/schema.json   (canonical JSON Schema)
 *   - protocol/dist/swift/*.swift (Mnemo Remote iOS)
 *   - protocol/dist/kotlin/*.kt   (Mnemo Remote Android)
 *   - protocol/dist/go/*.go       (mnemo-pc binary)
 */
"use strict";

console.log(`mnemo protocol codegen — placeholder.

The wire protocol lives in protocol/schema.ts (TypeBox).
Run when the Phase-2 PC-Agent build starts; for now this skeleton just
documents the intent so contributors know not to hand-write client code.`);
