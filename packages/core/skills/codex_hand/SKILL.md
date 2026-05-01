---
name: codex_hand
description: Drive an OpenAI Codex CLI session running on the owner's local machine via Desktop-Control. Replaces the brief-file workflow — the agent operates Codex directly from a Mnemo-MCP context, pasting prompts and harvesting results without round-tripping through git or shared documents.
trigger_phrases:
  - 'codex (mach|fix|implement|baue|baue|portier|refactor)'
  - 'lass codex'
  - 'gib das codex'
  - 'codex hand'
  - 'have codex (do|fix|implement)'
sandbox: none
requires_confirmation: true
sensitive_data: ['repo_paths', 'shell_commands']
status: stub
first_recorded_at: 2026-05-01T23:50:00Z
---

## Recipe steps

1. Verify Codex CLI is reachable on the owner's machine (`which codex` or windows-equivalent). If not, surface install command.
2. Read the requested task from input (`{ prompt, repo_path, allow_edit, allow_run_tests }`).
3. Open or focus the terminal window where Codex CLI runs (PowerShell, iTerm, Linux terminal).
4. Type `cd <repo_path>` then enter.
5. Type the prompt. Wait for Codex's response (poll for shell prompt return, max wait 5 min).
6. Capture stdout into Mnemo: `mem_add({kind:'codex_run', importance:7, text:<output>, meta_json:{prompt, repo_path}})`.
7. If Codex proposes an edit/diff and `allow_edit=true` is set, accept; otherwise pause and surface the diff via Telegram for owner approval.
8. If tests can run + `allow_run_tests=true`, execute, capture pass/fail, log.
9. Push commit only after explicit owner go-ahead. Never auto-push.

## First invocation outcome

(Not yet invoked. The skill is a contract — actual execution requires either:
- Direct Desktop-Control MCP session active in the agent's runtime, or
- The mnemo-pc agent with `app_focus` + `type_text` tools, or
- A local `codex` shim that reads/writes to a known socket.)

## Notes

This skill replaces the "Codex brief file" workflow that lived in the autoflashershop repo. With Mnemo + Codex-Hand the agent has direct hands on the local Codex CLI, so:
- No `Dieterinfo.md` / `Codex1info.md` shared file needed
- No git intermediate for context-passing
- Memory is shared automatically (Codex side reads via Mnemo MCP)

Until the mnemo-pc binary is paired on the owner's machine, fall back to manual: agent generates the prompt block + asks owner to paste.
