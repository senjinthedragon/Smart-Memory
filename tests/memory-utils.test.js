import test from 'node:test';
import assert from 'node:assert/strict';
import {
  adaptiveBudgets,
  buildCurrentSceneStateBlock,
  classifyTurn,
  hybridScore,
  matchSubjectToMember,
  memoryUtilityScore,
  normalizeEpistemicSubject,
  partitionEpistemicEntriesBySubject,
  prioritizeMemories,
  reconcileTypeEntries,
  selectProtectedMemories,
  sortByTimeline,
  splitSummarySections,
  trimByPriority,
  truncateSummaryToBudget,
} from '../memory-utils.js';

test('trimByPriority keeps high-importance memories over low-importance ones', () => {
  const memories = [
    { type: 'fact', content: 'low old', importance: 1, ts: 1000 },
    { type: 'fact', content: 'high old', importance: 3, ts: 900 },
    { type: 'fact', content: 'medium new', importance: 2, ts: 3000 },
  ];

  const trimmed = trimByPriority(memories, 2);
  const contents = trimmed.map((m) => m.content);

  assert.equal(trimmed.length, 2);
  assert.ok(contents.includes('high old'));
  assert.ok(contents.includes('medium new'));
  assert.ok(!contents.includes('low old'));
});

test('trimByPriority favors permanent expiration over scene when importance ties', () => {
  const memories = [
    {
      type: 'event',
      content: 'temporary tavern chatter',
      importance: 2,
      expiration: 'scene',
      ts: 5000,
    },
    {
      type: 'event',
      content: 'major oath was sworn',
      importance: 2,
      expiration: 'permanent',
      ts: 1000,
    },
  ];

  const trimmed = trimByPriority(memories, 1);
  assert.equal(trimmed[0].content, 'major oath was sworn');
});

test('prioritizeMemories boosts recurring keywords compared to one-off details', () => {
  const prioritized = prioritizeMemories([
    {
      type: 'fact',
      content: 'The relic is hidden in the crypt vault',
      importance: 2,
      expiration: 'session',
      ts: 1000,
    },
    {
      type: 'event',
      content: 'They opened the crypt gate at midnight',
      importance: 2,
      expiration: 'session',
      ts: 900,
    },
    {
      type: 'detail',
      content: 'A lantern flickered once near the doorway',
      importance: 2,
      expiration: 'scene',
      ts: 3000,
    },
  ]);

  assert.equal(prioritized[0].content, 'The relic is hidden in the crypt vault');
  assert.equal(prioritized[1].content, 'They opened the crypt gate at midnight');
});

test('reconcileTypeEntries replaces overlapping base entry with promoted update', async () => {
  const base = [{ type: 'relationship', content: 'We are married.', ts: 1234 }];
  const promoted = [{ type: 'relationship', content: 'We are married. Happily.', ts: 9999 }];

  const reconciled = await reconcileTypeEntries(base, promoted, 0.65);

  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0].content, promoted[0].content);
  assert.equal(reconciled[0].ts, 1234);
});

test('reconcileTypeEntries appends genuinely new entries', async () => {
  const base = [{ type: 'fact', content: 'The ring is silver.' }];
  const promoted = [{ type: 'fact', content: 'The house has a red door.' }];

  const reconciled = await reconcileTypeEntries(base, promoted, 0.7);

  assert.equal(reconciled.length, 2);
  assert.ok(reconciled.some((m) => m.content === 'The ring is silver.'));
  assert.ok(reconciled.some((m) => m.content === 'The house has a red door.'));
});

test('reconcileTypeEntries infers timestamp for new promoted entries from timeline pool', async () => {
  const base = [{ type: 'event', content: 'We escaped the city.', ts: 2000 }];
  const unprocessed = [{ type: 'event', content: 'We escaped the city at dawn.', ts: 3000 }];
  const promoted = [
    { type: 'event', content: 'We escaped the city at dawn via the east gate.', ts: 9999 },
  ];

  const reconciled = await reconcileTypeEntries(base, promoted, 0.7, [...base, ...unprocessed]);
  const added = reconciled.find((m) => m.content === promoted[0].content);

  assert.ok(added);
  assert.equal(added.ts, 3000);
});

test('sortByTimeline returns memories in chronological order', () => {
  const sorted = sortByTimeline([
    { content: 'late', ts: 300 },
    { content: 'early', ts: 100 },
    { content: 'middle', ts: 200 },
  ]);

  assert.deepEqual(
    sorted.map((m) => m.content),
    ['early', 'middle', 'late'],
  );
});

test('memoryUtilityScore boosts persona and intimacy relevant memories', () => {
  const base = {
    type: 'preference',
    content: 'The user prefers slow-burn affectionate scenes.',
    importance: 2,
    expiration: 'permanent',
    ts: 1000,
  };
  const low = memoryUtilityScore({
    ...base,
    persona_relevance: 0,
    intimacy_relevance: 0,
    retrieval_count: 0,
  });
  const high = memoryUtilityScore({
    ...base,
    persona_relevance: 3,
    intimacy_relevance: 3,
    retrieval_count: 4,
  });
  assert.ok(high > low);
});

test('selectProtectedMemories keeps one memory per required type', () => {
  const memories = [
    { type: 'relationship', content: 'We trust each other deeply.', importance: 3, ts: 1000 },
    { type: 'relationship', content: 'We had a minor disagreement.', importance: 1, ts: 1500 },
    { type: 'preference', content: 'She likes teasing banter.', importance: 2, ts: 1200 },
    { type: 'fact', content: 'She always wears silver rings.', importance: 2, ts: 900 },
  ];
  const selected = selectProtectedMemories(memories, ['relationship', 'preference', 'fact']);
  assert.equal(selected.length, 3);
  assert.ok(selected.some((m) => m.type === 'relationship' && m.content.includes('trust')));
  assert.ok(selected.some((m) => m.type === 'preference'));
  assert.ok(selected.some((m) => m.type === 'fact'));
});

test('buildCurrentSceneStateBlock keeps newest scene-oriented memories', () => {
  const block = buildCurrentSceneStateBlock([
    { type: 'scene', content: 'Old tavern room.', ts: 10 },
    { type: 'scene', content: 'Rainy balcony at midnight.', ts: 20 },
    { type: 'development', content: 'Trust deepened after the apology.', ts: 30 },
    { type: 'detail', content: 'Her coat is still wet from the storm.', ts: 25 },
    { type: 'revelation', content: 'She admits the letter was forged.', ts: 35 },
  ]);

  assert.match(block, /Rainy balcony at midnight\./);
  assert.match(block, /Trust deepened after the apology\./);
  assert.match(block, /coat is still wet/);
  assert.match(block, /letter was forged/);
  assert.doesNotMatch(block, /Old tavern room/);
});

test('hybridScore boosts memories with entity overlap and arc relevance', () => {
  const focused = {
    type: 'event',
    content: 'Alex reveals the hidden key at the old tower.',
    importance: 2,
    expiration: 'session',
    ts: 1000,
    entities: ['e1'],
    time_scope: 'session',
    contradicts: [],
  };
  const unfocused = {
    type: 'event',
    content: 'The weather stayed calm through the afternoon.',
    importance: 2,
    expiration: 'session',
    ts: 1000,
    entities: ['e2'],
    time_scope: 'global',
    contradicts: [],
  };

  const context = {
    turnMentions: new Set(['alex', 'tower']),
    entityRegistry: [
      { id: 'e1', name: 'Alex', aliases: [] },
      { id: 'e2', name: 'Harbor', aliases: [] },
    ],
    arcs: [{ content: 'Find the hidden key in the old tower.' }],
  };

  assert.ok(hybridScore(focused, context) > hybridScore(unfocused, context));
});

test('hybridScore applies w5 turn similarity boost when turnSimilarities provided', () => {
  const base = {
    type: 'fact',
    content: 'The key is hidden in the tower.',
    importance: 2,
    expiration: 'permanent',
    ts: 1000,
    entities: [],
    time_scope: 'global',
    contradicts: [],
  };
  const highTurnSim = { ...base, id: 'mem-relevant' };
  const lowTurnSim = { ...base, id: 'mem-irrelevant' };

  const context = {
    turnSimilarities: new Map([
      ['mem-relevant', 0.9],
      ['mem-irrelevant', 0.05],
    ]),
    w5: 0.6,
  };

  assert.ok(hybridScore(highTurnSim, context) > hybridScore(lowTurnSim, context));
  // w5 = 0 should produce equal scores (both use the same base fields)
  assert.equal(
    hybridScore(highTurnSim, { ...context, w5: 0 }),
    hybridScore(lowTurnSim, { ...context, w5: 0 }),
  );
});

test('hybridScore penalizes unresolved contradictions', () => {
  const clean = {
    type: 'fact',
    content: 'She lives in Berlin now.',
    importance: 3,
    expiration: 'permanent',
    ts: 1000,
    entities: [],
    time_scope: 'global',
    contradicts: [],
  };
  const contradicted = {
    ...clean,
    contradicts: ['m-older'],
  };
  assert.ok(hybridScore(clean, {}) > hybridScore(contradicted, {}));
});

test('classifyTurn detects intimate, transition, action, then dialogue fallback', () => {
  assert.equal(classifyTurn('He leans in to kiss her and gently caresses her cheek.'), 'intimate');
  assert.equal(classifyTurn('Hours later, they returned to the cabin before dawn.'), 'transition');
  assert.equal(classifyTurn('She dodged, then lunged forward to attack again.'), 'action');
  assert.equal(classifyTurn('They talk quietly about their plans for tomorrow.'), 'dialogue');
});

test('adaptiveBudgets preserves total budget while reallocating by turn type', () => {
  const settings = {
    longterm_inject_budget: 500,
    session_inject_budget: 400,
    scene_inject_budget: 300,
    arcs_inject_budget: 400,
    profiles_inject_budget: 200,
  };
  const baseTotal = 1800;

  const action = adaptiveBudgets(settings, 'action');
  const actionTotal = Object.values(action).reduce((sum, v) => sum + v, 0);

  assert.equal(actionTotal, baseTotal);
  assert.ok(action.session > settings.session_inject_budget);
  assert.ok(action.longterm < settings.longterm_inject_budget);
});

// =========================================================================
// Summary section truncation
// =========================================================================

function buildNineSectionSummary() {
  return [
    `1. Scene & Setting: ${'The ancient hall is cold and dark. '.repeat(12)}`,
    `2. Characters Present: ${'Elara watches the door nervously. '.repeat(8)}`,
    `3. Key Events: ${'They crossed the bridge and found the key. '.repeat(14)}`,
    `4. Relationship Dynamics: ${'Trust is fragile between them. '.repeat(8)}`,
    `5. Revealed Information: ${'The key opens the sealed gate. '.repeat(8)}`,
    `6. Story Threads: ${'The oath remains unfulfilled. '.repeat(8)}`,
    `7. User's Direction: ${'Keep the tone tense and quiet. '.repeat(8)}`,
    '8. Current Moment: Elara stands at the sealed gate with the key in hand.',
    '9. Next Beat: The gate opens and cold air rushes out.',
  ].join('\n\n');
}

test('splitSummarySections parses numbered sections in order', () => {
  const { sections } = splitSummarySections(buildNineSectionSummary());
  assert.equal(sections.length, 9);
  assert.equal(sections[0].num, 1);
  assert.equal(sections[8].num, 9);
  assert.match(sections[7].text, /Current Moment/);
});

test('truncateSummaryToBudget preserves Current Moment and Next Beat', () => {
  const summary = buildNineSectionSummary();
  const trimmed = truncateSummaryToBudget(summary, 120);

  assert.ok(trimmed.length < summary.length);
  assert.match(trimmed, /8\. Current Moment:/);
  assert.match(trimmed, /Elara stands at the sealed gate/);
  assert.match(trimmed, /9\. Next Beat:/);
  assert.match(trimmed, /The gate opens and cold air rushes out/);
  assert.doesNotMatch(trimmed, /\[truncated\]$/);
});

test('truncateSummaryToBudget keeps anchor sections even below their own budget', () => {
  const summary = buildNineSectionSummary();
  // Far too small for the tail alone - the anchors must still survive intact.
  const trimmed = truncateSummaryToBudget(summary, 5);

  assert.match(trimmed, /8\. Current Moment:/);
  assert.match(trimmed, /Elara stands at the sealed gate/);
  assert.match(trimmed, /9\. Next Beat:/);
  assert.match(trimmed, /The gate opens and cold air rushes out/);
});

test('truncateSummaryToBudget falls back to tail truncation for unnumbered text', () => {
  const text = 'A long unnumbered recollection without any section headers. '.repeat(40);
  const trimmed = truncateSummaryToBudget(text, 20);

  assert.ok(trimmed.length < text.length);
  assert.match(trimmed, /\[truncated\]$/);
});

// =========================================================================
// Epistemic partitioning
// =========================================================================

test('partitionEpistemicEntriesBySubject groups entries per member and skips outsiders', () => {
  const entries = [
    { type: 'knows', subject: 'Alice', content: 'the vault code' },
    { type: 'suspects', subject: 'bob', content: 'Alice is lying' },
    { type: 'knows', subject: 'Alice', content: 'where the key is' },
    { type: 'knows', subject: 'Mallory', content: 'not a group member' },
  ];

  const { grouped, skipped } = partitionEpistemicEntriesBySubject(entries, ['Alice', 'Bob']);

  assert.deepEqual(
    grouped.get('Alice').map((e) => e.content),
    ['the vault code', 'where the key is'],
  );
  assert.deepEqual(
    grouped.get('Bob').map((e) => e.content),
    ['Alice is lying'],
  );
  // Subject casing is canonicalised to the member name for storage.
  assert.equal(grouped.get('Bob')[0].subject, 'Bob');
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].subject, 'Mallory');
});

test('matchSubjectToMember resolves first names, tokens, and partials', () => {
  assert.equal(matchSubjectToMember('Elara', ['Elara Voss', 'Kael Draven']), 'Elara Voss');
  assert.equal(matchSubjectToMember('Kael', ['Elara Voss', 'Kael Draven']), 'Kael Draven');
  assert.equal(matchSubjectToMember('Picard', ['Jean-Luc Picard']), 'Jean-Luc Picard');
  assert.equal(matchSubjectToMember('ELARA VOSS', ['Elara Voss']), 'Elara Voss');
  assert.equal(matchSubjectToMember('Draven', ['Kael Draven']), 'Kael Draven');
  assert.equal(matchSubjectToMember('Nobody', ['Elara Voss', 'Kael Draven']), null);
  assert.equal(matchSubjectToMember('', ['Elara Voss']), null);
});

test('matchSubjectToMember rejects substring false matches', () => {
  // "Evan" must not match "Evangeline Cole" via arbitrary substring matching.
  assert.equal(matchSubjectToMember('Evan', ['Evangeline Cole']), null);
  assert.equal(matchSubjectToMember('Ange', ['Evangeline Cole']), null);
  // A genuine bounded token still matches.
  assert.equal(matchSubjectToMember('Cole', ['Evangeline Cole']), 'Evangeline Cole');
});

test('matchSubjectToMember refuses ambiguous first-name matches', () => {
  // "Elara" matches both members - refuse rather than misattribute a secret.
  assert.equal(matchSubjectToMember('Elara', ['Elara Voss', 'Elara Night']), null);
  // Ambiguity only fires when multiple members genuinely match.
  assert.equal(matchSubjectToMember('Elara', ['Elara Voss', 'Kael Draven']), 'Elara Voss');
});

test('partitionEpistemicEntriesBySubject skips ambiguous subjects instead of misattributing', () => {
  const entries = [
    { type: 'knows', subject: 'Elara', content: 'the vault code' },
    { type: 'knows', subject: 'Kael', content: 'the ambush plan' },
  ];

  const { grouped, skipped } = partitionEpistemicEntriesBySubject(entries, [
    'Elara Voss',
    'Elara Night',
    'Kael Draven',
  ]);

  assert.equal(grouped.get('Elara Voss').length, 0);
  assert.equal(grouped.get('Elara Night').length, 0);
  assert.equal(grouped.get('Kael Draven')[0].content, 'the ambush plan');
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].subject, 'Elara');
});

test('partitionEpistemicEntriesBySubject matches first names to full member names', () => {
  const entries = [
    { type: 'knows', subject: 'Elara', content: 'the vault code' },
    { type: 'unaware', subject: 'Kael', content: 'the ambush plan' },
    { type: 'knows', subject: 'Mallory', content: 'not a member' },
  ];

  const { grouped, skipped } = partitionEpistemicEntriesBySubject(entries, [
    'Elara Voss',
    'Kael Draven',
  ]);

  assert.equal(grouped.get('Elara Voss')[0].content, 'the vault code');
  assert.equal(grouped.get('Elara Voss')[0].subject, 'Elara Voss');
  assert.equal(grouped.get('Kael Draven')[0].content, 'the ambush plan');
  assert.equal(grouped.get('Kael Draven')[0].subject, 'Kael Draven');
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].subject, 'Mallory');
});

// =========================================================================
// Solo-chat epistemic subject matching (F1)
// =========================================================================

test('matchSubjectToMember: solo short-form subject resolves to the full card name', () => {
  // buildEpistemicBlock filters entries with matchSubjectToMember(subject,
  // [respondingChar]). A card named "Elara Voss" must still pick up entries the
  // model emitted with the short form "Elara".
  assert.equal(matchSubjectToMember('Elara', ['Elara Voss']), 'Elara Voss');
  assert.equal(matchSubjectToMember('Voss', ['Elara Voss']), 'Elara Voss');
  assert.equal(matchSubjectToMember('Elara Voss', ['Elara Voss']), 'Elara Voss');
  assert.equal(matchSubjectToMember('ELARA', ['Elara Voss']), 'Elara Voss');
  // An unrelated subject must not be pulled into the solo character's block.
  assert.equal(matchSubjectToMember('Kael', ['Elara Voss']), null);
});

test('normalizeEpistemicSubject: canonicalises solo short-form subjects', () => {
  assert.equal(normalizeEpistemicSubject('Elara', 'Elara Voss'), 'Elara Voss');
  assert.equal(normalizeEpistemicSubject('ELARA VOSS', 'Elara Voss'), 'Elara Voss');
  assert.equal(normalizeEpistemicSubject('Draven', 'Kael Draven'), 'Kael Draven');
  // Unrelated subjects are left untouched.
  assert.equal(normalizeEpistemicSubject('Kael Draven', 'Elara Voss'), 'Kael Draven');
  assert.equal(normalizeEpistemicSubject('Mallory', 'Elara Voss'), 'Mallory');
  // Substring false positives are not rewritten.
  assert.equal(normalizeEpistemicSubject('Evan', 'Evangeline Cole'), 'Evan');
  // No character name means no rewrite.
  assert.equal(normalizeEpistemicSubject('Elara', ''), 'Elara');
});

// =========================================================================
// Nested numbered lists inside Section 3
// =========================================================================

function buildNestedListSummary() {
  return [
    '1. Scene & Setting: The ancient hall is cold and dark.',
    '2. Characters Present: Elara and Kael stand before the gate.',
    '3. Key Events:',
    '   7. They crossed the bridge at dawn.',
    '   8. Fought the bandits in the mountain pass.',
    '   9. Escaped the dungeon through a hidden tunnel.',
    '4. Relationship Dynamics: Trust is fragile between them.',
    '5. Revealed Information: The key opens the sealed gate.',
    '6. Story Threads: The oath remains unfulfilled.',
    "7. User's Direction: Keep the tone tense and quiet.",
    '8. Current Moment: Elara stands at the sealed gate with the key in hand.',
    '9. Next Beat: The gate opens and cold air rushes out.',
  ].join('\n');
}

test('splitSummarySections ignores numbered lists nested inside Section 3', () => {
  const { sections } = splitSummarySections(buildNestedListSummary());

  assert.deepEqual(
    sections.map((s) => s.num),
    [1, 2, 3, 4, 5, 6, 7, 8, 9],
  );

  const keyEvents = sections.find((s) => s.num === 3);
  assert.match(keyEvents.text, /Fought the bandits/);
  assert.match(keyEvents.text, /Escaped the dungeon/);

  const revealed = sections.find((s) => s.num === 5);
  assert.match(revealed.text, /Revealed Information/);
  assert.match(revealed.text, /key opens the sealed gate/);

  // Nested items 8 and 9 must not be mistaken for the real anchors.
  assert.match(sections.find((s) => s.num === 8).text, /Current Moment/);
  assert.match(sections.find((s) => s.num === 9).text, /Next Beat/);
});

test('truncateSummaryToBudget does not drop Section 5 when Section 3 has a nested list', () => {
  const summary = buildNestedListSummary();
  const trimmed = truncateSummaryToBudget(summary, 220);

  assert.match(trimmed, /5\. Revealed Information:/);
  assert.match(trimmed, /key opens the sealed gate/);
  assert.match(trimmed, /8\. Current Moment:/);
  assert.match(trimmed, /Elara stands at the sealed gate/);
  assert.match(trimmed, /9\. Next Beat:/);
  assert.match(trimmed, /The gate opens and cold air rushes out/);
});

// =========================================================================
// Markdown-formatted summary headers
// =========================================================================

const CANONICAL_SECTION_TITLES = [
  'Scene & Setting',
  'Characters Present',
  'Key Events',
  'Relationship Dynamics',
  'Revealed Information',
  'Story Threads',
  "User's Direction",
  'Current Moment',
  'Next Beat',
];

function buildSummaryWithFormatter(formatLine) {
  return CANONICAL_SECTION_TITLES.map((title, i) => formatLine(i + 1, title)).join('\n\n');
}

test('splitSummarySections parses plain, markdown, and alternate-delimiter headers', () => {
  const variants = [
    (n, t) => `${n}. ${t}: Section body ${n}.`, // 3. Key Events:
    (n, t) => `${n}. **${t}:** Section body ${n}.`, // 3. **Key Events:**
    (n, t) => `**${n}. ${t}** Section body ${n}.`, // **3. Key Events**
    (n, t) => `### ${n}. ${t} Section body ${n}.`, // ### 3. Key Events
    (n, t) => `${n}) ${t}: Section body ${n}.`, // 3) Key Events:
    (n, t) => `${n}: ${t}: Section body ${n}.`, // 3: Key Events:
    (n, t) => `${n} - ${t} Section body ${n}.`, // 3 - Key Events
  ];

  for (const format of variants) {
    const { sections } = splitSummarySections(buildSummaryWithFormatter(format));
    assert.equal(
      sections.length,
      9,
      `variant did not parse 9 sections: "${format(1, 'Scene & Setting')}"`,
    );
    assert.deepEqual(
      sections.map((s) => s.num),
      [1, 2, 3, 4, 5, 6, 7, 8, 9],
      `variant produced wrong section numbers: "${format(1, 'Scene & Setting')}"`,
    );
    assert.match(sections.find((s) => s.num === 8).text, /Current Moment/);
    assert.match(sections.find((s) => s.num === 9).text, /Next Beat/);
  }
});

test('truncateSummaryToBudget preserves anchors for markdown-formatted summaries', () => {
  const summary = buildSummaryWithFormatter(
    (n, t) => `### ${n}. ${t}\n${'The ancient hall is cold and dark. '.repeat(12)}`,
  );
  const trimmed = truncateSummaryToBudget(summary, 120);

  assert.ok(trimmed.length < summary.length);
  assert.match(trimmed, /Current Moment/);
  assert.match(trimmed, /Next Beat/);
});

// =========================================================================
// Scene buffer cursor contract
// =========================================================================

test('scene buffer cursor: end-of-chat index yields only newly appended messages', () => {
  const chat = ['m0', 'm1', 'm2'];
  let sceneBufferLastIndex = chat.length - 1; // 2, set at scene reset / chat load

  // No history is ingested immediately after the cursor is set.
  assert.deepEqual(chat.slice(sceneBufferLastIndex + 1), []);

  // Only the newly appended turn is picked up.
  chat.push('m3');
  assert.deepEqual(chat.slice(sceneBufferLastIndex + 1), ['m3']);

  sceneBufferLastIndex = chat.length - 1;
  assert.deepEqual(chat.slice(sceneBufferLastIndex + 1), []);

  // The legacy -1 cursor would re-ingest the whole history - the bug we fixed.
  assert.equal(chat.slice(-1 + 1).length, chat.length);
});

// =========================================================================
// N7 / 3.6: bidirectional epistemic subject matching
// =========================================================================

test('matchSubjectToMember: subject tokens may include a short member name (N7)', () => {
  // A long subject can resolve to a short canonical member name.
  assert.equal(matchSubjectToMember('Kael Draven', ['Kael']), 'Kael');
  assert.equal(matchSubjectToMember('Elara Voss', ['Elara']), 'Elara');
});

test('matchSubjectToMember: honorific titles are stripped from either side (N7)', () => {
  assert.equal(matchSubjectToMember('Lady Elara', ['Elara']), 'Elara');
  assert.equal(matchSubjectToMember('Lady Elara', ['Elara Voss']), 'Elara Voss');
  assert.equal(matchSubjectToMember('King Aldric', ['Aldric']), 'Aldric');
  assert.equal(matchSubjectToMember('Elara', ['Lady Elara']), 'Lady Elara');
});

test('matchSubjectToMember: possessives and punctuation are cleaned (N7)', () => {
  assert.equal(matchSubjectToMember("Elara's", ['Elara Voss']), 'Elara Voss');
  assert.equal(matchSubjectToMember('Elara’s', ['Elara Voss']), 'Elara Voss');
  assert.equal(matchSubjectToMember('Dr. Smith', ['Smith']), 'Smith');
  assert.equal(matchSubjectToMember('Jean-Luc Picard', ['Picard']), 'Picard');
});

test('matchSubjectToMember: cleaning does not introduce substring false positives (N7)', () => {
  assert.equal(matchSubjectToMember('Evan', ['Evangeline Cole']), null);
  assert.equal(matchSubjectToMember('Ange', ['Evangeline Cole']), null);
  assert.equal(matchSubjectToMember('Lady Evan', ['Evangeline Cole']), null);
});

test('matchSubjectToMember: bidirectional matching still refuses ambiguity (N7)', () => {
  assert.equal(matchSubjectToMember('Elara', ['Elara Voss', 'Elara Night']), null);
  assert.equal(matchSubjectToMember('Lady Elara', ['Elara Voss', 'Elara Night']), null);
  // A longer subject containing both members' tokens is ambiguous too.
  assert.equal(matchSubjectToMember('Elara Voss Night', ['Elara Voss', 'Elara Night']), null);
});
