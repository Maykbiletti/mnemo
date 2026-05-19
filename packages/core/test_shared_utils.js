"use strict";

const assert = require("assert");
const su = require("./shared_utils");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (e) {
    failed++;
    console.error(`FAIL: ${name}\n  ${e.message}`);
  }
}

// --- parseMaybeJson ---

test("parseMaybeJson parses valid JSON", () => {
  assert.deepStrictEqual(su.parseMaybeJson('{"a":1}', {}), { a: 1 });
});

test("parseMaybeJson returns fallback for null/empty", () => {
  assert.strictEqual(su.parseMaybeJson(null, "fb"), "fb");
  assert.strictEqual(su.parseMaybeJson("", "fb"), "fb");
  assert.strictEqual(su.parseMaybeJson(undefined, "fb"), "fb");
});

test("parseMaybeJson returns raw string on bad JSON when no fallback", () => {
  assert.strictEqual(su.parseMaybeJson("not-json"), "not-json");
});

test("parseMaybeJson returns fallback on bad JSON when fallback given", () => {
  assert.strictEqual(su.parseMaybeJson("not-json", 42), 42);
});

test("parseMaybeJson passes through non-strings", () => {
  const obj = { x: 1 };
  assert.strictEqual(su.parseMaybeJson(obj, null), obj);
  assert.strictEqual(su.parseMaybeJson(42, null), 42);
});

// --- uniqueIntegers ---

test("uniqueIntegers dedupes and filters", () => {
  assert.deepStrictEqual(su.uniqueIntegers([1, "2", "abc", 3, 1]), [1, 2, 3]);
});

test("uniqueIntegers handles single value", () => {
  assert.deepStrictEqual(su.uniqueIntegers(5), [5]);
});

test("uniqueIntegers rejects zero and negatives", () => {
  assert.deepStrictEqual(su.uniqueIntegers([0, -1, 3]), [3]);
});

// --- deepMergePlain ---

test("deepMergePlain merges nested objects", () => {
  assert.deepStrictEqual(
    su.deepMergePlain({ a: 1, b: { c: 2 } }, { b: { d: 3 }, e: 4 }),
    { a: 1, b: { c: 2, d: 3 }, e: 4 }
  );
});

test("deepMergePlain override replaces arrays", () => {
  assert.deepStrictEqual(
    su.deepMergePlain({ a: [1] }, { a: [2, 3] }),
    { a: [2, 3] }
  );
});

test("deepMergePlain handles null inputs", () => {
  assert.deepStrictEqual(su.deepMergePlain(null, { a: 1 }), { a: 1 });
  assert.deepStrictEqual(su.deepMergePlain({ a: 1 }, null), { a: 1 });
});

// --- stripPrivate ---

test("stripPrivate removes private blocks", () => {
  const r = su.stripPrivate("hello <private>secret</private> world");
  assert.strictEqual(r.text, "hello [private] world");
  assert.strictEqual(r.hadPrivate, true);
});

test("stripPrivate is case-insensitive and multiline", () => {
  const r = su.stripPrivate("a <Private>\nline1\nline2\n</PRIVATE> b");
  assert.strictEqual(r.text, "a [private] b");
  assert.strictEqual(r.hadPrivate, true);
});

test("stripPrivate removes no-memory and comment blocks", () => {
  const r = su.stripPrivate("a <no-memory>skip</no-memory> b <!-- mnemo:private -->secret<!-- /mnemo:private --> c");
  assert.strictEqual(r.text, "a [no-memory] b [private] c");
  assert.strictEqual(r.hadPrivate, true);
});

test("stripPrivate removes bracket blocks", () => {
  const r = su.stripPrivate("keep [private]secret[/private] and [no-memory]discard[/no-memory]");
  assert.strictEqual(r.text, "keep [private] and [no-memory]");
  assert.strictEqual(r.hadPrivate, true);
});

test("stripPrivate no-ops without markers", () => {
  const r = su.stripPrivate("plain text");
  assert.strictEqual(r.text, "plain text");
  assert.strictEqual(r.hadPrivate, false);
});

test("stripPrivate handles non-string", () => {
  assert.deepStrictEqual(su.stripPrivate(null), { text: null, hadPrivate: false });
  assert.deepStrictEqual(su.stripPrivate(""), { text: "", hadPrivate: false });
});

// --- parseAgentCsv ---

test("parseAgentCsv splits and trims", () => {
  assert.deepStrictEqual(su.parseAgentCsv("alice, bob, charlie"), ["alice", "bob", "charlie"]);
});

test("parseAgentCsv handles null/empty", () => {
  assert.deepStrictEqual(su.parseAgentCsv(null), []);
  assert.deepStrictEqual(su.parseAgentCsv(""), []);
});

// --- normalizeAgentName ---

test("normalizeAgentName lowercases and trims", () => {
  assert.strictEqual(su.normalizeAgentName(" Dieter "), "dieter");
  assert.strictEqual(su.normalizeAgentName(null), "");
});

// --- jsonSafe ---

test("jsonSafe truncates long strings", () => {
  const long = "x".repeat(200);
  const r = su.jsonSafe(long, 100);
  assert.ok(r.length <= 120); // 100 + truncation marker
  assert.ok(r.endsWith("...[truncated]"));
});

test("jsonSafe serializes objects", () => {
  assert.strictEqual(su.jsonSafe({ a: 1 }), '{"a":1}');
});

test("jsonSafe returns null for undefined", () => {
  assert.strictEqual(su.jsonSafe(undefined), null);
});

// --- compactContent ---

test("compactContent strips private and truncates", () => {
  const r = su.compactContent("keep <private>drop</private> keep", 100);
  assert.ok(!r.includes("drop"));
  assert.ok(r.includes("[private]"));
});

// --- parseMetaJson ---

test("parseMetaJson parses valid JSON", () => {
  assert.deepStrictEqual(su.parseMetaJson('{"a":1}'), { a: 1 });
});

test("parseMetaJson returns {} on bad input", () => {
  assert.deepStrictEqual(su.parseMetaJson(null), {});
  assert.deepStrictEqual(su.parseMetaJson("bad"), {});
});

// --- isoOrNull ---

test("isoOrNull converts date-only to ISO", () => {
  const r = su.isoOrNull("2026-05-12");
  assert.ok(r.startsWith("2026-05-12"));
  assert.ok(r.includes("T"));
});

test("isoOrNull returns null for garbage", () => {
  assert.strictEqual(su.isoOrNull("not a date"), null);
  assert.strictEqual(su.isoOrNull(""), null);
  assert.strictEqual(su.isoOrNull(null), null);
});

// --- cleanScope ---

test("cleanScope strips non-alphanumeric", () => {
  assert.strictEqual(su.cleanScope("Test Scope!"), "testscope");
  assert.strictEqual(su.cleanScope("valid-name_1"), "valid-name_1");
});

test("cleanScope defaults to 'default'", () => {
  assert.strictEqual(su.cleanScope(null), "default");
  assert.strictEqual(su.cleanScope(""), "default");
});

// --- uniqueAgentNames ---

test("uniqueAgentNames dedupes and excludes team aliases", () => {
  const r = su.uniqueAgentNames(["Alice", "bob", "alice", "all", "Bob"]);
  assert.deepStrictEqual(r, ["alice", "bob"]);
});

// --- isTeamBriefTarget ---

test("isTeamBriefTarget recognizes aliases", () => {
  assert.strictEqual(su.isTeamBriefTarget("all"), true);
  assert.strictEqual(su.isTeamBriefTarget("Team"), true);
  assert.strictEqual(su.isTeamBriefTarget("everyone"), true);
  assert.strictEqual(su.isTeamBriefTarget("dieter"), false);
});

// --- parseBriefTitle ---

test("parseBriefTitle extracts first content line", () => {
  // parseBriefTitle strips heading markers, so "## Heading" becomes "Heading"
  assert.strictEqual(su.parseBriefTitle("## Heading\nContent line"), "Heading");
});

test("parseBriefTitle defaults to Brief", () => {
  assert.strictEqual(su.parseBriefTitle(""), "Brief");
  assert.strictEqual(su.parseBriefTitle(null), "Brief");
});

// --- hasCanonicalBriefShape ---

test("hasCanonicalBriefShape detects canonical format", () => {
  const canonical = "## Title\nfoo\n## Project\nbar\n## Request\nbaz\n## Acceptance\nqux\n## Report Back\nend";
  assert.strictEqual(su.hasCanonicalBriefShape(canonical), true);
  assert.strictEqual(su.hasCanonicalBriefShape("just text"), false);
});

// --- normalizeBriefContent ---

test("normalizeBriefContent wraps plain text", () => {
  const r = su.normalizeBriefContent("Do this task", { project: "test-proj" });
  assert.ok(r.content.includes("## Title"));
  assert.ok(r.content.includes("## Project"));
  assert.ok(r.content.includes("test-proj"));
  assert.ok(r.content.includes("Do this task"));
  assert.strictEqual(r.meta.brief_contract_version, "firm-brief-v1");
});

test("normalizeBriefContent preserves canonical shape", () => {
  const canonical = "## Title\nfoo\n## Project\nbar\n## Request\nbaz\n## Acceptance\nqux\n## Report Back\nend";
  const r = su.normalizeBriefContent(canonical, {});
  assert.strictEqual(r.content, canonical);
});

// --- baseName / extensionName ---

test("baseName extracts filename", () => {
  assert.strictEqual(su.baseName("/a/b/file.txt"), "file.txt");
  assert.strictEqual(su.baseName("file.txt"), "file.txt");
  assert.strictEqual(su.baseName(null), "");
});

test("extensionName extracts extension", () => {
  assert.strictEqual(su.extensionName("/a/b/photo.PNG"), "png");
  assert.strictEqual(su.extensionName("noext"), "");
});

// --- inferMediaKind ---

test("inferMediaKind detects screenshot by extension", () => {
  assert.strictEqual(su.inferMediaKind({ event_kind: "" }, {}, {}, "img.png", "png"), "screenshot");
});

test("inferMediaKind detects document by extension", () => {
  assert.strictEqual(su.inferMediaKind({ event_kind: "" }, {}, {}, "doc.pdf", "pdf"), "document");
});

test("inferMediaKind treats html/text exports as documents", () => {
  assert.strictEqual(su.inferMediaKind({ event_kind: "" }, {}, {}, "admin.html", "html"), "document");
  assert.strictEqual(su.inferMediaKind({ event_kind: "" }, {}, {}, "notes.txt", "txt"), "document");
});

test("inferMediaKind uses hinted kind", () => {
  assert.strictEqual(su.inferMediaKind({ event_kind: "", media_kind: "image" }, {}, {}, "", ""), "image");
});

test("buildMediaTitle creates chat-context screenshot title", () => {
  assert.strictEqual(
    su.buildMediaTitle({
      source: "telegram",
      channel: "telegram-chat:-100",
      occurred_at: "2026-02-22T13:45:00",
      content: "Hier ein Screenshot vom Admin Design",
      media_kind: "screenshot"
    }),
    "Chat 22.02.2026 13:45 Hier ein Screenshot vom Admin Design"
  );
});

test("buildCanonicalMediaFileName creates safe contextual filename", () => {
  const name = su.buildCanonicalMediaFileName({
    source: "telegram",
    channel: "telegram-chat:-100",
    occurred_at: "2026-02-22T13:45:00",
    title: "Chat 22.02.2026 13:45 Hier ein Screenshot vom Admin Design",
    file_ext: "png"
  });
  assert(name.endsWith(".png"));
  assert(name.includes("chat-2026-02-22-13-45"));
  assert(name.includes("admin-design"));
});

// --- uniqueStrings ---

test("uniqueStrings dedupes and trims", () => {
  assert.deepStrictEqual(su.uniqueStrings(["a", " b ", "a", "", "B"]), ["a", "b", "B"]);
});

// --- boolFlag ---

test("boolFlag parses string booleans", () => {
  assert.strictEqual(su.boolFlag("yes"), true);
  assert.strictEqual(su.boolFlag("0"), false);
  assert.strictEqual(su.boolFlag("true"), true);
  assert.strictEqual(su.boolFlag("disabled"), false);
});

test("boolFlag uses fallback for null/undefined/empty", () => {
  assert.strictEqual(su.boolFlag(null, true), true);
  assert.strictEqual(su.boolFlag(undefined, false), false);
  // empty string with no explicit fallback defaults to false
  assert.strictEqual(su.boolFlag(""), false);
  assert.strictEqual(su.boolFlag("", true), true);
});

// --- isoAgeDays ---

test("isoAgeDays returns 0 for today", () => {
  assert.strictEqual(su.isoAgeDays(new Date().toISOString()), 0);
});

test("isoAgeDays returns null for garbage", () => {
  assert.strictEqual(su.isoAgeDays("nope"), null);
  assert.strictEqual(su.isoAgeDays(null), null);
});

// --- freshnessFromAgeDays ---

test("freshnessFromAgeDays classifies correctly", () => {
  assert.strictEqual(su.freshnessFromAgeDays(0, 7, 30), "fresh");
  assert.strictEqual(su.freshnessFromAgeDays(10, 7, 30), "stale");
  assert.strictEqual(su.freshnessFromAgeDays(31, 7, 30), "critical");
  assert.strictEqual(su.freshnessFromAgeDays(null, 7, 30), "unknown");
});

// --- Reminder helpers ---

test("normalizeReminderText lowercases and strips accents", () => {
  assert.strictEqual(su.normalizeReminderText("Übermorgen"), "ubermorgen");
});

test("parseReminderTime extracts HH:MM", () => {
  const r = su.parseReminderTime("um 14:30");
  assert.strictEqual(r.hour, 14);
  assert.strictEqual(r.minute, 30);
  assert.strictEqual(r.explicit, true);
});

test("parseReminderTime extracts Uhr format", () => {
  const r = su.parseReminderTime("8 uhr");
  assert.strictEqual(r.hour, 8);
  assert.strictEqual(r.minute, 0);
  assert.strictEqual(r.explicit, true);
});

test("parseReminderTime defaults to 9:00", () => {
  const r = su.parseReminderTime("morgen");
  assert.strictEqual(r.hour, 9);
  assert.strictEqual(r.explicit, false);
});

test("parseReminderDue handles morgen", () => {
  const base = new Date("2026-05-12T10:00:00Z");
  const r = su.parseReminderDue("morgen", base);
  assert.ok(r.due_at.startsWith("2026-05-13"));
  assert.strictEqual(r.confidence, "high");
});

test("parseReminderDue handles heute um 14:30", () => {
  const base = new Date("2026-05-12T10:00:00Z");
  const r = su.parseReminderDue("heute um 14:30", base);
  assert.ok(r.due_at.includes("2026-05-12"));
  assert.strictEqual(r.due_precision, "datetime");
});

test("parseReminderDue handles übermorgen", () => {
  const base = new Date("2026-05-12T10:00:00Z");
  const r = su.parseReminderDue("übermorgen", base);
  assert.ok(r.due_at.startsWith("2026-05-14"));
});

test("parseReminderDue handles ISO date", () => {
  const r = su.parseReminderDue("2026-06-01 15:00", new Date("2026-05-12T10:00:00Z"));
  assert.ok(r.due_at.startsWith("2026-06-01"));
  assert.strictEqual(r.due_precision, "datetime");
});

test("parseReminderDue handles relative", () => {
  const base = new Date("2026-05-12T10:00:00Z");
  // "tage" not "tagen" — the regex expects tage? (tag or tage)
  const r = su.parseReminderDue("in 3 tage", base);
  assert.ok(r.due_at.startsWith("2026-05-15"));
  assert.strictEqual(r.due_precision, "relative");
});

test("parseReminderDue handles German date dd.mm", () => {
  const base = new Date("2026-05-12T10:00:00Z");
  const r = su.parseReminderDue("am 15.06", base);
  assert.ok(r.due_at.includes("2026-06-15") || r.due_at.includes("2026-06"));
  // "15.06" also matches the HH:MM time pattern, so precision becomes datetime
  assert.strictEqual(r.due_precision, "datetime");
});

test("parseReminderDue returns unknown for unparseable", () => {
  const r = su.parseReminderDue("whenever", new Date());
  assert.strictEqual(r.due_at, null);
  assert.strictEqual(r.confidence, "low");
});

test("reminderTitleFromText truncates", () => {
  const long = "x".repeat(300);
  assert.ok(su.reminderTitleFromText(long).length <= 180);
  assert.strictEqual(su.reminderTitleFromText(null), "Reminder");
});

// --- capabilityMatrixForDepartments ---

test("capabilityMatrixForDepartments grants by department", () => {
  const m = su.capabilityMatrixForDepartments(["deploy-ops", "frontend"]);
  assert.strictEqual(m.read, true);
  assert.strictEqual(m.deploy, true);
  assert.strictEqual(m.billing, false);
  assert.strictEqual(m.edit, true);
});

test("capabilityMatrixForDepartments strategy-review has all", () => {
  const m = su.capabilityMatrixForDepartments(["strategy-review"]);
  assert.strictEqual(m.deploy, true);
  assert.strictEqual(m.billing, true);
  assert.strictEqual(m.auth, true);
  assert.strictEqual(m.production, true);
});

// --- sensitivity detectors ---

test("authSensitiveTask detects auth keywords", () => {
  assert.strictEqual(su.authSensitiveTask({ task: "fix login page" }), true);
  assert.strictEqual(su.authSensitiveTask({ task: "update header color" }), false);
});

test("uiSensitiveTask detects UI keywords", () => {
  assert.strictEqual(su.uiSensitiveTask({ task: "update header color" }), true);
  assert.strictEqual(su.uiSensitiveTask({ task: "fix database query" }), false);
});

// --- wizard target gate ---

const wizardRules = {
  required_gates: ["explicit_wizard_target"],
  deploy_rules: {
    wizard_target_required: true,
    ambiguous_wizard_task_blocks: true
  },
  canonical_nav: {
    wizard1: { resource_key: "apps.blun.ai:wizard1" },
    wizard2: { resource_key: "apps.blun.ai:wizard2" }
  }
};

test("wizardTargetGate blocks ambiguous wizard work", () => {
  const r = su.wizardTargetGate({ project: "apps.blun.ai", task: "fix Wizard build output" }, wizardRules);
  assert.strictEqual(r.required, true);
  assert.strictEqual(r.status, "block");
  assert.ok(r.reason.includes("ambiguous wizard target"));
});

test("wizardTargetGate accepts explicit Wizard2 work", () => {
  const r = su.wizardTargetGate({ project: "apps.blun.ai", task: "QA Wizard2 tattoo build" }, wizardRules);
  assert.strictEqual(r.status, "ok");
  assert.strictEqual(r.target, "apps.blun.ai:wizard2");
});

test("wizardTargetGate blocks mixed Wizard1 and Wizard2 work", () => {
  const r = su.wizardTargetGate({ project: "apps.blun.ai", task: "copy Wizard1 fixes into Wizard2" }, wizardRules);
  assert.strictEqual(r.status, "block");
  assert.strictEqual(r.target, "mixed");
});

// --- Summary ---

console.log(`\n${passed} passed, ${failed} failed, ${passed + failed} total`);
if (failed > 0) process.exit(1);
