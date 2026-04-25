/**
 * Smart Memory - SillyTavern Extension
 * Copyright (C) 2026 Senjin the Dragon
 * https://github.com/senjinthedragon/Smart-Memory
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * Regression harness for Smart Memory extraction quality.
 *
 * Two test levels:
 *
 *   1. Parser unit tests - pure, no Ollama required. Tests parsers.js directly
 *      with known inputs and verifies that the parsed output matches expected
 *      structure. These run first and fail fast.
 *
 *   2. Extraction quality tests - builds real prompts, calls Ollama (or replays
 *      a recorded golden response), parses the output, and checks assertions.
 *      Golden files in tests/golden/ make these deterministic by default.
 *
 * Usage:
 *   node test-harness.mjs             Run all tests using golden files
 *   node test-harness.mjs --live      Call real Ollama and update golden files
 *   node test-harness.mjs --parsers   Run parser unit tests only
 *   node test-harness.mjs --quiet     Suppress per-assertion output
 *
 * Configuration (environment variables):
 *   OLLAMA_URL    Ollama base URL (default: http://localhost:11434)
 *   OLLAMA_MODEL  Model name (default: huihui_ai/qwen3-vl-abliterated:8b-instruct)
 *   RESPONSE_LEN  Max tokens per extraction call (default: 600)
 *   OLLAMA_THINK  Set to "false" to disable thinking on models that support it (e.g. gemma4)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---- Configuration -------------------------------------------------------

const OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://localhost:11434';
const OLLAMA_MODEL =
  process.env.OLLAMA_MODEL ?? 'huihui_ai/qwen3-vl-abliterated:8b-instruct';
const RESPONSE_LEN = parseInt(process.env.RESPONSE_LEN ?? '600', 10);
// Pass think:false to disable chain-of-thought on thinking models (e.g. gemma4).
// Only sent when explicitly set - omitting the field lets the model use its default.
const OLLAMA_THINK =
  process.env.OLLAMA_THINK === 'false' ? false : process.env.OLLAMA_THINK === 'true' ? true : undefined;

const LIVE = process.argv.includes('--live');
const PARSERS_ONLY = process.argv.includes('--parsers');
const QUIET = process.argv.includes('--quiet');

// ---- Imports from Smart Memory (no ST runtime deps) ----------------------

// parsers.js imports only from constants.js, which imports nothing external.
// Both are safe to import directly.
const { parseExtractionOutput, parseSessionOutput, parseArcOutput } = await import(
  './parsers.js'
);
const { buildExtractionPrompt, buildSessionExtractionPrompt, buildArcExtractionPrompt } =
  await import('./prompts.js');

// ---- Test runner state ---------------------------------------------------

let passed = 0;
let failed = 0;
let total = 0;

// ---- Colour helpers (no deps) --------------------------------------------

const c = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};

// ---- Assertion engine ----------------------------------------------------

/**
 * Returns true if `text` contains ANY of the keywords (case-insensitive).
 * Each entry in the keywords array is an OR option - the assertion passes if
 * at least one entry matches. Within a single entry, space-separated words
 * are treated as a phrase where ALL words must appear (but not necessarily
 * adjacent). This lets assertions be flexible across model paraphrasing.
 *
 * Example: keywords: ["burn scar", "scar forearm"] passes if the text
 * contains either "burn" AND "scar", OR "scar" AND "forearm".
 *
 * @param {string} text
 * @param {string[]} keywords
 */
function matchesKeywords(text, keywords) {
  const lower = text.toLowerCase();
  return keywords.some((kw) => {
    // Within one entry, all space-separated words must appear.
    return kw
      .toLowerCase()
      .split(/\s+/)
      .every((word) => lower.includes(word));
  });
}

/**
 * Checks one assertion object against a flat array of content strings.
 * @param {{ label?: string, keywords?: string[] }} assertion
 * @param {string[]} contents - Extracted memory content strings.
 * @returns {{ pass: boolean, label: string }}
 */
function checkAssertion(assertion, contents) {
  const label = assertion.label ?? assertion.keywords?.join(', ') ?? '(unlabeled)';
  if (!assertion.keywords || assertion.keywords.length === 0) {
    return { pass: true, label };
  }
  const combined = contents.join('\n');
  return { pass: matchesKeywords(combined, assertion.keywords), label };
}

/**
 * Runs a set of assertions against extracted memories for one tier.
 * @param {string} tierName
 * @param {Object} spec - Assertion spec from the assertions JSON file.
 * @param {Array<{ content: string }>} memories - Parsed memory objects.
 * @returns {{ tierPassed: number, tierTotal: number }}
 */
function runTierAssertions(tierName, spec, memories) {
  const contents = memories.map((m) => m.content ?? m.text ?? '');
  let tierPassed = 0;
  let tierTotal = 0;

  // min_count check
  if (spec.min_count !== undefined) {
    tierTotal++;
    const pass = memories.length >= spec.min_count;
    if (pass) tierPassed++;
    if (!QUIET || !pass) {
      const icon = pass ? c.green('PASS') : c.red('FAIL');
      console.log(
        `  [${tierName}] ${icon} min_count >= ${spec.min_count} (got ${memories.length})`,
      );
    }
  }

  // must_contain checks
  for (const assertion of spec.must_contain ?? []) {
    tierTotal++;
    const { pass, label } = checkAssertion(assertion, contents);
    if (pass) tierPassed++;
    if (!QUIET || !pass) {
      const icon = pass ? c.green('PASS') : c.red('FAIL');
      console.log(`  [${tierName}] ${icon} ${label}`);
    }
  }

  // must_not_contain checks
  for (const assertion of spec.must_not_contain ?? []) {
    tierTotal++;
    const combined = contents.join('\n');
    const triggered = assertion.keywords
      ? matchesKeywords(combined, assertion.keywords)
      : false;
    const pass = !triggered;
    if (pass) tierPassed++;
    if (!QUIET || !pass) {
      const icon = pass ? c.green('PASS') : c.red('FAIL');
      console.log(`  [${tierName}] ${icon} must NOT contain: ${assertion.label ?? assertion.keywords?.join(', ')}`);
    }
  }

  return { tierPassed, tierTotal };
}

// ---- Ollama call ---------------------------------------------------------

/**
 * Calls Ollama directly (no ST runtime required).
 * @param {string} prompt
 * @returns {Promise<string>}
 */
async function callOllama(prompt) {
  const response = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      messages: [{ role: 'user', content: prompt }],
      stream: false,
      options: {
        num_predict: RESPONSE_LEN,
        stop: ['<|eot_id|>', '<|im_end|>'],
        ...(OLLAMA_THINK !== undefined ? { think: OLLAMA_THINK } : {}),
      },
    }),
  });
  if (!response.ok) throw new Error(`Ollama responded with ${response.status}`);
  const data = await response.json();
  return data.message?.content ?? '';
}

// ---- Golden file helpers -------------------------------------------------

function goldenPath(fixtureName, tier) {
  return join(__dirname, 'tests', 'golden', `${fixtureName}-${tier}.txt`);
}

function loadGolden(fixtureName, tier) {
  const path = goldenPath(fixtureName, tier);
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf8');
}

function saveGolden(fixtureName, tier, text) {
  const dir = join(__dirname, 'tests', 'golden');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(goldenPath(fixtureName, tier), text, 'utf8');
  console.log(c.dim(`  [golden] saved ${fixtureName}-${tier}.txt`));
}

/**
 * Returns the raw model response for a given fixture + tier, either from the
 * golden file (default) or by calling Ollama live (--live flag).
 * In live mode the response is also saved as the new golden file.
 * @param {string} fixtureName
 * @param {string} tier - 'longterm' | 'session' | 'arcs'
 * @param {string} prompt
 * @returns {Promise<string>}
 */
async function getResponse(fixtureName, tier, prompt) {
  if (!LIVE) {
    const golden = loadGolden(fixtureName, tier);
    if (golden !== null) return golden;
    console.log(
      c.yellow(
        `  [golden] No golden file for ${fixtureName}-${tier}. Run with --live to record one.`,
      ),
    );
    return '';
  }

  console.log(c.dim(`  [live] Calling Ollama for ${fixtureName}-${tier}...`));
  const response = await callOllama(prompt);
  saveGolden(fixtureName, tier, response);
  return response;
}

// ---- Chat text formatter -------------------------------------------------

function chatToText(messages) {
  return messages.map((m) => `${m.name}: ${m.mes}`).join('\n\n');
}

// ---- Extraction quality tests -------------------------------------------

async function runExtractionTest(fixtureName) {
  const fixturePath = join(__dirname, 'tests', 'fixtures', `${fixtureName}.json`);
  const assertionsPath = join(__dirname, 'tests', 'assertions', `${fixtureName}.json`);

  if (!existsSync(fixturePath)) {
    console.log(c.red(`  Missing fixture: ${fixturePath}`));
    return;
  }
  if (!existsSync(assertionsPath)) {
    console.log(c.red(`  Missing assertions: ${assertionsPath}`));
    return;
  }

  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const assertions = JSON.parse(readFileSync(assertionsPath, 'utf8'));
  const chatText = chatToText(fixture.messages);
  const priorLongterm = (fixture.prior_longterm ?? []).join('\n');
  const priorSession = '';
  const priorArcs = '';

  let fixturePassed = 0;
  let fixtureTotal = 0;

  // Long-term extraction
  if (assertions.longterm) {
    const prompt = buildExtractionPrompt(chatText, priorLongterm);
    const raw = await getResponse(fixtureName, 'longterm', prompt);
    const memories = raw ? parseExtractionOutput(raw) : [];
    if (!QUIET) console.log(c.dim(`  [longterm] raw: ${raw.slice(0, 120).replace(/\n/g, ' ')}...`));
    if (!QUIET) console.log(c.dim(`  [longterm] parsed: ${memories.length} memories`));
    const { tierPassed, tierTotal } = runTierAssertions('longterm', assertions.longterm, memories);
    fixturePassed += tierPassed;
    fixtureTotal += tierTotal;
  }

  // Session extraction
  if (assertions.session) {
    const prompt = buildSessionExtractionPrompt(chatText, priorSession, priorLongterm);
    const raw = await getResponse(fixtureName, 'session', prompt);
    const memories = raw ? parseSessionOutput(raw) : [];
    if (!QUIET) console.log(c.dim(`  [session] parsed: ${memories.length} memories`));
    const { tierPassed, tierTotal } = runTierAssertions('session', assertions.session, memories);
    fixturePassed += tierPassed;
    fixtureTotal += tierTotal;
  }

  // Arc extraction
  if (assertions.arcs) {
    const prompt = buildArcExtractionPrompt(chatText, priorArcs);
    const raw = await getResponse(fixtureName, 'arcs', prompt);
    const arcs = raw ? parseArcOutput(raw, []).add : [];
    if (!QUIET) console.log(c.dim(`  [arcs] parsed: ${arcs.length} arcs`));
    const { tierPassed, tierTotal } = runTierAssertions('arcs', assertions.arcs, arcs);
    fixturePassed += tierPassed;
    fixtureTotal += tierTotal;
  }

  passed += fixturePassed;
  failed += fixtureTotal - fixturePassed;
  total += fixtureTotal;

  const pct = fixtureTotal > 0 ? Math.round((fixturePassed / fixtureTotal) * 100) : 100;
  const scoreColor = pct === 100 ? c.green : pct >= 70 ? c.yellow : c.red;
  console.log(
    c.bold(`  Score: ${scoreColor(`${fixturePassed}/${fixtureTotal}`)} (${scoreColor(`${pct}%`)})`),
  );
}

// ---- Parser unit tests ---------------------------------------------------

function assert(condition, label) {
  total++;
  if (condition) {
    passed++;
    if (!QUIET) console.log(`  ${c.green('PASS')} ${label}`);
  } else {
    failed++;
    console.log(`  ${c.red('FAIL')} ${label}`);
  }
}

function runParserTests() {
  console.log(c.bold('\nParser unit tests'));
  console.log(c.dim('─'.repeat(60)));

  // ---- parseExtractionOutput

  const basic = parseExtractionOutput('[fact:2:permanent] Elara has a scar on her forearm.');
  assert(basic.length === 1, 'parses single fact line');
  assert(basic[0].type === 'fact', 'type is fact');
  assert(basic[0].importance === 2, 'importance is 2');
  assert(basic[0].expiration === 'permanent', 'expiration is permanent');
  assert(basic[0].content.includes('scar'), 'content contains scar');

  const multi = parseExtractionOutput(
    '[fact:3:permanent] Elara grew up in Port Varen.\n[relationship:1:session] She distrusts the merchant.',
  );
  assert(multi.length === 2, 'parses multiple lines');
  assert(multi[0].type === 'fact', 'first is fact');
  assert(multi[1].type === 'relationship', 'second is relationship');

  const none = parseExtractionOutput('NONE');
  assert(none.length === 0, 'NONE returns empty array');

  const empty = parseExtractionOutput('');
  assert(empty.length === 0, 'empty string returns empty array');

  const minimalFormat = parseExtractionOutput('[fact] She is a blacksmith.');
  assert(minimalFormat.length === 1, 'parses fact with no modifiers');
  assert(minimalFormat[0].importance === 2, 'defaults importance to 2');

  const withEntity = parseExtractionOutput('[fact:2:permanent:entity=Elara/character] Elara is tall.');
  assert(withEntity.length === 1, 'parses entity modifier');
  // entities[] holds UUIDs resolved later by graph-migration; raw names are in _raw_entity_names
  // Format is "Name/type" so check with startsWith rather than exact match.
  assert(
    withEntity[0]._raw_entity_names?.some((n) => n.startsWith('Elara')),
    'entity Elara in _raw_entity_names',
  );

  const garbage = parseExtractionOutput('This is just free text with no tags.');
  assert(garbage.length === 0, 'ignores lines without tags');

  const tooShort = parseExtractionOutput('[fact] Hi.');
  assert(tooShort.length === 0, 'ignores content that is too short');

  // ---- parseSessionOutput

  const session = parseSessionOutput('[detail:2:session] The meeting took place at the docks.');
  assert(session.length === 1, 'parses session detail');
  assert(session[0].type === 'detail', 'type is detail');

  // ---- parseArcOutput

  const arcResult = parseArcOutput(
    '[arc] She promised to write once she arrived in Port Varen.',
    [],
  );
  assert(Array.isArray(arcResult.add), 'parseArcOutput returns { add, resolve }');
  assert(arcResult.add.length === 1, 'one arc added');
  assert(arcResult.add[0].content.includes('promised'), 'arc content correct');
  assert(arcResult.resolve.length === 0, 'no resolved arcs');

  const arcResolve = parseArcOutput(
    '[resolved] She promised to write.',
    [{ content: 'She promised to write.' }],
  );
  assert(arcResolve.resolve.length === 1, 'resolved arc detected');
  assert(arcResolve.add.length === 0, 'no new arcs when resolving');

  const arcNone = parseArcOutput('NONE', []);
  assert(arcNone.add.length === 0, 'NONE produces no arcs');
}

// ---- Main ----------------------------------------------------------------

console.log(c.bold('\nSmart Memory Regression Harness'));
console.log(c.dim(`Mode: ${LIVE ? 'live (Ollama)' : 'replay (golden files)'}`));
console.log(c.dim(`Model: ${OLLAMA_MODEL}`));
if (OLLAMA_THINK !== undefined) console.log(c.dim(`Think: ${OLLAMA_THINK}`));
console.log(c.dim(`Response length: ${RESPONSE_LEN} tokens`));
console.log(c.dim('─'.repeat(60)));

runParserTests();

if (!PARSERS_ONLY) {
  const fixtures = ['elara-intro', 'elara-supersession', 'whisperwood-long'];

  for (const name of fixtures) {
    console.log(c.bold(`\nExtraction test: ${name}`));
    console.log(c.dim('─'.repeat(60)));
    await runExtractionTest(name);
  }
}

// ---- Summary -------------------------------------------------------------

console.log(c.bold('\n' + '─'.repeat(60)));
const pct = total > 0 ? Math.round((passed / total) * 100) : 100;
const summaryColor = pct === 100 ? c.green : pct >= 70 ? c.yellow : c.red;
console.log(
  c.bold(
    `Total: ${summaryColor(`${passed}/${total} passed`)} (${summaryColor(`${pct}%`)})`,
  ),
);

if (failed > 0) {
  console.log(c.red(`${failed} assertion(s) failed.`));
  process.exit(1);
} else {
  console.log(c.green('All assertions passed.'));
}
