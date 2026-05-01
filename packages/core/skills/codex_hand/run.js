#!/usr/bin/env node
/**
 * codex_hand/run.js — entry point for the codex_hand skill.
 *
 * V1 just emits the prompt block the agent should hand to Codex on the
 * owner's local machine. Real auto-execution lands when mnemo-pc is paired
 * (then this file calls into the dispatcher RPC: app_focus → type_text →
 * key_press enter → wait → capture).
 *
 * Stdin: JSON { prompt, repo_path, allow_edit?, allow_run_tests? }
 * Stdout: JSON { mode, prepared_block } or { ok, output, ... }
 */
"use strict";

const fs = require("fs");

function readStdin() {
  return new Promise((resolve) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", c => buf += c);
    process.stdin.on("end", () => resolve(buf));
    setTimeout(() => resolve(buf), 200);
  });
}

(async () => {
  const raw = await readStdin();
  let input = {};
  try { input = JSON.parse(raw || "{}"); } catch {}

  const prompt = input.prompt || "(no prompt)";
  const repo = input.repo_path || "(no repo specified)";
  const allow_edit = input.allow_edit ? "yes" : "no — pause for review before applying";
  const allow_run_tests = input.allow_run_tests ? "yes" : "no — surface results, don't auto-run";

  const block = [
    "# Codex-Hand Brief",
    "",
    `**Repo:** ${repo}`,
    `**Auto-apply edits:** ${allow_edit}`,
    `**Auto-run tests:** ${allow_run_tests}`,
    "",
    "**Task:**",
    "",
    prompt.trim(),
    "",
    "After completion: report back via Mnemo `mem_add({kind:'codex_run',importance:7,...})`.",
  ].join("\n");

  // Detect whether mnemo-pc is available (would normally check via env or
  // by querying the dispatcher; for the stub we just check the env flag).
  const mode = process.env.MNEMO_PC_PAIRED === "1" ? "auto_via_mnemo_pc" : "manual_paste";

  const result = {
    mode,
    prepared_block: block,
    notes: mode === "manual_paste"
      ? "mnemo-pc not paired — surface prepared_block to owner, ask them to paste into Codex CLI"
      : "mnemo-pc paired — invoke app_focus → type_text → key_press enter via dispatcher RPC",
  };
  process.stdout.write(JSON.stringify(result, null, 2));
})();
