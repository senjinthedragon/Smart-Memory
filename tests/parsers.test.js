import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseExtractionOutput,
  parseSessionOutput,
  parseArcOutput,
  parseContradictions,
  formatSummary,
  detectSceneBreakHeuristic,
} from '../parsers.js';

// =========================================================================
// parseExtractionOutput
// =========================================================================

test('parseExtractionOutput: returns [] for NONE', () => {
  assert.deepEqual(parseExtractionOutput('NONE'), []);
  assert.deepEqual(parseExtractionOutput('none'), []);
  assert.deepEqual(parseExtractionOutput('  NONE  '), []);
});

test('parseExtractionOutput: returns [] for empty/null input', () => {
  assert.deepEqual(parseExtractionOutput(''), []);
  assert.deepEqual(parseExtractionOutput(null), []);
  assert.deepEqual(parseExtractionOutput(undefined), []);
});

test('parseExtractionOutput: parses basic [type] line with defaults', () => {
  const result = parseExtractionOutput('[fact] The character is tall and silver-haired.');
  assert.equal(result.length, 1);
  assert.equal(result[0].type, 'fact');
  assert.equal(result[0].content, 'The character is tall and silver-haired.');
  assert.equal(result[0].importance, 2);
  assert.equal(result[0].expiration, 'permanent');
  assert.equal(result[0].consolidated, false);
  assert.equal(typeof result[0].ts, 'number');
});

test('parseExtractionOutput: parses importance score from tag', () => {
  const result = parseExtractionOutput('[relationship:3] She trusts the innkeeper completely.');
  assert.equal(result[0].importance, 3);
  assert.equal(result[0].type, 'relationship');
});

test('parseExtractionOutput: parses expiration tag', () => {
  const result = parseExtractionOutput('[event:2:session] They sealed the pact at dawn.');
  assert.equal(result[0].expiration, 'session');
  assert.equal(result[0].importance, 2);
});

test('parseExtractionOutput: accepts spaces around colon in tag', () => {
  const result = parseExtractionOutput('[fact : 1 : scene] Short-lived detail here.');
  assert.equal(result.length, 1);
  assert.equal(result[0].importance, 1);
  assert.equal(result[0].expiration, 'scene');
});

test('parseExtractionOutput: skips unknown type', () => {
  const result = parseExtractionOutput('[emotion] She felt sad about the loss.');
  assert.equal(result.length, 0);
});

test('parseExtractionOutput: skips content with 5 or fewer chars', () => {
  // Exactly 5 chars - skipped
  assert.equal(parseExtractionOutput('[fact] Hello').length, 0);
  // Exactly 6 chars - accepted
  assert.equal(parseExtractionOutput('[fact] Hello!').length, 1);
});

test('parseExtractionOutput: parses all four valid types', () => {
  const input = [
    '[fact] The city wall is made of black stone.',
    '[relationship] She considers him a mentor.',
    '[preference] He dislikes cold weather intensely.',
    '[event] They first met at the festival of lights.',
  ].join('\n');
  const result = parseExtractionOutput(input);
  assert.equal(result.length, 4);
  assert.deepEqual(
    result.map((m) => m.type),
    ['fact', 'relationship', 'preference', 'event'],
  );
});

test('parseExtractionOutput: all entries have consolidated: false', () => {
  const result = parseExtractionOutput('[fact] One thing.\n[relationship] Another thing here.');
  assert.ok(result.every((m) => m.consolidated === false));
});

test('parseExtractionOutput: all entries have graph fields', () => {
  const result = parseExtractionOutput('[fact:2:permanent] The city wall is made of black stone.');
  assert.equal(result.length, 1);
  assert.equal(typeof result[0].id, 'string');
  assert.ok(result[0].id.length > 0);
  assert.deepEqual(result[0].source_messages, []);
  assert.deepEqual(result[0].entities, []);
  assert.equal(result[0].time_scope, 'global');
  assert.equal(result[0].valid_from, null);
  assert.equal(result[0].valid_to, null);
  assert.deepEqual(result[0].supersedes, []);
  assert.equal(result[0].superseded_by, null);
  assert.deepEqual(result[0].contradicts, []);
});

test('parseExtractionOutput: parses entity names from :entity= field', () => {
  const result = parseExtractionOutput(
    "[fact:2:permanent:entity=Senjin,Alex] Senjin is Alex's older brother.",
  );
  assert.equal(result.length, 1);
  assert.deepEqual(result[0]._raw_entity_names, ['Senjin', 'Alex']);
});

test('parseExtractionOutput: entity field is empty array when absent', () => {
  const result = parseExtractionOutput('[fact:2:permanent] No named entities here.');
  assert.deepEqual(result[0]._raw_entity_names, []);
});

test('parseExtractionOutput: entity field works in any bracket position', () => {
  // entity= before score and expiration
  const result = parseExtractionOutput(
    '[relationship:entity=Elara,Kael:3:permanent] They fought side by side at the bridge.',
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].importance, 3);
  assert.equal(result[0].expiration, 'permanent');
  assert.deepEqual(result[0]._raw_entity_names, ['Elara', 'Kael']);
});

test('parseExtractionOutput: each entry gets a unique id', () => {
  const result = parseExtractionOutput(
    '[fact] The city wall is made of black stone.\n[relationship] She trusts him completely.',
  );
  assert.equal(result.length, 2);
  assert.notEqual(result[0].id, result[1].id);
});

// =========================================================================
// parseSessionOutput
// =========================================================================

test('parseSessionOutput: returns [] for NONE', () => {
  assert.deepEqual(parseSessionOutput('NONE'), []);
  assert.deepEqual(parseSessionOutput('none'), []);
});

test('parseSessionOutput: returns [] for empty/null input', () => {
  assert.deepEqual(parseSessionOutput(''), []);
  assert.deepEqual(parseSessionOutput(null), []);
});

test('parseSessionOutput: parses [scene] with defaults', () => {
  const result = parseSessionOutput('[scene] Candlelit tavern, late evening, rain outside.');
  assert.equal(result.length, 1);
  assert.equal(result[0].type, 'scene');
  assert.equal(result[0].importance, 2);
  // Default expiration for session is 'session', not 'permanent'
  assert.equal(result[0].expiration, 'session');
  assert.equal(result[0].consolidated, false);
});

test('parseSessionOutput: parses all four session types', () => {
  const input = [
    '[scene] Dark alley behind the marketplace.',
    '[revelation] The map was forged all along.',
    '[development] Trust deepened after the confession.',
    '[detail] The locket has a hidden compartment.',
  ].join('\n');
  const result = parseSessionOutput(input);
  assert.equal(result.length, 4);
  assert.deepEqual(
    result.map((m) => m.type),
    ['scene', 'revelation', 'development', 'detail'],
  );
});

test('parseSessionOutput: parses importance and expiration tags', () => {
  const result = parseSessionOutput('[revelation:3:permanent] She admits the letter was forged.');
  assert.equal(result[0].importance, 3);
  assert.equal(result[0].expiration, 'permanent');
});

test('parseSessionOutput: minimum content length is > 3', () => {
  // 3 chars - skipped
  assert.equal(parseSessionOutput('[scene] Hmm').length, 0);
  // 4 chars - accepted
  assert.equal(parseSessionOutput('[scene] Dawn').length, 1);
});

test('parseSessionOutput: skips unknown session types', () => {
  assert.equal(parseSessionOutput('[memory] Something happened here.').length, 0);
  assert.equal(parseSessionOutput('[fact] This is a longterm type.').length, 0);
});

test('parseSessionOutput: all entries have graph fields with session scope', () => {
  const result = parseSessionOutput(
    '[scene:2:scene] Candlelit tavern, late evening, rain outside.',
  );
  assert.equal(result.length, 1);
  assert.equal(typeof result[0].id, 'string');
  assert.deepEqual(result[0].source_messages, []);
  assert.deepEqual(result[0].entities, []);
  assert.equal(result[0].time_scope, 'session');
  assert.equal(result[0].superseded_by, null);
});

test('parseSessionOutput: parses entity names from :entity= field', () => {
  const result = parseSessionOutput(
    '[revelation:3:permanent:entity=Senjin,Kael] Senjin revealed that Kael is his estranged brother.',
  );
  assert.equal(result.length, 1);
  assert.deepEqual(result[0]._raw_entity_names, ['Senjin', 'Kael']);
});

test('parseSessionOutput: entity field is empty array when absent', () => {
  const result = parseSessionOutput("[detail:2:session] The whiskey is Dragon's Fire brand.");
  assert.deepEqual(result[0]._raw_entity_names, []);
});

// =========================================================================
// parseArcOutput
// =========================================================================

test('parseArcOutput: returns empty add/resolve for NONE', () => {
  const result = parseArcOutput('NONE', []);
  assert.deepEqual(result.add, []);
  assert.deepEqual(result.resolve, []);
});

test('parseArcOutput: returns empty for null input', () => {
  const result = parseArcOutput(null, []);
  assert.deepEqual(result.add, []);
  assert.deepEqual(result.resolve, []);
});

test('parseArcOutput: parses [arc] lines', () => {
  const result = parseArcOutput('[arc] She promised to return before the first snow.', []);
  assert.equal(result.add.length, 1);
  assert.equal(result.add[0].content, 'She promised to return before the first snow.');
  assert.equal(typeof result.add[0].ts, 'number');
});

test('parseArcOutput: skips [arc] with content 5 chars or fewer', () => {
  // 5 chars - skipped
  assert.equal(parseArcOutput('[arc] Quest', []).add.length, 0);
  // 6 chars - accepted
  assert.equal(parseArcOutput('[arc] Quests', []).add.length, 1);
});

test('parseArcOutput: resolves arc with sufficient Jaccard overlap', () => {
  // Arc: "She promised to meet him at the tower"
  // Resolved text: "She met him at the tower at last"
  // Shared words include: she, him, at, the, tower -> well above 25% Jaccard
  const existing = [{ content: 'She promised to meet him at the tower.' }];
  const result = parseArcOutput('[resolved] She met him at the tower at last.', existing);
  assert.deepEqual(result.resolve, [0]);
});

test('parseArcOutput: does not resolve arc with insufficient Jaccard overlap', () => {
  // Arc about dragons; resolved text about wizards - almost no word overlap
  const existing = [{ content: 'The dragon guards the northern mountain pass.' }];
  const result = parseArcOutput('[resolved] The wizard completed his magical training.', existing);
  assert.deepEqual(result.resolve, []);
});

test('parseArcOutput: deduplicates resolved indices', () => {
  // Two [resolved] lines both match the same arc
  const existing = [{ content: 'She promised to find the lost relic and bring it back.' }];
  const input =
    '[resolved] She found the lost relic finally.\n[resolved] She returned with the relic.';
  const result = parseArcOutput(input, existing);
  // Both lines match arc at index 0, but Set deduplication should yield [0] not [0, 0]
  assert.deepEqual(result.resolve, [0]);
});

test('parseArcOutput: handles multiple arcs and only resolves matching ones', () => {
  const existing = [
    { content: 'She promised to meet him at the tower.' },
    { content: 'The ancient seal must be broken to free the prisoners.' },
  ];
  const input =
    '[arc] A new mystery emerged from the forest.\n[resolved] She met him at the tower.';
  const result = parseArcOutput(input, existing);
  assert.equal(result.add.length, 1);
  assert.equal(result.add[0].content, 'A new mystery emerged from the forest.');
  // Only arc 0 resolved, not arc 1
  assert.deepEqual(result.resolve, [0]);
});

// =========================================================================
// parseContradictions
// =========================================================================

test('parseContradictions: returns [] for NONE', () => {
  assert.deepEqual(parseContradictions('NONE'), []);
  assert.deepEqual(parseContradictions('none'), []);
  assert.deepEqual(parseContradictions('  NONE  '), []);
});

test('parseContradictions: returns [] for null/empty', () => {
  assert.deepEqual(parseContradictions(null), []);
  assert.deepEqual(parseContradictions(''), []);
  assert.deepEqual(parseContradictions(undefined), []);
});

test('parseContradictions: returns [] when first line is all-clear', () => {
  assert.deepEqual(parseContradictions('No contradictions found.'), []);
  assert.deepEqual(parseContradictions('No conflicts detected.'), []);
  assert.deepEqual(parseContradictions('The response does not contradict anything.'), []);
  assert.deepEqual(
    parseContradictions('The response does not conflict with established facts.'),
    [],
  );
  assert.deepEqual(parseContradictions('This is consistent with the established lore.'), []);
  assert.deepEqual(parseContradictions('The response aligns with the character card.'), []);
  assert.deepEqual(parseContradictions('No issues found.'), []);
});

test('parseContradictions: returns contradictions when first line is real', () => {
  const result = parseContradictions(
    'The character claimed to be human but is established as an elf.',
  );
  assert.equal(result.length, 1);
  assert.equal(result[0], 'The character claimed to be human but is established as an elf.');
});

test('parseContradictions: strips bullet characters from lines', () => {
  const result = parseContradictions(
    '- First contradiction here.\n• Second contradiction here.\n* Third contradiction here.',
  );
  assert.equal(result.length, 3);
  assert.equal(result[0], 'First contradiction here.');
  assert.equal(result[1], 'Second contradiction here.');
  assert.equal(result[2], 'Third contradiction here.');
});

test('parseContradictions: strips numbered list prefixes', () => {
  const result = parseContradictions('1. First issue.\n2. Second issue.\n10. Tenth issue.');
  assert.equal(result.length, 3);
  assert.equal(result[0], 'First issue.');
  assert.equal(result[1], 'Second issue.');
  assert.equal(result[2], 'Tenth issue.');
});

test('parseContradictions: filters out empty lines', () => {
  const result = parseContradictions('First issue.\n\n\nSecond issue.');
  assert.equal(result.length, 2);
});

test('parseContradictions: all-clear phrase on second line does not suppress contradictions', () => {
  // First line is a real contradiction, second line happens to contain an all-clear phrase.
  // Only the first line is checked for all-clear, so all lines should be returned.
  const result = parseContradictions(
    'She claimed to be a blacksmith but was established as a healer.\nThis is consistent with nothing, actually.',
  );
  assert.equal(result.length, 2);
  assert.equal(result[0], 'She claimed to be a blacksmith but was established as a healer.');
});

// =========================================================================
// formatSummary
// =========================================================================

test('formatSummary: extracts content from complete <summary> tags', () => {
  const raw = '<summary>The story so far, condensed.</summary>';
  assert.equal(formatSummary(raw), 'The story so far, condensed.');
});

test('formatSummary: strips <analysis> block before extracting summary', () => {
  const raw =
    '<analysis>Some scratchpad thinking here.</analysis>\n<summary>Clean summary text.</summary>';
  assert.equal(formatSummary(raw), 'Clean summary text.');
});

test('formatSummary: handles unclosed <analysis> tag before <summary>', () => {
  const raw =
    '<analysis>Model started thinking but did not close the tag\n<summary>The summary content.</summary>';
  assert.equal(formatSummary(raw), 'The summary content.');
});

test('formatSummary: handles partial <summary> without closing tag', () => {
  // Model was cut off mid-response
  const raw = '<summary>The story began in a small village and';
  assert.equal(formatSummary(raw), 'The story began in a small village and');
});

test('formatSummary: returns trimmed raw text when no tags present', () => {
  assert.equal(formatSummary('  Just raw text output.  '), 'Just raw text output.');
});

test('formatSummary: tags are case-insensitive', () => {
  const raw = '<ANALYSIS>Thinking...</ANALYSIS><SUMMARY>The summary.</SUMMARY>';
  assert.equal(formatSummary(raw), 'The summary.');
});

test('formatSummary: trims whitespace inside summary tags', () => {
  const raw = '<summary>\n  The story content.\n</summary>';
  assert.equal(formatSummary(raw), 'The story content.');
});

test('formatSummary: preserves internal newlines in summary content', () => {
  const raw = '<summary>First paragraph.\n\nSecond paragraph.</summary>';
  assert.equal(formatSummary(raw), 'First paragraph.\n\nSecond paragraph.');
});

// =========================================================================
// detectSceneBreakHeuristic
// =========================================================================

test('detectSceneBreakHeuristic: detects relative time skips', () => {
  assert.equal(detectSceneBreakHeuristic('Later that day, she returned to the village.'), true);
  assert.equal(detectSceneBreakHeuristic('The next morning she woke to find him gone.'), true);
  assert.equal(detectSceneBreakHeuristic('Hours later the guard finally returned.'), true);
  assert.equal(detectSceneBreakHeuristic('Days later they reached the coast.'), true);
  assert.equal(detectSceneBreakHeuristic('The following week brought colder winds.'), true);
  assert.equal(detectSceneBreakHeuristic('Meanwhile, back at the keep, things had changed.'), true);
});

test('detectSceneBreakHeuristic: detects absolute time jumps', () => {
  assert.equal(detectSceneBreakHeuristic('A year passed and little had changed.'), true);
  assert.equal(detectSceneBreakHeuristic('Several months went by without news.'), true);
  assert.equal(detectSceneBreakHeuristic('Three weeks had gone by since the battle.'), true);
  assert.equal(detectSceneBreakHeuristic('A decade passed before she returned.'), true);
});

test('detectSceneBreakHeuristic: detects location transitions', () => {
  assert.equal(detectSceneBreakHeuristic('She arrived at the castle gates at dusk.'), true);
  assert.equal(detectSceneBreakHeuristic('He found himself in a dimly lit cellar.'), true);
  assert.equal(detectSceneBreakHeuristic('She made her way to the old lighthouse.'), true);
  assert.equal(
    detectSceneBreakHeuristic('They fled into the ancient forest beyond the ridge.'),
    true,
  );
});

test('detectSceneBreakHeuristic: detects separator markers', () => {
  assert.equal(detectSceneBreakHeuristic('---'), true);
  assert.equal(detectSceneBreakHeuristic('***'), true);
  assert.equal(detectSceneBreakHeuristic('~~~'), true);
  assert.equal(detectSceneBreakHeuristic('* * *'), true);
  assert.equal(detectSceneBreakHeuristic('Before\n---\nAfter'), true);
});

test('detectSceneBreakHeuristic: does not trigger on normal prose', () => {
  assert.equal(detectSceneBreakHeuristic('She entered the room quietly.'), false);
  assert.equal(detectSceneBreakHeuristic('He walked across the hall toward the window.'), false);
  assert.equal(detectSceneBreakHeuristic('They sat together by the fire.'), false);
  assert.equal(detectSceneBreakHeuristic('"I need to go," she said softly.'), false);
  assert.equal(detectSceneBreakHeuristic('The door creaked as it swung open.'), false);
});

test('detectSceneBreakHeuristic: does not trigger on bare word "later"', () => {
  // "later" alone should not match - requires context like "hours later" or "later that day"
  assert.equal(detectSceneBreakHeuristic('We can talk about that later.'), false);
  assert.equal(detectSceneBreakHeuristic('She would figure it out later.'), false);
});
