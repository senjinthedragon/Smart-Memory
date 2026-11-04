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
 * Pure, dependency-free helpers for the continuity verification and anchored
 * forward-repair pipeline.
 *
 * These live apart from continuity.js so they can be unit-tested under plain
 * Node without loading SillyTavern's runtime modules (extensions.js, script.js).
 * continuity.js imports and re-exports them, so the public pipeline API is
 * still exposed from continuity.js.
 *
 * buildRecentTranscript       - renders the preceding chat turns as [USER]/[Name] lines
 * hashText                    - stable lightweight non-cryptographic text hash
 * validateIssue               - rejects an issue unless every evidence field checks out
 * buildForwardRepairNote      - builds the non-retracting continuity note
 * parseContinuityJson         - parses the model's strict-JSON continuity response
 * isPendingRepairAnchorValid  - verifies a queued repair still matches its anchor message
 */

import { keywordSet, STOPWORDS } from './memory-utils.js';

/** Only these contradiction categories are permitted through validation. */
export const CONTINUITY_CATEGORIES = ['permanent_trait', 'backstory', 'world_rule', 'death'];

// Active in-story transformation / transition verbs and state-change markers.
// A trait is only being changed on-screen when one of these sits in direct
// relationship with the trait - a bare "turned" describing a character turning
// around is physical movement, not a transformation. Matched at the word level
// so proximity between the verb and the trait can be measured.
const TRANSFORMATION_VERBS = new Set([
  'turned',
  'turns',
  'turning',
  'became',
  'becomes',
  'becoming',
  'changed',
  'changes',
  'changing',
  'transformed',
  'transforms',
  'transforming',
  'mutated',
  'mutates',
  'mutating',
  'altered',
  'alters',
  'altering',
  'healed',
  'heals',
  'healing',
  'dyed',
  'dyeing',
  'redyed',
  'disguised',
  'disguises',
  'disguise',
  'severed',
  'severs',
  'sever',
  'cursed',
  'curses',
  'curse',
  'enchanted',
  'enchants',
  'polymorphed',
  'polymorph',
  'regrew',
  'regrown',
  'regrow',
  'shifted',
  'shifts',
  'shifting',
  // State-change markers ("now black", "no longer blind").
  'now',
  'longer',
  'anymore',
  'formerly',
  'recovered',
  'recovers',
]);

// Words that may sit between a transformation verb and the trait it affects
// without breaking the link: determiners, possessives, pronouns, and light
// prepositions/auxiliaries. A conjunction ("and") or an unrelated content word
// between the two means the verb is not acting on that trait.
const TRAIT_LINKER_WORDS = new Set([
  'the',
  'a',
  'an',
  'her',
  'his',
  'their',
  'its',
  'my',
  'your',
  'our',
  'him',
  'them',
  'it',
  'us',
  'me',
  'to',
  'into',
  'from',
  'of',
  'was',
  'were',
  'is',
  'are',
  'be',
  'been',
  'being',
  'had',
  'has',
  'have',
  // Possessive "s" after tokenization: "Elara's eyes" -> ["elara", "s", "eyes"].
  's',
]);

// Domain vocabulary of durable traits (body parts, colours, species, identity)
// a contradiction can be about. Only these count as "trait keywords", so a
// character's name or an arbitrary word from the fact cannot stand in for the
// trait and trip the proximity check.
const TRAIT_DOMAIN_KEYWORDS = new Set([
  'eye',
  'eyes',
  'hair',
  'arm',
  'arms',
  'leg',
  'legs',
  'hand',
  'hands',
  'head',
  'face',
  'skin',
  'scar',
  'scars',
  'limb',
  'limbs',
  'wing',
  'wings',
  'tail',
  'tails',
  'horn',
  'horns',
  'tusk',
  'tusks',
  'tooth',
  'teeth',
  'mouth',
  'nose',
  'ear',
  'ears',
  'neck',
  'back',
  'chest',
  'shoulder',
  'shoulders',
  'finger',
  'fingers',
  'toe',
  'toes',
  'voice',
  'beard',
  'freckles',
  'birthmark',
  'tattoo',
  'tattoos',
  'mark',
  'marks',
  'body',
  'frame',
  'build',
  'height',
  'weight',
  'age',
  'gender',
  'sex',
  'species',
  'race',
  'origin',
  'heritage',
  'lineage',
  'blood',
  'name',
  'elf',
  'elves',
  'dwarf',
  'dwarves',
  'human',
  'humans',
  'orc',
  'orcs',
  'vampire',
  'werewolf',
  'dragon',
  'demon',
  'angel',
  'god',
  'goddess',
  'spirit',
  'undead',
  'immortal',
  'mortal',
  'alive',
  'dead',
  'deceased',
  'blue',
  'green',
  'grey',
  'gray',
  'black',
  'white',
  'silver',
  'gold',
  'golden',
  'brown',
  'hazel',
  'violet',
  'purple',
  'red',
  'crimson',
  'amber',
  'emerald',
  'azure',
  'scarlet',
  'ruby',
  'sapphire',
  'teal',
  'cyan',
  'pink',
  'orange',
  'yellow',
  'blonde',
  'blond',
  'brunette',
  'ginger',
  'raven',
  'pale',
  'dark',
]);

// Concrete body/identity nouns a permanent trait can be about. Unlike
// TRAIT_DOMAIN_KEYWORDS (which also holds colours and species values), these are
// the specific attributes a transition sentence must actually mention before it
// can suppress a contradiction. An unrelated "[Narrator] The evening sky turned
// blue." mentions the colour "blue" but none of these nouns, so it can no longer
// stand in for a character's eyes or hair.
const ATTRIBUTE_NOUNS = new Set([
  'eye',
  'eyes',
  'hair',
  'skin',
  'arm',
  'arms',
  'leg',
  'legs',
  'hand',
  'hands',
  'head',
  'face',
  'scar',
  'scars',
  'limb',
  'limbs',
  'wing',
  'wings',
  'tail',
  'tails',
  'horn',
  'horns',
  'tusk',
  'tusks',
  'tooth',
  'teeth',
  'mouth',
  'nose',
  'ear',
  'ears',
  'neck',
  'back',
  'chest',
  'shoulder',
  'shoulders',
  'finger',
  'fingers',
  'toe',
  'toes',
  'voice',
  'beard',
  'freckles',
  'birthmark',
  'tattoo',
  'tattoos',
  'mark',
  'marks',
  'body',
  'frame',
  'build',
  'height',
  'weight',
  'age',
  'gender',
  'sex',
  'species',
  'race',
  'origin',
  'heritage',
  'lineage',
  'blood',
  'name',
]);

/** Maximum word gap between a transformation verb and its trait. */
const TRAIT_PROXIMITY_LIMIT = 5;

/**
 * Breaks text into lowercase word tokens for proximity matching.
 * @param {string} text
 * @returns {string[]}
 */
function tokenizeWords(text) {
  return normalize(text)
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Extracts the durable trait keywords an issue is about from its fact and
 * response quote. Stopwords and non-domain words (including character names)
 * are discarded so a transformation verb near an unrelated word cannot be
 * mistaken for a transformation of the trait.
 * @param {Object} issue
 * @returns {Set<string>}
 */
function issueTraitKeywords(issue) {
  const traits = new Set();
  for (const text of [issue?.fact, issue?.response_quote]) {
    for (const word of keywordSet(text)) {
      if (TRAIT_DOMAIN_KEYWORDS.has(word) && !TRANSFORMATION_VERBS.has(word)) {
        traits.add(word);
      }
    }
  }
  return traits;
}

/**
 * Extracts the concrete attribute nouns (body parts, species, identity words)
 * an issue is about from its fact and response quote. A transcript sentence must
 * mention one of these before it can be read as depicting a transition of the
 * trait - otherwise "the sky turned blue" would suppress an eye-colour issue.
 * @param {Object} issue
 * @returns {Set<string>}
 */
function issueAttributeNouns(issue) {
  const nouns = new Set();
  for (const text of [issue?.fact, issue?.response_quote]) {
    for (const word of keywordSet(text)) {
      if (ATTRIBUTE_NOUNS.has(word)) nouns.add(word);
    }
  }
  return nouns;
}

/**
 * Extracts likely character names from the issue's fact (capitalized tokens).
 * Used as a secondary gate so a sentence that names the character alongside the
 * trait ("Elara is now blue") can still count as a transition even when it does
 * not spell out the attribute noun itself.
 * @param {Object} issue
 * @returns {Set<string>}
 */
function issueSubjectNames(issue) {
  const names = new Set();
  const matches = String(issue?.fact ?? '').match(/\p{Lu}[\p{L}'’-]*/gu) ?? [];
  for (const match of matches) {
    names.add(match.replace(/['’]s$/i, '').toLowerCase());
  }
  return names;
}

const CATEGORY_SET = new Set(CONTINUITY_CATEGORIES);

// Generic non-answers that do not count as a substantive justification.
const PLACEHOLDER_REASONS = new Set([
  'n/a',
  'na',
  'none',
  'no',
  'unknown',
  'unclear',
  'not applicable',
  'not sure',
  '...',
]);

/**
 * Collapses whitespace and lowercases text so "verbatim" checks tolerate
 * formatting differences (line wrapping, case) without accepting paraphrases.
 * @param {string} text
 * @returns {string}
 */
function normalize(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Builds a transcript of the turns preceding an anchor message.
 *
 * The transcript is the ground truth the continuity checker reasons against -
 * it is what the story actually wrote, in order - while baseline notes are
 * known to lag behind. User turns are labelled [USER]; character turns use the
 * message's stored character name.
 *
 * @param {Array<{mes?: string, is_user?: boolean, is_system?: boolean, name?: string}>} chat
 * @param {number} endIdx - Exclusive end index (usually the anchor message index).
 * @param {number} [windowSize=6] - Maximum number of preceding messages to include.
 * @returns {string} Newline-separated transcript, or '' when nothing is available.
 */
export function buildRecentTranscript(chat, endIdx, windowSize = 6) {
  if (!Array.isArray(chat) || chat.length === 0) return '';

  const end = Number.isInteger(endIdx) ? Math.max(0, Math.min(endIdx, chat.length)) : chat.length;
  const size = Number.isInteger(windowSize) && windowSize > 0 ? windowSize : 6;
  const start = Math.max(0, end - size);

  const lines = [];
  for (let i = start; i < end; i++) {
    const message = chat[i];
    if (!message || message.is_system || typeof message.mes !== 'string' || !message.mes) continue;
    const speaker = message.is_user ? 'USER' : message.name || message.characterName || 'CHARACTER';
    lines.push(`[${speaker}] ${message.mes}`);
  }
  return lines.join('\n\n');
}

/**
 * Lightweight, stable, non-cryptographic hash of message text.
 *
 * Used to detect whether the message a continuity note was anchored to has
 * since been swiped, edited, or deleted. A changed hash invalidates the queued
 * note so it can never be applied to a rewritten turn.
 *
 * @param {string} str
 * @returns {string} Unsigned 32-bit hash as a hexadecimal string.
 */
export function hashText(str) {
  const text = String(str ?? '');
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    // hash * 33 ^ char (djb2-xor)
    hash = ((hash << 5) + hash) ^ text.charCodeAt(i);
  }
  return (hash >>> 0).toString(16);
}

/**
 * Splits text into sentence-ish fragments on sentence punctuation and newlines.
 * Used to isolate the clause surrounding a quoted trait so transformation
 * markers can be detected locally rather than across the whole response.
 * @param {string} text
 * @returns {string[]}
 */
function splitSentences(text) {
  return String(text ?? '')
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Returns true when the given sentence describes an active, on-screen
 * transformation of one of the issue's traits. The trait must appear in the
 * sentence AND a transformation verb must sit in direct relationship with it
 * (within a short proximity window, with only linkers or trait words between).
 *
 * This rejects physical movement ("Elara turned and her blue eyes met his") and
 * idioms ("she changed the subject") while still accepting genuine
 * transformations ("a spell turned her eyes crimson", "she dyed her hair",
 * "his leg was severed").
 * @param {string} sentence
 * @param {Set<string>} traitKeywords
 * @param {Set<string>} [subjectNames] - Character names from the issue fact.
 *   A possessive construction puts the owner's name between the verb and the
 *   trait ("turned Elara's eyes green"), so a valid subject name must count as
 *   a linker or that active transformation is missed.
 * @returns {boolean}
 */
function sentenceShowsTransformation(sentence, traitKeywords, subjectNames = null) {
  if (!sentence || !traitKeywords || traitKeywords.size === 0) return false;

  const words = tokenizeWords(sentence);
  if (words.length === 0) return false;

  const verbIndices = [];
  const traitIndices = [];
  words.forEach((word, index) => {
    if (TRANSFORMATION_VERBS.has(word)) verbIndices.push(index);
    if (traitKeywords.has(word)) traitIndices.push(index);
  });
  if (verbIndices.length === 0 || traitIndices.length === 0) return false;

  const names = subjectNames ?? new Set();

  for (const verbIndex of verbIndices) {
    for (const traitIndex of traitIndices) {
      const low = Math.min(verbIndex, traitIndex);
      const high = Math.max(verbIndex, traitIndex);
      if (high === low || high - low > TRAIT_PROXIMITY_LIMIT) continue;
      let linked = true;
      for (let i = low + 1; i < high; i++) {
        const between = words[i];
        if (TRAIT_LINKER_WORDS.has(between) || traitKeywords.has(between) || names.has(between)) {
          continue;
        }
        linked = false;
        break;
      }
      if (linked) return true;
    }
  }
  return false;
}

/**
 * Returns true when the recent transcript already depicts this same transition,
 * meaning the latest response is continuing an established story event rather
 * than introducing an unmotivated contradiction.
 *
 * Only substantive trait words count as links - stopwords like "her", "the", or
 * "was" are never enough. When the issue is about a specific attribute noun
 * (eyes, hair, leg, ...), the sentence MUST mention that noun before it can be
 * read as a transition of it. If no attribute noun is known, the fallback
 * requires the character's name alongside the trait keyword.
 * This stops an unrelated "[Narrator] The evening sky turned blue." - which
 * matches the colour "blue" and the verb "turned" - from suppressing an
 * eye-colour contradiction for "Elara has blue eyes", and stops a cloak or hair
 * change from standing in for an eye-colour change.
 * @param {string} recentTranscript
 * @param {Set<string>} traitKeywords
 * @param {string} quote - Raw response quote from the issue.
 * @param {Set<string>} [attributeNouns] - Body/identity nouns the issue is about.
 * @param {Set<string>} [subjectNames] - Character names mentioned in the issue fact.
 * @returns {boolean}
 */
function transcriptDepictsTransition(
  recentTranscript,
  traitKeywords,
  quote,
  attributeNouns,
  subjectNames,
) {
  if (!recentTranscript) return false;

  const normalizedTranscript = normalize(recentTranscript);
  const normalizedQuote = normalize(quote);
  if (normalizedQuote.length >= 3 && normalizedTranscript.includes(normalizedQuote)) {
    return true;
  }

  if (!traitKeywords || traitKeywords.size === 0) return false;

  const nouns = attributeNouns ?? new Set();
  const names = subjectNames ?? new Set();
  return splitSentences(recentTranscript).some((sentence) => {
    const words = tokenizeWords(sentence);
    // When the issue is about a specific attribute (eyes, hair, leg, ...), the
    // sentence MUST mention that attribute before it can be read as a
    // transition of it. A sentence about a cloak turning blue says nothing
    // about eyes, so it must never suppress an eye-colour contradiction.
    if (nouns.size > 0) {
      if (!words.some((word) => nouns.has(word))) return false;
    } else {
      // No attribute noun known - fall back to requiring the character's name
      // alongside the trait keyword.
      const mentionsSubjectTrait =
        names.size > 0 &&
        words.some((word) => names.has(word)) &&
        words.some((word) => traitKeywords.has(word));
      if (!mentionsSubjectTrait) return false;
    }
    return sentenceShowsTransformation(sentence, traitKeywords, names);
  });
}

/**
 * Validates a model-reported contradiction against the actual evidence.
 *
 * A contradiction is only accepted when ALL of the following hold:
 * - its category is one of the permanent categories
 * - it supplies a substantive why_not_progression explanation
 * - response_quote appears verbatim (normalized) in the latest response
 * - fact appears verbatim (normalized) in the baseline notes
 * - the quoted trait is not being actively transformed on-screen
 *
 * The final check rejects false positives where a permanent trait is described
 * differently because the story itself is changing it in-scene (a spell turned
 * her eyes crimson, she dyed her hair, his leg was severed, and so on). That is
 * progression, not a contradiction.
 *
 * Anything else is treated as unverifiable and dropped. This is the main guard
 * against the checker inventing drift that the transcript disproves.
 *
 * @param {Object} issue - Parsed contradiction object.
 * @param {string} latestText - The latest AI response text.
 * @param {string} factsText - The established-facts/baseline block.
 * @param {string} [recentTranscript=''] - The turns preceding the latest response.
 * @returns {boolean} True when the issue is safe to act on.
 */
export function validateIssue(issue, latestText, factsText, recentTranscript = '') {
  if (!issue || typeof issue !== 'object') return false;

  const category = String(issue.category ?? '')
    .trim()
    .toLowerCase();
  if (!CATEGORY_SET.has(category)) return false;

  const reason = String(issue.why_not_progression ?? '').trim();
  if (reason.length < 10 || PLACEHOLDER_REASONS.has(reason.toLowerCase())) return false;

  const quote = normalize(issue.response_quote);
  // A substantive quote is required: at least 5 characters, and not composed
  // solely of stopwords ("her", "the", "was"). Trivial quotes are not evidence
  // the response actually described the flagged trait.
  if (quote.length < 5) return false;
  const quoteWords = quote.split(/\s+/).filter(Boolean);
  if (quoteWords.length === 0 || quoteWords.every((w) => STOPWORDS.has(w))) return false;
  if (!normalize(latestText).includes(quote)) return false;

  const fact = normalize(issue.fact);
  if (fact.length < 3) return false;
  if (!normalize(factsText).includes(fact)) return false;

  // Reject active in-story transformations of THIS trait. Find the sentence in
  // the latest response that contains the quote and check whether it describes a
  // change to one of the issue's traits (not just any transformation word).
  // Subject names are allowed as linkers so possessive constructions such as
  // "turned Elara's eyes green" are recognised as active transformations.
  const traitKeywords = issueTraitKeywords(issue);
  const subjectNames = issueSubjectNames(issue);
  const containingSentence =
    splitSentences(latestText).find((sentence) => normalize(sentence).includes(quote)) ?? '';
  if (sentenceShowsTransformation(containingSentence, traitKeywords, subjectNames)) return false;

  // If the recent transcript already depicts this transition, it is progression.
  // The attribute-noun gate keeps an unrelated "sky turned blue" or "cloak
  // turned blue" sentence from suppressing a body/eye-colour contradiction.
  if (
    transcriptDepictsTransition(
      recentTranscript,
      traitKeywords,
      issue.response_quote,
      issueAttributeNouns(issue),
      subjectNames,
    )
  ) {
    return false;
  }

  return true;
}

/**
 * Builds a forward-only continuity note from validated issues.
 *
 * The note deliberately never asks the model to revoke, undo, or re-narrate a
 * past event. Everything already written in the conversation stands; the note
 * only suggests keeping permanent facts consistent going forward, and explicitly
 * tells the model to ignore it if the story legitimately changed them.
 *
 * @param {Array<Object|string>} issues - Validated issues (objects or plain facts).
 * @param {string} characterName - Responding character (reserved for framing).
 * @returns {string} The note text, or '' when there is nothing to note.
 */
export function buildForwardRepairNote(issues, characterName) {
  // Reserved for future per-character framing; the note itself is character-agnostic.
  void characterName;

  const facts = (Array.isArray(issues) ? issues : [])
    .map((issue) => (typeof issue === 'string' ? issue : issue?.fact))
    .map((fact) => String(fact ?? '').trim())
    .filter(Boolean);

  if (facts.length === 0) return '';

  const factList = facts.join('; ');
  return `[Continuity note, background only: earlier in the story it was established that ${factList}. Everything already written in this conversation has happened and stands. Do NOT retract, undo, or re-narrate any past event. Where it fits naturally, keep these facts consistent from now on. If the conversation has legitimately changed them, ignore this note.]`;
}

// ---- Durable continuity retcons ---------------------------------------------

/**
 * Default number of AI turns a durable retcon stays active before it is
 * auto-resolved as canon. Each AI turn decrements the remaining count.
 */
export const RETCON_TURNS = 5;

/**
 * Builds the injected continuity-note block from active durable retcons.
 *
 * Unlike the one-shot forward note, this is phrased as a standing reminder that
 * everything already written stands, so it can be safely re-injected across
 * several turns until the story has moved past the contradiction.
 *
 * @param {Array<Object|string>} retcons - Active retcons (objects or plain facts).
 * @returns {string} Injection text, or '' when there are no facts.
 */
export function buildDurableRetconNote(retcons) {
  const facts = (Array.isArray(retcons) ? retcons : [])
    .map((retcon) => (typeof retcon === 'string' ? retcon : retcon?.fact))
    .map((fact) => String(fact ?? '').trim())
    .filter(Boolean);

  if (facts.length === 0) return '';

  const factList = facts.join('; ');
  return `[Continuity notes: earlier in the story it was established that ${factList}. Everything already written in this conversation has happened and stands.]`;
}

/**
 * Decrements the remaining lifetime of every active durable retcon by one AI
 * turn and drops any that have reached zero (auto-resolved as canon).
 *
 * @param {Array<Object>} retcons
 * @returns {Array<Object>} A new array containing only retcons still active.
 */
export function advanceRetconLifetimes(retcons) {
  if (!Array.isArray(retcons)) return [];
  const survivors = [];
  for (const retcon of retcons) {
    if (!retcon || typeof retcon !== 'object') continue;
    const remaining = Number.isFinite(retcon.turns_remaining)
      ? retcon.turns_remaining
      : RETCON_TURNS;
    if (remaining - 1 > 0) {
      survivors.push({ ...retcon, turns_remaining: remaining - 1 });
    }
    // remaining <= 0 -> the retcon has served its purpose and is allowed to
    // expire; it drops out so it stops being injected.
  }
  return survivors;
}

/**
 * Removes retcons the user has implicitly accepted by echoing the flagged
 * quote in their own reply. When the user writes the changed state themselves,
 * it is canon and the retcon is moot.
 *
 * @param {Array<Object>} retcons
 * @param {string} userText - Text of the most recent user turn.
 * @returns {Array<Object>} Retcons that are still unresolved.
 */
export function invalidateAcceptedRetcons(retcons, userText) {
  if (!Array.isArray(retcons)) return [];
  const text = normalize(userText);
  if (!text) return retcons.slice();

  return retcons.filter((retcon) => {
    if (!retcon || typeof retcon !== 'object') return true;
    const quote = normalize(retcon.quote);
    if (quote.length < 3) return true;
    // The user has adopted the changed state - accept it as canon.
    return !text.includes(quote);
  });
}

// ---- Durable retcon state-following -----------------------------------------

// Articles/honorifics that can precede an entity name in a fact sentence.
const RETCON_ENTITY_TITLES = new Set([
  'the',
  'a',
  'an',
  'lady',
  'lord',
  'sir',
  'captain',
  'dr',
  'doctor',
  'king',
  'queen',
  'prince',
  'princess',
]);

// Body/injury vocabulary. When a retcon is about one of these AND the changed
// text describes a wound/loss, the character's `injuries` state card field is
// updated so the baseline follows the story.
const RETCON_INJURY_WORDS = new Set([
  'severed',
  'wounded',
  'injured',
  'injury',
  'amputated',
  'bleeding',
  'bled',
  'broken',
  'lost',
  'scar',
  'scarred',
  'crippled',
  'maimed',
  'burned',
  'burnt',
]);

const RETCON_BODY_WORDS = new Set([
  'leg',
  'legs',
  'arm',
  'arms',
  'hand',
  'hands',
  'eye',
  'eyes',
  'head',
  'face',
  'limb',
  'limbs',
  'wing',
  'wings',
  'tail',
  'tails',
  'horn',
  'horns',
  'tooth',
  'teeth',
  'mouth',
  'nose',
  'ear',
  'ears',
  'neck',
  'back',
  'chest',
  'shoulder',
  'shoulders',
  'finger',
  'fingers',
  'toe',
  'toes',
  'skin',
]);

const RETCON_OUTFIT_WORDS = new Set([
  'cloak',
  'outfit',
  'clothes',
  'clothing',
  'dress',
  'armor',
  'armour',
  'disguise',
  'disguised',
  'wearing',
  'wore',
  'costume',
  'uniform',
  'robe',
  'robes',
  'dyed',
  'hair',
  'beard',
]);

const RETCON_MOOD_WORDS = new Set([
  'mood',
  'angry',
  'calm',
  'afraid',
  'furious',
  'sad',
  'happy',
  'anxious',
  'terrified',
  'joyful',
  'grieving',
  'hopeful',
  'despair',
]);

const RETCON_LOCATION_WORDS = new Set([
  'location',
  'inside',
  'outside',
  'traveling',
  'travelling',
  'journey',
  'arrived',
  'left',
  'moved',
  'camp',
  'city',
  'village',
  'forest',
  'castle',
]);

const RETCON_GOAL_WORDS = new Set([
  'goal',
  'plan',
  'plans',
  'intends',
  'wants',
  'seeks',
  'quest',
  'mission',
  'objective',
]);

const RETCON_ITEM_WORDS = new Set([
  'carries',
  'carrying',
  'wields',
  'holding',
  'sword',
  'blade',
  'key',
  'weapon',
  'item',
  'relic',
  'ring',
  'amulet',
]);

/**
 * Returns the canonical fact text a resolved retcon should install as the new
 * baseline. Prefers an explicit `resolved_fact`, then the response quote that
 * contradicted the old baseline, then the old fact itself.
 *
 * @param {Object} retcon
 * @returns {string}
 */
export function getResolvedRetconFact(retcon) {
  if (!retcon || typeof retcon !== 'object') return '';
  const raw = retcon.resolved_fact || retcon.quote || retcon.fact || '';
  return String(raw).trim();
}

/**
 * Extracts the entity name a contradiction fact is about.
 *
 * Facts are written as prose ("Elara has silver eyes.", "The Silver Key is
 * broken."). The leading run of capitalised words - minus articles and titles -
 * is treated as the entity name. Returns '' when no name can be found.
 *
 * @param {string} fact
 * @returns {string}
 */
export function extractRetconEntityName(fact) {
  const tokens = String(fact ?? '').match(/[\p{L}][\p{L}'’-]*/gu) ?? [];
  const name = [];
  for (const rawToken of tokens) {
    if (!/^\p{Lu}/u.test(rawToken)) break;
    const token = rawToken.replace(/['’]s$/i, '');
    if (!token) continue;
    if (RETCON_ENTITY_TITLES.has(token.toLowerCase())) continue;
    name.push(token);
  }
  return name.join(' ');
}

/**
 * Infers a state-card update from a durable retcon.
 *
 * Returns null when the retcon does not describe a state-card attribute (for
 * example an eye-colour change, which the state-card schema does not model).
 * Resolution still supersedes the old long-term memory in that case.
 *
 * @param {Object} retcon
 * @returns {{name: string, type: string, fields: Object}|null}
 */
export function inferRetconStateUpdate(retcon) {
  if (!retcon || typeof retcon !== 'object') return null;
  const name = extractRetconEntityName(retcon.fact);
  if (!name) return null;

  const words = new Set([...keywordSet(retcon.fact), ...keywordSet(retcon.quote)]);
  const changedText = String(retcon.quote || retcon.resolved_fact || retcon.fact || '')
    .toLowerCase()
    .trim();
  if (!changedText) return null;

  const hasAny = (candidateSet) => [...words].some((word) => candidateSet.has(word));
  const injuryChange =
    hasAny(RETCON_INJURY_WORDS) ||
    /\b(severed|wounded|injured|amputated|bled|bleeding|broken)\b/.test(changedText);

  let field = null;
  if (injuryChange && (hasAny(RETCON_BODY_WORDS) || hasAny(RETCON_INJURY_WORDS))) {
    field = 'injuries';
  } else if (hasAny(RETCON_OUTFIT_WORDS)) {
    field = 'outfit_disguise';
  } else if (hasAny(RETCON_MOOD_WORDS)) {
    field = 'mood';
  } else if (hasAny(RETCON_LOCATION_WORDS)) {
    field = 'location';
  } else if (hasAny(RETCON_GOAL_WORDS)) {
    field = 'active_goal';
  } else if (hasAny(RETCON_ITEM_WORDS)) {
    field = 'carried_items';
  }

  if (!field) return null;

  const value = changedText
    .replace(/^(?:her|his|their|its|my|your|our|the|a|an)\s+/i, '')
    .replace(/[.;,\s]+$/, '')
    .trim();
  if (!value) return null;

  return { name, type: 'character', fields: { [field]: value } };
}

/**
 * Parses the continuity checker's strict-JSON response.
 *
 * Tolerates markdown code fences and leading/trailing prose by extracting the
 * outermost JSON object. Returns only object entries from the contradictions
 * array; malformed input yields an empty array so a bad response can never
 * produce a repair.
 *
 * @param {string} response - Raw model response.
 * @returns {Array<Object>} Parsed contradiction objects.
 */
export function parseContinuityJson(response) {
  if (!response) return [];

  let text = String(response).trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) text = fenced[1].trim();

  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last > first) text = text.slice(first, last + 1);

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }

  let list = parsed;
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    list = parsed.contradictions ?? parsed.issues ?? [];
  }
  if (!Array.isArray(list)) return [];
  return list.filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry));
}

/**
 * Checks whether a queued repair is still anchored to an unchanged message.
 *
 * The anchor is the last AI message that existed when the continuity check ran.
 * The note is only valid while the conversation is still poised to apply it:
 * - the anchor must still be an AI message at its recorded index
 * - its text hash must still match (not swiped, edited, or deleted)
 * - no later AI turn may exist yet - once another response was generated, the
 *   note is stale and would be applied to a branch it was never written for
 * - at most one non-system message (the immediate pending user turn) may follow
 * - if the pending user turn already contains the flagged quote (or otherwise
 *   advances the changed state), the user has made the change canon and the
 *   repair note must not fire - it is moot.
 *
 * @param {Array<{mes?: string, is_user?: boolean, is_system?: boolean}>} chat
 * @param {{anchorIdx?: number, anchorHash?: string, quotes?: string[]}|null} pendingRepair
 * @returns {boolean}
 */
export function isPendingRepairAnchorValid(chat, pendingRepair) {
  if (!pendingRepair || typeof pendingRepair !== 'object') return false;
  if (!Array.isArray(chat)) return false;

  const idx = pendingRepair.anchorIdx;
  if (!Number.isInteger(idx) || idx < 0 || idx >= chat.length) return false;

  const anchor = chat[idx];
  if (!anchor || typeof anchor.mes !== 'string') return false;
  // The anchor must be an assistant turn - a repair note is anchored on the AI
  // response that triggered it.
  if (anchor.is_user || anchor.is_system) return false;

  if (hashText(anchor.mes) !== pendingRepair.anchorHash) return false;

  const trailing = chat.slice(idx + 1);
  // Another AI turn was generated after the anchor: the note is stale.
  if (trailing.some((m) => m && !m.is_user && !m.is_system)) return false;
  // Only the immediate pending user turn may follow the anchor.
  if (trailing.filter((m) => m && !m.is_system).length > 1) return false;

  // If the user has already replied and their reply carries the flagged quote,
  // they have embraced the changed state - the change is canon and the repair
  // note is moot.
  const quotes = Array.isArray(pendingRepair.quotes) ? pendingRepair.quotes : [];
  if (quotes.length > 0) {
    const userTurns = trailing.filter((m) => m && m.is_user && typeof m.mes === 'string');
    const embracesChange = userTurns.some((m) => {
      const userText = normalize(m.mes);
      return quotes.some((q) => {
        const quote = normalize(q);
        return quote.length >= 3 && userText.includes(quote);
      });
    });
    if (embracesChange) return false;
  }

  return true;
}
