#!/usr/bin/env node
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const MAX_FILE_BYTES = intEnv("MNEMO_CODE_MAX_FILE_BYTES", 2 * 1024 * 1024);
const MAX_SYMBOLS = intEnv("MNEMO_CODE_MAX_SYMBOLS", 500);
const MAX_UNFOLD_LINES = intEnv("MNEMO_CODE_MAX_UNFOLD_LINES", 500);
const DEFAULT_UNFOLD_LINES = intEnv("MNEMO_CODE_DEFAULT_UNFOLD_LINES", 160);

const CODE_READ_TOOL_DEFS = {
  mem_code_outline: {
    description: "Token-efficient code read step 1. Return imports/headings/symbols with line ranges for a file, without dumping the whole file. Call this before reading large code files.",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Absolute path, or path relative to workspace/root/process cwd." },
        workspace: { type: "string", description: "Optional base directory for relative file_path." },
        query: { type: "string", description: "Optional filter for symbol/import text." },
        include_imports: { type: "boolean", description: "Default true." },
        max_symbols: { type: "integer", description: "Default 200, hard max MNEMO_CODE_MAX_SYMBOLS." },
        max_imports: { type: "integer", description: "Default 80." }
      },
      required: ["file_path"]
    }
  },
  mem_code_unfold: {
    description: "Token-efficient code read step 2. Return only one symbol or bounded line range from a file, with optional context lines and line numbers.",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Absolute path, or path relative to workspace/root/process cwd." },
        workspace: { type: "string", description: "Optional base directory for relative file_path." },
        symbol: { type: "string", description: "Function/class/section name from mem_code_outline." },
        start_line: { type: "integer" },
        end_line: { type: "integer" },
        context_lines: { type: "integer", description: "Default 3." },
        max_lines: { type: "integer", description: "Default 160, hard max MNEMO_CODE_MAX_UNFOLD_LINES." },
        include_line_numbers: { type: "boolean", description: "Default true." }
      },
      required: ["file_path"]
    }
  }
};

function intEnv(name, fallback) {
  const n = parseInt(process.env[name] || "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function handleCodeReadTool(name, args) {
  if (name === "mem_code_outline") return codeOutline(args || {});
  if (name === "mem_code_unfold") return codeUnfold(args || {});
  return { error: "unknown code read tool: " + name };
}

function codeOutline(args) {
  const loaded = loadTextFile(args);
  if (loaded.error) return loaded;
  const symbols = collectSymbols(loaded.lines, loaded.language);
  const query = String(args.query || "").trim().toLowerCase();
  const filteredSymbols = query
    ? symbols.filter(s => [s.kind, s.name, s.signature].join(" ").toLowerCase().includes(query))
    : symbols;
  const maxSymbols = Math.min(args.max_symbols || 200, MAX_SYMBOLS);
  const imports = args.include_imports === false ? [] : collectImports(loaded.lines, loaded.language, args.max_imports || 80, query);
  const shownSymbols = filteredSymbols.slice(0, maxSymbols);
  return {
    file_path: loaded.file_path,
    relative_path: loaded.relative_path,
    language: loaded.language,
    byte_count: loaded.byte_count,
    line_count: loaded.lines.length,
    truncated_bytes: loaded.truncated_bytes,
    rough_token_estimate_full_file: roughTokens(loaded.text),
    imports: { count: imports.length, items: imports },
    symbols: { count: filteredSymbols.length, shown: shownSymbols.length, truncated: filteredSymbols.length > shownSymbols.length, items: shownSymbols },
    next_step: "Use mem_code_unfold with {file_path, symbol} or {file_path, start_line, end_line}; do not read the whole file unless the outline proves it is necessary."
  };
}

function codeUnfold(args) {
  const loaded = loadTextFile(args);
  if (loaded.error) return loaded;
  const context = clampInt(args.context_lines, 3, 0, 50);
  const maxLines = clampInt(args.max_lines, DEFAULT_UNFOLD_LINES, 1, MAX_UNFOLD_LINES);
  let start = Number(args.start_line || 0);
  let end = Number(args.end_line || 0);
  let matchedSymbol = null;

  if (args.symbol) {
    const symbols = collectSymbols(loaded.lines, loaded.language);
    const wanted = String(args.symbol || "").trim().toLowerCase();
    const exact = symbols.filter(s => s.name.toLowerCase() === wanted || s.signature.toLowerCase().includes(wanted));
    const partial = exact.length ? exact : symbols.filter(s => [s.kind, s.name, s.signature].join(" ").toLowerCase().includes(wanted));
    if (!partial.length) {
      return { error: "symbol_not_found", file_path: loaded.file_path, symbol: args.symbol, hint: "Call mem_code_outline and use one of the returned symbol names.", candidates: symbols.slice(0, 30).map(s => ({ kind: s.kind, name: s.name, line: s.line })) };
    }
    if (partial.length > 1 && !exact.length) {
      return { error: "symbol_ambiguous", file_path: loaded.file_path, symbol: args.symbol, matches: partial.slice(0, 20).map(s => ({ kind: s.kind, name: s.name, line: s.line, signature: s.signature })) };
    }
    matchedSymbol = partial[0];
    start = matchedSymbol.line;
    end = matchedSymbol.end_line || matchedSymbol.line;
  }

  if (!start && !end) return { error: "symbol or start_line/end_line required", file_path: loaded.file_path };
  if (!start) start = end;
  if (!end) end = start;
  if (start > end) [start, end] = [end, start];
  start = clampInt(start - context, 1, 1, loaded.lines.length);
  end = clampInt(end + context, start, start, loaded.lines.length);

  let truncated = false;
  if (end - start + 1 > maxLines) {
    end = start + maxLines - 1;
    truncated = true;
  }
  const selected = loaded.lines.slice(start - 1, end);
  const includeNumbers = args.include_line_numbers !== false;
  const width = String(end).length;
  const content = selected.map((line, idx) => includeNumbers ? `${String(start + idx).padStart(width, " ")} | ${line}` : line).join("\n");
  return {
    file_path: loaded.file_path,
    relative_path: loaded.relative_path,
    language: loaded.language,
    symbol: matchedSymbol,
    start_line: start,
    end_line: end,
    lines_returned: selected.length,
    truncated,
    rough_token_estimate: roughTokens(content),
    content,
    next_step: truncated ? { start_line: end + 1, end_line: Math.min(loaded.lines.length, end + maxLines) } : null
  };
}

function loadTextFile(args) {
  const resolved = resolveCodePath(args);
  if (resolved.error) return resolved;
  const stat = fs.statSync(resolved.file_path);
  if (!stat.isFile()) return { error: "not_a_file", file_path: resolved.file_path };
  if (stat.size > MAX_FILE_BYTES) {
    return { error: "file_too_large", file_path: resolved.file_path, byte_count: stat.size, max_bytes: MAX_FILE_BYTES, hint: "Raise MNEMO_CODE_MAX_FILE_BYTES only if this is intentional." };
  }
  const buf = fs.readFileSync(resolved.file_path);
  if (looksBinary(buf)) return { error: "binary_file", file_path: resolved.file_path, byte_count: stat.size };
  const text = buf.toString("utf8").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return {
    file_path: resolved.file_path,
    relative_path: resolved.relative_path,
    language: inferLanguage(resolved.file_path),
    byte_count: stat.size,
    truncated_bytes: 0,
    text,
    lines: text.split("\n")
  };
}

function resolveCodePath(args) {
  const raw = String(args.file_path || args.path || "").trim();
  if (!raw) return { error: "file_path required" };
  const expanded = raw.replace(/^~(?=$|[\\/])/, os.homedir());
  const base = args.workspace || args.root || process.env.AGENT_WORKSPACE || process.env.MNEMO_WORKSPACE || process.cwd();
  const candidate = path.resolve(path.isAbsolute(expanded) ? expanded : path.join(base, expanded));
  let real = candidate;
  try { real = fs.realpathSync(candidate); } catch {
    return { error: "file_not_found", file_path: candidate };
  }
  const roots = allowedRoots();
  const matched = roots.find(root => isInside(real, root));
  if (!matched) {
    return { error: "path_not_allowed", file_path: real, allowed_roots: roots, hint: "Set MNEMO_CODE_ROOTS (path-delimited) or run the daemon from the project workspace." };
  }
  return { file_path: real, relative_path: path.relative(matched, real) || path.basename(real) };
}

function allowedRoots() {
  const roots = [];
  function add(root) {
    if (!root) return;
    for (const part of String(root).split(path.delimiter)) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      try {
        const real = fs.realpathSync(path.resolve(trimmed.replace(/^~(?=$|[\\/])/, os.homedir())));
        if (!roots.some(r => samePath(r, real))) roots.push(real);
      } catch {}
    }
  }
  add(process.env.MNEMO_CODE_ROOTS);
  add(process.env.AGENT_WORKSPACE);
  add(process.env.MNEMO_WORKSPACE);
  add(process.cwd());
  add(path.resolve(__dirname, "..", ".."));
  add(os.homedir());
  return roots;
}

function samePath(a, b) {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function isInside(file, root) {
  const rel = path.relative(root, file);
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

function looksBinary(buf) {
  const len = Math.min(buf.length, 8192);
  for (let i = 0; i < len; i++) if (buf[i] === 0) return true;
  return false;
}

function inferLanguage(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const base = path.basename(filePath).toLowerCase();
  if ([".js", ".jsx", ".mjs", ".cjs"].includes(ext)) return "javascript";
  if ([".ts", ".tsx", ".mts", ".cts"].includes(ext)) return "typescript";
  if (ext === ".py") return "python";
  if (ext === ".go") return "go";
  if ([".rs"].includes(ext)) return "rust";
  if ([".java", ".kt", ".kts", ".scala"].includes(ext)) return "jvm";
  if ([".cs"].includes(ext)) return "csharp";
  if ([".c", ".h", ".cc", ".cpp", ".hpp", ".hh"].includes(ext)) return "cpp";
  if ([".php"].includes(ext)) return "php";
  if ([".rb"].includes(ext)) return "ruby";
  if ([".css", ".scss", ".sass", ".less"].includes(ext)) return "css";
  if ([".html", ".htm", ".svelte", ".vue"].includes(ext)) return "markup";
  if ([".md", ".mdx"].includes(ext) || base === "readme") return "markdown";
  if ([".json", ".jsonc"].includes(ext)) return "json";
  if ([".yml", ".yaml"].includes(ext)) return "yaml";
  if ([".sql"].includes(ext)) return "sql";
  if ([".sh", ".bash", ".zsh", ".ps1"].includes(ext)) return "shell";
  return "text";
}

function collectImports(lines, language, max, query) {
  const out = [];
  const patterns = importPatterns(language);
  if (!patterns.length) return out;
  for (let i = 0; i < lines.length && out.length < max; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    if (patterns.some(re => re.test(trimmed))) {
      const item = { line: i + 1, text: trimmed.slice(0, 220) };
      if (!query || item.text.toLowerCase().includes(query)) out.push(item);
    }
  }
  return out;
}

function importPatterns(language) {
  if (["javascript", "typescript"].includes(language)) return [/^import\s+/, /^export\s+.*\s+from\s+/, /^const\s+.+\s*=\s*require\(/];
  if (language === "python") return [/^import\s+/, /^from\s+.+\s+import\s+/];
  if (language === "go") return [/^import\s+/, /^import\s*\(/];
  if (language === "rust") return [/^use\s+/, /^mod\s+/];
  if (language === "php") return [/^use\s+/, /^require(_once)?\s+/, /^include(_once)?\s+/];
  if (language === "jvm" || language === "csharp") return [/^import\s+/, /^using\s+/];
  if (language === "css") return [/^@import\s+/];
  return [];
}

function collectSymbols(lines, language) {
  const raw = [];
  for (let i = 0; i < lines.length; i++) {
    const hit = detectSymbol(lines[i], language);
    if (!hit) continue;
    raw.push(Object.assign(hit, { line: i + 1, signature: lines[i].trim().slice(0, 240) }));
  }
  for (let i = 0; i < raw.length; i++) {
    const startIdx = raw[i].line - 1;
    const nextLine = raw[i + 1] ? raw[i + 1].line - 1 : lines.length;
    raw[i].end_line = estimateEndLine(lines, startIdx, language, nextLine);
  }
  return raw;
}

function detectSymbol(line, language) {
  const s = line.trim();
  let m;
  if (!s || s.startsWith("//") || s.startsWith("*")) return null;
  if (["javascript", "typescript"].includes(language)) {
    if ((m = s.match(/^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/))) return { kind: "function", name: m[1] };
    if ((m = s.match(/^(?:export\s+)?(?:class|interface|type|enum)\s+([A-Za-z_$][\w$]*)\b/))) return { kind: s.includes(" class ") || s.startsWith("class ") ? "class" : "type", name: m[1] };
    if ((m = s.match(/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/))) return { kind: "function", name: m[1] };
    if ((m = s.match(/^(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/)) && !/^(if|for|while|switch|catch)\b/.test(s)) return { kind: "method", name: m[1] };
  } else if (language === "python") {
    if ((m = line.match(/^(\s*)class\s+([A-Za-z_][\w]*)\b/))) return { kind: "class", name: m[2], indent: m[1].length };
    if ((m = line.match(/^(\s*)(?:async\s+)?def\s+([A-Za-z_][\w]*)\s*\(/))) return { kind: "function", name: m[2], indent: m[1].length };
  } else if (language === "go") {
    if ((m = s.match(/^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/))) return { kind: "function", name: m[1] };
    if ((m = s.match(/^type\s+([A-Za-z_]\w*)\s+(?:struct|interface|func|\w+)/))) return { kind: "type", name: m[1] };
  } else if (language === "rust") {
    if ((m = s.match(/^(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)\s*\(/))) return { kind: "function", name: m[1] };
    if ((m = s.match(/^(?:pub\s+)?(?:struct|enum|trait|impl)\s+([A-Za-z_]\w*)?/))) return { kind: s.split(/\s+/).includes("impl") ? "impl" : "type", name: m[1] || s.slice(0, 80) };
  } else if (["jvm", "csharp", "cpp", "php", "ruby"].includes(language)) {
    if ((m = s.match(/^(?:public|private|protected|internal|static|final|abstract|sealed|export|\s)*\s*(?:class|interface|enum|record|trait)\s+([A-Za-z_]\w*)/))) return { kind: "type", name: m[1] };
    if ((m = s.match(/^(?:public|private|protected|internal|static|final|abstract|virtual|override|async|\s)*\s*(?:function\s+)?(?:[\w:<>,\[\]?*&]+\s+)?([A-Za-z_]\w*)\s*\([^;]*\)\s*(?:\{|=>|$)/)) && !/^(if|for|while|switch|catch)\b/.test(s)) return { kind: "function", name: m[1] };
    if (language === "ruby" && (m = s.match(/^def\s+([A-Za-z_]\w*[!?=]?)/))) return { kind: "function", name: m[1] };
  } else if (language === "markdown") {
    if ((m = line.match(/^(#{1,6})\s+(.+)/))) return { kind: "heading", name: m[2].trim().slice(0, 120), level: m[1].length };
  } else if (language === "css") {
    if (s.endsWith("{") && !s.startsWith("@media") && !s.startsWith("@keyframes")) return { kind: "selector", name: s.slice(0, -1).trim().slice(0, 120) };
    if ((m = s.match(/^@(media|keyframes|supports)\s+(.+)\s*\{/))) return { kind: "at-rule", name: `${m[1]} ${m[2]}`.slice(0, 120) };
  } else if (language === "json") {
    if ((m = line.match(/^\s{0,4}"([^"]+)"\s*:/))) return { kind: "key", name: m[1] };
  } else if (language === "yaml") {
    if ((m = line.match(/^([A-Za-z0-9_.-][^:#]*):\s*($|[^/])/))) return { kind: "key", name: m[1].trim() };
  } else if (language === "sql") {
    if ((m = s.match(/^CREATE\s+(?:OR\s+REPLACE\s+)?(TABLE|VIEW|FUNCTION|PROCEDURE|INDEX|TRIGGER)\s+([^\s(]+)/i))) return { kind: m[1].toLowerCase(), name: m[2] };
  } else if (language === "shell") {
    if ((m = s.match(/^([A-Za-z_][\w.-]*)\s*\(\)\s*\{/))) return { kind: "function", name: m[1] };
    if ((m = s.match(/^function\s+([A-Za-z_][\w.-]*)/))) return { kind: "function", name: m[1] };
  }
  return null;
}

function estimateEndLine(lines, startIdx, language, nextLine) {
  if (language === "python") return indentationEnd(lines, startIdx, nextLine);
  if (language === "markdown") return markdownEnd(lines, startIdx, nextLine);
  const braceEnd = braceEndLine(lines, startIdx);
  if (braceEnd) return Math.min(braceEnd, nextLine);
  return Math.max(startIdx + 1, nextLine);
}

function indentationEnd(lines, startIdx, nextLine) {
  const baseIndent = (lines[startIdx].match(/^\s*/) || [""])[0].length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const indent = (line.match(/^\s*/) || [""])[0].length;
    if (indent <= baseIndent) return Math.max(startIdx + 1, i);
  }
  return nextLine;
}

function markdownEnd(lines, startIdx, nextLine) {
  const m = lines[startIdx].match(/^(#{1,6})\s+/);
  if (!m) return nextLine;
  const level = m[1].length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const h = lines[i].match(/^(#{1,6})\s+/);
    if (h && h[1].length <= level) return i;
  }
  return lines.length;
}

function braceEndLine(lines, startIdx) {
  let depth = 0;
  let seen = false;
  for (let i = startIdx; i < lines.length && i < startIdx + 2000; i++) {
    const code = lines[i].replace(/(["'`])(?:\\.|(?!\1).)*\1/g, "");
    for (const ch of code) {
      if (ch === "{") { depth++; seen = true; }
      else if (ch === "}") depth--;
    }
    if (seen && depth <= 0 && i > startIdx) return i + 1;
  }
  return null;
}

function clampInt(value, fallback, min, max) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function roughTokens(text) {
  return Math.ceil(String(text || "").length / 4);
}

module.exports = { CODE_READ_TOOL_DEFS, handleCodeReadTool, codeOutline, codeUnfold };
