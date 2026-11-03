import test from 'node:test';
import assert from 'node:assert/strict';

import { buildContinuityPrompt } from '../prompts.js';
import {
  buildRecentTranscript,
  hashText,
  validateIssue,
  buildForwardRepairNote,
  parseContinuityJson,
  isPendingRepairAnchorValid,
  CONTINUITY_CATEGORIES,
  buildDurableRetconNote,
  advanceRetconLifetimes,
  invalidateAcceptedRetcons,
  RETCON_TURNS,
} from '../continuity-utils.js';
import { reconcileEntityRegistry } from '../entity-registry.js';
import { replaceTemplate } from '../template-utils.js';

// =========================================================================
// buildContinuityPrompt
// =========================================================================

test('buildContinuityPrompt: includes all three evidence blocks in order', () => {
  const prompt = buildContinuityPrompt(
    '-- CHARACTER CARD --\nElara is an elf.',
    '[USER] I hand her the key.\n\n[Elara] She takes the key.',
    'Elara draws her sword.',
  );

  assert.match(prompt, /RECENT TRANSCRIPT/);
  assert.match(prompt, /BASELINE NOTES/);
  assert.match(prompt, /LATEST STORY RESPONSE/);
  assert.ok(prompt.includes('Elara is an elf.'));
  assert.ok(prompt.includes('[USER] I hand her the key.'));
  assert.ok(prompt.includes('Elara draws her sword.'));

  // Transcript must be presented before the baseline notes, which are before
  // the latest response - the model reads ground truth first.
  assert.ok(prompt.indexOf('RECENT TRANSCRIPT') < prompt.indexOf('BASELINE NOTES'));
  assert.ok(prompt.indexOf('BASELINE NOTES') < prompt.indexOf('LATEST STORY RESPONSE'));
});

test('buildContinuityPrompt: states transcript is ground truth and notes lag', () => {
  const prompt = buildContinuityPrompt('facts', 'transcript', 'latest');

  assert.match(prompt, /ground truth/i);
  assert.match(prompt, /often lagging or outdated/i);
  assert.match(prompt, /assume the story PROGRESSED/i);
});

test('buildContinuityPrompt: forbids flagging ordinary progression', () => {
  const prompt = buildContinuityPrompt('facts', 'transcript', 'latest');

  assert.match(prompt, /NEVER flag/i);
  assert.match(prompt, /location changes/i);
  assert.match(prompt, /items gained\/lost\/used/i);
  assert.match(prompt, /injuries/i);
  assert.match(prompt, /emotions/i);
  assert.match(prompt, /plans/i);
  assert.match(prompt, /relationship shifts/i);
  assert.match(prompt, /newly learned information/i);
  assert.match(prompt, /time passing/i);
});

test('buildContinuityPrompt: restricts to permanent categories', () => {
  const prompt = buildContinuityPrompt('facts', 'transcript', 'latest');

  assert.match(prompt, /ONLY flag permanent properties/i);
  for (const category of CONTINUITY_CATEGORIES) {
    assert.ok(prompt.includes(category), `prompt should mention category ${category}`);
  }
});

test('buildContinuityPrompt: requires strict JSON output', () => {
  const prompt = buildContinuityPrompt('facts', 'transcript', 'latest');

  assert.match(prompt, /Output strict JSON/i);
  assert.ok(prompt.includes('{"contradictions":[]}'));
  assert.ok(prompt.includes('{"contradictions":[{"fact"'));
  assert.match(prompt, /response_quote/);
  assert.match(prompt, /why_not_progression/);
  assert.match(prompt, /copied verbatim from the BASELINE NOTES/i);
  assert.match(prompt, /copied verbatim from the LATEST STORY RESPONSE/i);
});

test('buildContinuityPrompt: handles an empty transcript gracefully', () => {
  const prompt = buildContinuityPrompt('facts', '', 'latest');
  assert.match(prompt, /no recent transcript available/i);
});

// =========================================================================
// buildRecentTranscript
// =========================================================================

test('buildRecentTranscript: labels user and character turns', () => {
  const chat = [
    { is_user: true, mes: 'Hello there.' },
    { name: 'Elara', mes: 'Welcome, traveller.' },
  ];

  const transcript = buildRecentTranscript(chat, chat.length, 6);
  assert.ok(transcript.includes('[USER] Hello there.'));
  assert.ok(transcript.includes('[Elara] Welcome, traveller.'));
});

test('buildRecentTranscript: excludes system turns and empty messages', () => {
  const chat = [
    { is_system: true, mes: 'system instructions' },
    { is_user: true, mes: 'A real line.' },
    { name: 'Elara', mes: '' },
  ];

  const transcript = buildRecentTranscript(chat, chat.length, 6);
  assert.ok(!transcript.includes('system instructions'));
  assert.ok(transcript.includes('[USER] A real line.'));
  assert.equal(transcript.includes('[]'), false);
});

test('buildRecentTranscript: respects endIdx and windowSize', () => {
  const chat = [
    { is_user: true, mes: 'one' },
    { name: 'Elara', mes: 'two' },
    { is_user: true, mes: 'three' },
    { name: 'Elara', mes: 'four' },
  ];

  // Anchor is index 3 - only the two preceding turns should be collected.
  const transcript = buildRecentTranscript(chat, 3, 2);
  assert.ok(!transcript.includes('one'));
  assert.ok(transcript.includes('two'));
  assert.ok(transcript.includes('three'));
  assert.ok(!transcript.includes('four'));
});

test('buildRecentTranscript: returns empty string for empty input', () => {
  assert.equal(buildRecentTranscript([], 0), '');
  assert.equal(buildRecentTranscript(null, 0), '');
});

// =========================================================================
// hashText
// =========================================================================

test('hashText: is deterministic and distinguishes different text', () => {
  assert.equal(hashText('event Z happened'), hashText('event Z happened'));
  assert.notEqual(hashText('event Z happened'), hashText('event Z was rewritten'));
  assert.equal(hashText(''), hashText(''));
  assert.equal(hashText(null), hashText(''));
  assert.equal(typeof hashText('abc'), 'string');
  assert.ok(hashText('abc').length > 0);
});

// =========================================================================
// validateIssue
// =========================================================================

const FACTS = [
  '-- CHARACTER CARD --',
  'Elara is a high elf.',
  '-- LONG-TERM MEMORIES --',
  '[fact] Elara has silver eyes.',
].join('\n');

const LATEST = 'Elara laughed, her silver eyes bright. "I am a high elf, as you know," she said.';

test('validateIssue: accepts a fully evidenced permanent issue', () => {
  const issue = {
    fact: 'Elara is a high elf.',
    response_quote: 'I am a high elf',
    category: 'permanent_trait',
    why_not_progression: 'Species is permanent and the transcript never changes it.',
  };
  assert.equal(validateIssue(issue, LATEST, FACTS), true);
});

test('validateIssue: accepts every allowed category', () => {
  for (const category of CONTINUITY_CATEGORIES) {
    const issue = {
      fact: 'Elara has silver eyes.',
      response_quote: 'her silver eyes bright',
      category,
      why_not_progression: 'This is a fixed property nothing in the scene changed.',
    };
    assert.equal(validateIssue(issue, LATEST, FACTS), true, category);
  }
});

test('validateIssue: rejects an unknown category', () => {
  const issue = {
    fact: 'Elara is a high elf.',
    response_quote: 'I am a high elf',
    category: 'item_state',
    why_not_progression: 'The item was lost earlier in the story.',
  };
  assert.equal(validateIssue(issue, LATEST, FACTS), false);
});

test('validateIssue: rejects a missing category', () => {
  const issue = {
    fact: 'Elara is a high elf.',
    response_quote: 'I am a high elf',
    why_not_progression: 'Species is permanent.',
  };
  assert.equal(validateIssue(issue, LATEST, FACTS), false);
});

test('validateIssue: rejects a missing or too-short why_not_progression', () => {
  const base = {
    fact: 'Elara is a high elf.',
    response_quote: 'I am a high elf',
    category: 'permanent_trait',
  };
  assert.equal(validateIssue({ ...base }, LATEST, FACTS), false);
  assert.equal(validateIssue({ ...base, why_not_progression: 'wrong' }, LATEST, FACTS), false);
});

test('validateIssue: rejects a placeholder why_not_progression', () => {
  const issue = {
    fact: 'Elara is a high elf.',
    response_quote: 'I am a high elf',
    category: 'permanent_trait',
    why_not_progression: 'n/a',
  };
  assert.equal(validateIssue(issue, LATEST, FACTS), false);
});

test('validateIssue: rejects a quote that is not in the latest response', () => {
  const issue = {
    fact: 'Elara is a high elf.',
    response_quote: 'I am a dwarf',
    category: 'permanent_trait',
    why_not_progression: 'Species is permanent and cannot change here.',
  };
  assert.equal(validateIssue(issue, LATEST, FACTS), false);
});

test('validateIssue: rejects a fact that is not in the baseline notes', () => {
  const issue = {
    fact: 'Elara is a dwarf.',
    response_quote: 'I am a high elf',
    category: 'permanent_trait',
    why_not_progression: 'Species is permanent and cannot change here.',
  };
  assert.equal(validateIssue(issue, LATEST, FACTS), false);
});

test('validateIssue: quote matching is normalized (case/whitespace)', () => {
  const issue = {
    fact: '  elara   IS a high elf. ',
    response_quote: 'i am a   HIGH ELF',
    category: 'permanent_trait',
    why_not_progression: 'Species is permanent and cannot change here.',
  };
  assert.equal(validateIssue(issue, LATEST, FACTS), true);
});

test('validateIssue: rejects null/non-object issues', () => {
  assert.equal(validateIssue(null, LATEST, FACTS), false);
  assert.equal(validateIssue(undefined, LATEST, FACTS), false);
  assert.equal(validateIssue('a string', LATEST, FACTS), false);
});

// =========================================================================
// Progression vs. contradiction
// =========================================================================

test('progression: inventory/location state changes are not permanent contradictions', () => {
  // The memory says the key was lost; the transcript shows it was later
  // recovered. That is progression, not a contradiction. Only permanent
  // categories survive validation, so an inventory-style issue is rejected.
  const facts = '-- SESSION DETAILS --\n[detail] The silver key was lost in the river.';
  const latest = 'She drew the silver key from her pocket and unlocked the door.';
  const issue = {
    fact: 'The silver key was lost in the river.',
    response_quote: 'drew the silver key from her pocket',
    category: 'item_state',
    why_not_progression: 'The key was lost earlier and should still be gone.',
  };

  assert.equal(validateIssue(issue, latest, facts), false);
});

test('progression: prompt tells the model to assume progression on a mismatch', () => {
  const prompt = buildContinuityPrompt(
    'The key was lost in the river.',
    'She found the key.',
    'She used the key.',
  );
  assert.match(prompt, /assume the story PROGRESSED/i);
});

// =========================================================================
// buildForwardRepairNote
// =========================================================================

test('buildForwardRepairNote: is forward-only and never commands a retraction', () => {
  const note = buildForwardRepairNote(
    [
      {
        fact: 'Elara is a high elf.',
        response_quote: 'I am a high elf',
        category: 'permanent_trait',
        why_not_progression: 'Species is permanent.',
      },
    ],
    'Elara',
  );

  assert.match(note, /Continuity note, background only/);
  assert.match(note, /earlier in the story it was established that/);
  assert.ok(note.includes('Elara is a high elf.'));
  assert.match(note, /Everything already written in this conversation has happened and stands/);
  assert.match(note, /Do NOT retract, undo, or re-narrate any past event/);
  assert.match(note, /If the conversation has legitimately changed them, ignore this note/);

  // Must never instruct the model to revoke or rewind the story.
  assert.doesNotMatch(note, /\brevoke\b/i);
  assert.doesNotMatch(note, /\bpretend\b/i);
  assert.doesNotMatch(note, /\bcancel the previous\b/i);
  assert.doesNotMatch(note, /\bremove the previous\b/i);
});

test('buildForwardRepairNote: joins multiple facts', () => {
  const note = buildForwardRepairNote(
    [{ fact: 'Elara is a high elf.' }, { fact: 'Elara has silver eyes.' }],
    'Elara',
  );
  assert.ok(note.includes('Elara is a high elf.'));
  assert.ok(note.includes('Elara has silver eyes.'));
});

test('buildForwardRepairNote: accepts plain string facts', () => {
  const note = buildForwardRepairNote(['Elara is a high elf.'], 'Elara');
  assert.ok(note.includes('Elara is a high elf.'));
});

test('buildForwardRepairNote: returns empty string when there are no facts', () => {
  assert.equal(buildForwardRepairNote([], 'Elara'), '');
  assert.equal(buildForwardRepairNote(null, 'Elara'), '');
});

// =========================================================================
// parseContinuityJson
// =========================================================================

test('parseContinuityJson: parses a plain JSON object', () => {
  const parsed = parseContinuityJson(
    '{"contradictions":[{"fact":"a fact","response_quote":"a quote","category":"death","why_not_progression":"permanent death"}]}',
  );
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].fact, 'a fact');
});

test('parseContinuityJson: parses a fenced JSON block', () => {
  const parsed = parseContinuityJson(
    '```json\n{"contradictions":[{"fact":"a fact","response_quote":"a quote","category":"world_rule","why_not_progression":"hard rule"}]}\n```',
  );
  assert.equal(parsed.length, 1);
});

test('parseContinuityJson: tolerates surrounding prose', () => {
  const parsed = parseContinuityJson(
    'Here is my answer:\n{"contradictions":[{"fact":"x","response_quote":"y","category":"backstory","why_not_progression":"fixed history"}]}\nThanks!',
  );
  assert.equal(parsed.length, 1);
});

test('parseContinuityJson: returns [] for the clean sentinel', () => {
  assert.deepEqual(parseContinuityJson('{"contradictions":[]}'), []);
});

test('parseContinuityJson: returns [] for malformed or empty input', () => {
  assert.deepEqual(parseContinuityJson('not json at all'), []);
  assert.deepEqual(parseContinuityJson('{"contradictions": "wrong"}'), []);
  assert.deepEqual(parseContinuityJson(''), []);
  assert.deepEqual(parseContinuityJson(null), []);
});

// =========================================================================
// Anchored repair invalidation (used by applyPendingRepair)
// =========================================================================

test('anchored repair: valid while the anchor message is unchanged', () => {
  const chat = [
    { is_user: true, mes: 'I open the door.' },
    { name: 'Elara', mes: 'The room beyond is empty.' },
  ];
  const pendingRepair = {
    note: 'forward note',
    anchorIdx: 1,
    anchorHash: hashText(chat[1].mes),
  };
  assert.equal(isPendingRepairAnchorValid(chat, pendingRepair), true);
});

test('anchored repair: invalidated when the anchor message is swiped', () => {
  const chat = [
    { is_user: true, mes: 'I open the door.' },
    { name: 'Elara', mes: 'The room beyond is empty.' },
  ];
  const pendingRepair = {
    note: 'forward note',
    anchorIdx: 1,
    anchorHash: hashText(chat[1].mes),
  };

  // A swipe replaces the message text in place without changing the index.
  chat[1].mes = 'The room beyond holds a sleeping dragon.';
  assert.equal(isPendingRepairAnchorValid(chat, pendingRepair), false);
});

test('anchored repair: invalidated when the anchor message is edited', () => {
  const chat = [{ name: 'Elara', mes: 'Original line.' }];
  const pendingRepair = { note: 'n', anchorIdx: 0, anchorHash: hashText(chat[0].mes) };

  chat[0].mes = 'Edited line.';
  assert.equal(isPendingRepairAnchorValid(chat, pendingRepair), false);
});

test('anchored repair: invalidated when the anchor message is deleted', () => {
  const chat = [
    { is_user: true, mes: 'I wait.' },
    { name: 'Elara', mes: 'Time passes.' },
  ];
  const pendingRepair = { note: 'n', anchorIdx: 1, anchorHash: hashText(chat[1].mes) };
  assert.equal(isPendingRepairAnchorValid(chat, pendingRepair), true);

  chat.pop();
  assert.equal(isPendingRepairAnchorValid(chat, pendingRepair), false);
});

test('anchored repair: invalidated for a missing/out-of-range anchor', () => {
  const chat = [{ name: 'Elara', mes: 'Line.' }];
  assert.equal(isPendingRepairAnchorValid(chat, null), false);
  assert.equal(isPendingRepairAnchorValid(chat, { anchorIdx: 5, anchorHash: 'abc' }), false);
  assert.equal(isPendingRepairAnchorValid(chat, { anchorIdx: -1, anchorHash: 'abc' }), false);
  assert.equal(isPendingRepairAnchorValid(null, { anchorIdx: 0, anchorHash: 'abc' }), false);
  assert.equal(
    isPendingRepairAnchorValid(chat, { anchorIdx: 0, anchorHash: hashText('different') }),
    false,
  );
});

// =========================================================================
// Safe template replacement
// =========================================================================

test('replaceTemplate: dollar sequences in dynamic text are inserted literally', () => {
  const text = 'owes a $100 bounty; pool is $1, $50, $& and $$';
  const result = replaceTemplate('Bounty: {{reward}}', '{{reward}}', text);
  assert.equal(result, `Bounty: ${text}`);
});

test('replaceTemplate: null/undefined values become empty text', () => {
  assert.equal(replaceTemplate('A{{x}}B', '{{x}}', null), 'AB');
  assert.equal(replaceTemplate('A{{x}}B', '{{x}}', undefined), 'AB');
});

// =========================================================================
// Entity registry reconciliation
// =========================================================================

test('reconcileEntityRegistry: empty memories clear links without wiping the registry', () => {
  const registry = [
    { id: 'e1', name: 'Elara', type: 'character', first_seen: 0, last_seen: 0, memory_ids: ['m1'] },
    { id: 'e2', name: 'Kael', type: 'character', first_seen: 3, last_seen: 5, memory_ids: ['m2'] },
    {
      id: 'e3',
      name: 'Silver Key',
      type: 'object',
      first_seen: 4,
      last_seen: 4,
      memory_ids: ['m3'],
    },
  ];

  reconcileEntityRegistry(registry, []);

  assert.equal(registry.length, 3, 'registry must not be wiped when memories are empty');
  for (const entity of registry) {
    assert.deepEqual(entity.memory_ids, [], `${entity.name} links should be cleared`);
  }
});

test('reconcileEntityRegistry: non-array memories leave links untouched but keep registry', () => {
  const registry = [
    { id: 'e1', name: 'Elara', type: 'character', first_seen: 0, last_seen: 0, memory_ids: ['m1'] },
  ];

  reconcileEntityRegistry(registry, null);

  assert.equal(registry.length, 1);
  assert.deepEqual(registry[0].memory_ids, []);
});

test('reconcileEntityRegistry: keeps seeded characters when pruning unlinked entities', () => {
  const registry = [
    { id: 'seed', name: 'Elara', type: 'character', first_seen: 0, last_seen: 0, memory_ids: [] },
    {
      id: 'ghost',
      name: 'Ghost',
      type: 'character',
      first_seen: 2,
      last_seen: 2,
      memory_ids: ['gone'],
    },
    {
      id: 'obj',
      name: 'Silver Key',
      type: 'object',
      first_seen: 1,
      last_seen: 1,
      memory_ids: ['m1'],
    },
  ];
  const memories = [{ id: 'm1', content: 'The Silver Key is cold to the touch.' }];

  reconcileEntityRegistry(registry, memories);

  const ids = registry.map((e) => e.id);
  assert.ok(ids.includes('seed'), 'seeded character must survive pruning');
  assert.ok(ids.includes('obj'), 'linked entity should remain');
  assert.equal(ids.includes('ghost'), false, 'unlinked non-seeded entity should be pruned');
  assert.deepEqual(registry.find((e) => e.id === 'obj').memory_ids, ['m1']);
});

test('reconcileEntityRegistry: honorific titles and substring matches never over-link (F2)', () => {
  // Seeded characters survive pruning even with no links, so the empty
  // memory_ids arrays below are directly observable.
  const registry = [
    {
      id: 'king',
      name: 'King Aldric',
      type: 'character',
      first_seen: 0,
      last_seen: 0,
      memory_ids: [],
    },
    { id: 'ann', name: 'Ann', type: 'character', first_seen: 0, last_seen: 0, memory_ids: [] },
    { id: 'eli', name: 'Eli', type: 'character', first_seen: 0, last_seen: 0, memory_ids: [] },
  ];
  const memories = [
    // "making" contains "king" as a substring but is not the title "King".
    { id: 'm1', content: 'Mira is making a potion for the village.' },
    // "Joanna" contains "ann" as a substring.
    { id: 'm2', content: 'Joanna planned the channel crossing.' },
    // "believes" contains "eli" as a substring.
    { id: 'm3', content: 'She believes the gate is open.' },
  ];

  reconcileEntityRegistry(registry, memories);

  assert.deepEqual(
    registry.find((e) => e.id === 'king').memory_ids,
    [],
    'King Aldric must not link via the "king" substring in "making"',
  );
  assert.deepEqual(
    registry.find((e) => e.id === 'ann').memory_ids,
    [],
    'Ann must not link via the "ann" substring in "Joanna"',
  );
  assert.deepEqual(
    registry.find((e) => e.id === 'eli').memory_ids,
    [],
    'Eli must not link via the "eli" substring in "believes"',
  );
  for (const mem of memories) {
    assert.deepEqual(mem.entities ?? [], [], `${mem.id} must not gain spurious entity links`);
  }
});

test('reconcileEntityRegistry: word-boundary matching still links genuine names and tokens (F2)', () => {
  const registry = [
    {
      id: 'elara',
      name: 'Elara Voss',
      type: 'character',
      first_seen: 1,
      last_seen: 1,
      memory_ids: [],
    },
    {
      id: 'key',
      name: 'Silver Key',
      type: 'object',
      first_seen: 1,
      last_seen: 1,
      memory_ids: [],
    },
  ];
  const memories = [
    { id: 'm1', content: 'Elara drew her sword.' },
    { id: 'm2', content: 'The Silver Key is cold to the touch.' },
  ];

  reconcileEntityRegistry(registry, memories);

  assert.deepEqual(registry.find((e) => e.id === 'elara').memory_ids, ['m1']);
  assert.deepEqual(registry.find((e) => e.id === 'key').memory_ids, ['m2']);
  assert.deepEqual(memories[0].entities, ['elara']);
  assert.deepEqual(memories[1].entities, ['key']);
});

test('reconcileEntityRegistry: a short name links on a word boundary but not as a substring (F2)', () => {
  const registry = [
    { id: 'eli', name: 'Eli', type: 'character', first_seen: 0, last_seen: 0, memory_ids: [] },
  ];
  const memories = [
    { id: 'm1', content: 'She believes the gate is open.' },
    { id: 'm2', content: 'Eli waved from the ridge.' },
  ];

  reconcileEntityRegistry(registry, memories);

  assert.deepEqual(registry.find((e) => e.id === 'eli').memory_ids, ['m2']);
});

// =========================================================================
// In-story transformations are progression, not contradictions
// =========================================================================

test('buildContinuityPrompt: rule 7 marks active in-story transformations as progression', () => {
  const prompt = buildContinuityPrompt('facts', 'transcript', 'latest');

  assert.match(prompt, /ACTIVE IN-STORY TRANSFORMATIONS ARE PROGRESSION/);
  assert.match(prompt, /a spell turned her eyes crimson/);
  assert.match(prompt, /she dyed her hair/);
  assert.match(prompt, /NEVER flag it as a contradiction/);
});

test('validateIssue: rejects a trait actively transformed in the latest response', () => {
  const facts = 'Elara has silver eyes.';
  const latest = 'A spell turned her eyes crimson, and she gasped at the change.';
  const issue = {
    fact: 'Elara has silver eyes.',
    response_quote: 'her eyes crimson',
    category: 'permanent_trait',
    why_not_progression: 'Eye colour is a fixed permanent trait that cannot change.',
  };

  assert.equal(validateIssue(issue, latest, facts), false);
});

test('validateIssue: rejects dyed hair as progression, not a contradiction', () => {
  const facts = 'Elara has silver hair.';
  const latest = 'She dyed her hair, and her hair was now black.';
  const issue = {
    fact: 'Elara has silver hair.',
    response_quote: 'her hair was now black',
    category: 'permanent_trait',
    why_not_progression: 'Hair colour is permanent and nothing changed it.',
  };

  assert.equal(validateIssue(issue, latest, facts), false);
});

test('validateIssue: rejects a severed limb described in-scene', () => {
  const facts = 'Kael has two legs.';
  const latest = 'The blade caught him and his leg was severed below the knee.';
  const issue = {
    fact: 'Kael has two legs.',
    response_quote: 'his leg was severed',
    category: 'permanent_trait',
    why_not_progression: 'Body composition is permanent and cannot change.',
  };

  assert.equal(validateIssue(issue, latest, facts), false);
});

test('validateIssue: rejects when the recent transcript already depicts the transition', () => {
  const facts = 'Elara has silver hair.';
  const latest = 'Elara tied back her black hair before the fight.';
  const transcript = '[Elara] Last night I dyed my hair black for the festival.';
  const issue = {
    fact: 'Elara has silver hair.',
    response_quote: 'her black hair',
    category: 'permanent_trait',
    why_not_progression: 'Hair colour is permanent and cannot change.',
  };

  assert.equal(validateIssue(issue, latest, facts, transcript), false);
});

test('validateIssue: still accepts an unmotivated permanent contradiction', () => {
  const facts = 'Elara is a high elf.';
  const latest = 'Elara revealed she is a dwarf and always has been.';
  const issue = {
    fact: 'Elara is a high elf.',
    response_quote: 'she is a dwarf',
    category: 'permanent_trait',
    why_not_progression: 'Species cannot change and no event in the scene altered it.',
  };

  assert.equal(validateIssue(issue, latest, facts), true);
});

// =========================================================================
// Repair anchor staleness (no later AI turn, at most one pending user turn)
// =========================================================================

test('anchored repair: valid with a single pending user turn after the anchor', () => {
  const chat = [
    { name: 'Elara', mes: 'The room is empty.' },
    { is_user: true, mes: 'I step inside.' },
  ];
  const pendingRepair = { note: 'n', anchorIdx: 0, anchorHash: hashText(chat[0].mes) };

  assert.equal(isPendingRepairAnchorValid(chat, pendingRepair), true);
});

test('anchored repair: invalidated once another AI turn is generated', () => {
  const chat = [
    { name: 'Elara', mes: 'The room is empty.' },
    { is_user: true, mes: 'I step inside.' },
    { name: 'Elara', mes: 'A wraith shrieks in the dark.' },
  ];
  const pendingRepair = { note: 'n', anchorIdx: 0, anchorHash: hashText(chat[0].mes) };

  assert.equal(isPendingRepairAnchorValid(chat, pendingRepair), false);
});

test('anchored repair: invalidated when more than one non-system message follows', () => {
  const chat = [
    { name: 'Elara', mes: 'The room is empty.' },
    { is_user: true, mes: 'I step inside.' },
    { is_user: true, mes: 'I draw my sword.' },
  ];
  const pendingRepair = { note: 'n', anchorIdx: 0, anchorHash: hashText(chat[0].mes) };

  assert.equal(isPendingRepairAnchorValid(chat, pendingRepair), false);
});

test('anchored repair: invalidated when the anchor is not an AI message', () => {
  const chat = [
    { name: 'Elara', mes: 'The room is empty.' },
    { is_user: true, mes: 'I step inside.' },
  ];
  const pendingRepair = { note: 'n', anchorIdx: 1, anchorHash: hashText(chat[1].mes) };

  assert.equal(isPendingRepairAnchorValid(chat, pendingRepair), false);
});

// =========================================================================
// Over-suppression guards (physical movement / idiom / stopword matching)
// =========================================================================

test('validateIssue: physical movement "turned" near a trait is not a transformation', () => {
  // "turned" here is the character turning around, not the eyes changing.
  const facts = 'Elara has silver eyes.';
  const latest = 'Elara turned and her blue eyes met his across the room.';
  const issue = {
    fact: 'Elara has silver eyes.',
    response_quote: 'her blue eyes met his',
    category: 'permanent_trait',
    why_not_progression: 'Eye colour is permanent and nothing in the scene changed it.',
  };

  assert.equal(validateIssue(issue, latest, facts), true);
});

test('validateIssue: idiom "changed the subject" does not suppress a hair contradiction', () => {
  const facts = 'Elara has silver hair.';
  const latest = 'She changed the subject, and her silver hair caught the lamplight.';
  const issue = {
    fact: 'Elara has silver hair.',
    response_quote: 'her silver hair caught the lamplight',
    category: 'permanent_trait',
    why_not_progression: 'Hair colour is permanent and no event changed it.',
  };

  assert.equal(validateIssue(issue, latest, facts), true);
});

test('validateIssue: a transcript sentence about a different trait never suppresses', () => {
  // The old matcher linked on the stopword "her", so "Her voice changed to a
  // whisper" wrongly suppressed a hair contradiction. Only substantive trait
  // words may link now.
  const facts = 'Elara has silver hair.';
  const latest = 'Elara walked into the hall, her silver hair bright under the lanterns.';
  const transcript = '[Elara] Her voice changed to a whisper as she entered the hall.';
  const issue = {
    fact: 'Elara has silver hair.',
    response_quote: 'her silver hair bright',
    category: 'permanent_trait',
    why_not_progression: 'Hair colour is permanent and nothing changed it.',
  };

  assert.equal(validateIssue(issue, latest, facts, transcript), true);
});

// =========================================================================
// Trivial quote rejection + transcript-transition gating (F5)
// =========================================================================

test('validateIssue: rejects a trivial stopword quote (F5)', () => {
  const facts = 'Elara has blue eyes.';
  const latest = 'She met his gaze, her eyes unreadable.';
  const base = {
    fact: 'Elara has blue eyes.',
    category: 'permanent_trait',
    why_not_progression: 'Eye colour is permanent and nothing in the scene changed it.',
  };

  assert.equal(validateIssue({ ...base, response_quote: 'her' }, latest, facts), false);
  assert.equal(validateIssue({ ...base, response_quote: 'the' }, latest, facts), false);
  // A quote that is nothing but stopwords is rejected even when it is long enough.
  assert.equal(validateIssue({ ...base, response_quote: 'her them' }, latest, facts), false);
  assert.equal(
    validateIssue({ ...base, response_quote: 'their' }, 'their eyes gleamed', facts),
    false,
  );
  // A substantive quote (>= 5 chars, at least one content word) still passes.
  assert.equal(
    validateIssue({ ...base, response_quote: 'her eyes unreadable' }, latest, facts),
    true,
  );
});

test('validateIssue: an unrelated transcript sentence never suppresses an eye-colour contradiction (F5)', () => {
  // "[Narrator] The evening sky turned blue." matches the colour "blue" and the
  // verb "turned", but it is not a transition of Elara's eyes. It must NOT
  // suppress the genuine contradiction.
  const facts = 'Elara has blue eyes.';
  const latest = 'Elara looked up, her eyes green in the torchlight.';
  const transcript = '[Narrator] The evening sky turned blue.';
  const issue = {
    fact: 'Elara has blue eyes.',
    response_quote: 'her eyes green',
    category: 'permanent_trait',
    why_not_progression: 'Eye colour is permanent and nothing in the scene changed it.',
  };

  assert.equal(validateIssue(issue, latest, facts, transcript), true);
});

test('validateIssue: a transcript transition that mentions the attribute still suppresses (F5)', () => {
  // Regression guard for the gate: a genuine on-screen change of the same
  // attribute (mentioned by name) is still progression, not a contradiction.
  const facts = 'Elara has silver hair.';
  const latest = 'Elara tied back her black hair before the fight.';
  const transcript = '[Elara] Last night I dyed my hair black for the festival.';
  const issue = {
    fact: 'Elara has silver hair.',
    response_quote: 'her black hair',
    category: 'permanent_trait',
    why_not_progression: 'Hair colour is permanent and cannot change.',
  };

  assert.equal(validateIssue(issue, latest, facts, transcript), false);
});

// =========================================================================
// Repair note vs. user acknowledgement
// =========================================================================

test('anchored repair: invalidated when the user reply embraces the changed state', () => {
  const chat = [
    { name: 'Elara', mes: 'Her eyes are crimson now.' },
    { is_user: true, mes: 'I stare into her crimson eyes without fear.' },
  ];
  const pendingRepair = {
    note: 'n',
    anchorIdx: 0,
    anchorHash: hashText(chat[0].mes),
    quotes: ['crimson eyes'],
  };

  assert.equal(isPendingRepairAnchorValid(chat, pendingRepair), false);
});

test('anchored repair: stays valid when the user reply does not reference the change', () => {
  const chat = [
    { name: 'Elara', mes: 'Her eyes are crimson now.' },
    { is_user: true, mes: 'I ask what happened at the gate.' },
  ];
  const pendingRepair = {
    note: 'n',
    anchorIdx: 0,
    anchorHash: hashText(chat[0].mes),
    quotes: ['crimson eyes'],
  };

  assert.equal(isPendingRepairAnchorValid(chat, pendingRepair), true);
});

// =========================================================================
// Durable retcons
// =========================================================================

test('buildDurableRetconNote: injects the standing continuity-note phrasing', () => {
  const note = buildDurableRetconNote([
    { fact: 'Elara is a high elf.' },
    { fact: 'Elara has silver eyes.' },
  ]);

  assert.ok(note.includes('Elara is a high elf.'));
  assert.ok(note.includes('Elara has silver eyes.'));
  assert.match(note, /^\[Continuity notes:/);
  assert.match(note, /earlier in the story it was established that/);
  assert.match(
    note,
    /Everything already written in this conversation has happened and stands\.\]$/,
  );
});

test('buildDurableRetconNote: accepts plain string facts and returns empty for none', () => {
  assert.ok(buildDurableRetconNote(['Elara is a high elf.']).includes('Elara is a high elf.'));
  assert.equal(buildDurableRetconNote([]), '');
  assert.equal(buildDurableRetconNote(null), '');
  assert.equal(buildDurableRetconNote([{ fact: '   ' }]), '');
});

test('advanceRetconLifetimes: auto-resolves a retcon after N turns', () => {
  let retcons = [{ id: 'r1', fact: 'a fact', turns_remaining: 3 }];

  retcons = advanceRetconLifetimes(retcons);
  assert.equal(retcons[0].turns_remaining, 2);

  retcons = advanceRetconLifetimes(retcons);
  assert.equal(retcons[0].turns_remaining, 1);

  // One more AI turn reaches zero - the retcon is dropped (canon).
  retcons = advanceRetconLifetimes(retcons);
  assert.deepEqual(retcons, []);
});

test('advanceRetconLifetimes: defaults a missing lifetime to RETCON_TURNS', () => {
  const retcons = advanceRetconLifetimes([{ id: 'r1', fact: 'a fact' }]);
  assert.equal(retcons[0].turns_remaining, RETCON_TURNS - 1);
});

test('advanceRetconLifetimes: keeps unrelated retcons while advancing all', () => {
  const retcons = advanceRetconLifetimes([
    { id: 'r1', fact: 'one', turns_remaining: 5 },
    { id: 'r2', fact: 'two', turns_remaining: 1 },
  ]);
  assert.equal(retcons.length, 1);
  assert.equal(retcons[0].id, 'r1');
  assert.equal(retcons[0].turns_remaining, 4);
});

test('invalidateAcceptedRetcons: drops a retcon the user echoes, keeps the rest (F5)', () => {
  const retcons = [
    { id: 'r1', fact: 'Elara has silver eyes.', quote: 'her crimson eyes' },
    { id: 'r2', fact: 'Kael is mortal.', quote: 'he cannot die' },
  ];

  const remaining = invalidateAcceptedRetcons(
    retcons,
    'I stare into her crimson eyes without fear.',
  );

  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].id, 'r2');
});

test('invalidateAcceptedRetcons: keeps everything when the reply is unrelated', () => {
  const retcons = [{ id: 'r1', fact: 'Elara has silver eyes.', quote: 'her crimson eyes' }];
  const remaining = invalidateAcceptedRetcons(retcons, 'I ask what happened at the gate.');
  assert.equal(remaining.length, 1);
});

test('invalidateAcceptedRetcons: empty/absent user text keeps all retcons', () => {
  const retcons = [{ id: 'r1', fact: 'Elara has silver eyes.', quote: 'crimson eyes' }];
  assert.equal(invalidateAcceptedRetcons(retcons, '').length, 1);
  assert.equal(invalidateAcceptedRetcons(retcons, null).length, 1);
  assert.deepEqual(invalidateAcceptedRetcons(null, 'text'), []);
});
