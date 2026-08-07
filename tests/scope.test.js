import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MEMORY_SCOPE_CHARACTER,
  MEMORY_SCOPE_CHAT,
  CHARACTER_TIER_KEYS,
  containerHasData,
  getScopedContainer,
  deleteScopedContainer,
  seedScopedContainer,
  pinChatScope,
  unpinChatScope,
  resolveChatScopeId,
} from '../scope-core.js';

const SCHEMA = 42;

test('character scope returns the top-level container', () => {
  const store = {};
  const container = getScopedContainer(store, 'Yuki', '7', MEMORY_SCOPE_CHARACTER, SCHEMA);
  container.memories = [{ type: 'fact', content: 'x' }];
  assert.equal(store.Yuki.memories.length, 1);
  assert.equal(store.Yuki.chats, undefined);
});

test('chat scope nests containers per chat and isolates them', () => {
  const store = {};
  const chatA = getScopedContainer(store, 'Yuki', '7', MEMORY_SCOPE_CHAT, SCHEMA);
  const chatB = getScopedContainer(store, 'Yuki', '9', MEMORY_SCOPE_CHAT, SCHEMA);
  chatA.memories = [{ type: 'fact', content: 'from chat A' }];
  chatB.memories = [{ type: 'fact', content: 'from chat B' }];

  assert.equal(store.Yuki.chats['7'].memories[0].content, 'from chat A');
  assert.equal(store.Yuki.chats['9'].memories[0].content, 'from chat B');
  assert.equal(store.Yuki.memories, undefined, 'character-level store stays untouched');
});

test('chat scope falls back to the base container when chat id is null', () => {
  const store = {};
  const container = getScopedContainer(store, 'Yuki', null, MEMORY_SCOPE_CHAT, SCHEMA);
  container.canon = { text: 'shared' };
  assert.equal(store.Yuki.canon.text, 'shared');
  assert.equal(store.Yuki.chats, undefined);
});

test('new chat containers are stamped with the schema version', () => {
  const store = {};
  getScopedContainer(store, 'Yuki', '7', MEMORY_SCOPE_CHAT, SCHEMA);
  assert.equal(store.Yuki.chats['7'].schema_version, SCHEMA);
});

test('existing chat containers are not re-stamped', () => {
  const store = {};
  store.Yuki = { chats: { '7': { schema_version: 3, memories: [] } } };
  const container = getScopedContainer(store, 'Yuki', '7', MEMORY_SCOPE_CHAT, SCHEMA);
  assert.equal(container.schema_version, 3);
});

test('delete in chat scope removes only the current chat container', () => {
  const store = {};
  const chatA = getScopedContainer(store, 'Yuki', '7', MEMORY_SCOPE_CHAT, SCHEMA);
  chatA.memories = [{ type: 'fact', content: 'a' }];
  const chatB = getScopedContainer(store, 'Yuki', '9', MEMORY_SCOPE_CHAT, SCHEMA);
  chatB.memories = [{ type: 'fact', content: 'b' }];
  store.Yuki.canon = { text: 'keep me' };

  deleteScopedContainer(store, 'Yuki', '7', MEMORY_SCOPE_CHAT);

  assert.equal(store.Yuki.chats['7'], undefined);
  assert.equal(store.Yuki.chats['9'].memories[0].content, 'b');
  assert.equal(store.Yuki.canon.text, 'keep me', 'character-level data survives chat deletion');
});

test('delete in chat scope cleans up an emptied chats map', () => {
  const store = {};
  getScopedContainer(store, 'Yuki', '7', MEMORY_SCOPE_CHAT, SCHEMA);
  deleteScopedContainer(store, 'Yuki', '7', MEMORY_SCOPE_CHAT);
  assert.equal(store.Yuki.chats, undefined);
});

test('delete in character scope removes the whole entry (upstream behaviour)', () => {
  const store = { Yuki: { memories: [], chats: { '7': {} } } };
  deleteScopedContainer(store, 'Yuki', '7', MEMORY_SCOPE_CHARACTER);
  assert.equal(store.Yuki, undefined);
});

test('containerHasData distinguishes empty from populated containers', () => {
  assert.equal(containerHasData({}), false);
  assert.equal(containerHasData({ memories: [] }), false);
  assert.equal(containerHasData({ relationship_history: {} }), false);
  assert.equal(containerHasData({ memories: [{ type: 'fact', content: 'x' }] }), true);
  assert.equal(containerHasData({ canon: { text: 'x' } }), true);
  assert.equal(containerHasData({ entities: [{ id: '1', name: 'Yuki' }] }), true);
  assert.equal(containerHasData(null), false);
});

test('seed copies tier data from the base into the chat container', () => {
  const store = {
    Yuki: {
      memories: [{ type: 'fact', content: 'old fact' }],
      canon: { text: 'old canon' },
      entities: [{ id: 'e1', name: 'Yuki' }],
    },
  };
  const seeded = seedScopedContainer(store, 'Yuki', '7', SCHEMA, CHARACTER_TIER_KEYS);
  assert.equal(seeded, true);
  assert.equal(store.Yuki.chats['7'].memories[0].content, 'old fact');
  assert.equal(store.Yuki.chats['7'].canon.text, 'old canon');
  assert.equal(store.Yuki.chats['7'].entities[0].id, 'e1');
  assert.equal(store.Yuki.chats['7'].schema_version, SCHEMA);
});

test('seed deep-copies so later mutations do not touch the base', () => {
  const store = { Yuki: { memories: [{ type: 'fact', content: 'shared' }] } };
  seedScopedContainer(store, 'Yuki', '7', SCHEMA, CHARACTER_TIER_KEYS);
  store.Yuki.chats['7'].memories[0].content = 'mutated';
  assert.equal(store.Yuki.memories[0].content, 'shared');
});

test('seed is a no-op when the chat container already has data', () => {
  const store = {
    Yuki: {
      memories: [{ type: 'fact', content: 'base' }],
      chats: { '7': { memories: [{ type: 'fact', content: 'existing chat memory' }] } },
    },
  };
  const seeded = seedScopedContainer(store, 'Yuki', '7', SCHEMA, CHARACTER_TIER_KEYS);
  assert.equal(seeded, false);
  assert.equal(store.Yuki.chats['7'].memories[0].content, 'existing chat memory');
});

test('seed copies only the requested keys', () => {
  const store = { Yuki: { memories: [{ type: 'fact', content: 'x' }], canon: { text: 'c' } } };
  seedScopedContainer(store, 'Yuki', '7', SCHEMA, ['memories']);
  assert.equal(store.Yuki.chats['7'].memories.length, 1);
  assert.equal(store.Yuki.chats['7'].canon, undefined);
});

test('resolveChatScopeId returns the live chat id when nothing is pinned', () => {
  assert.equal(resolveChatScopeId('7'), '7');
  assert.equal(resolveChatScopeId(7), '7');
  assert.equal(resolveChatScopeId(null), null);
  assert.equal(resolveChatScopeId(undefined), null);
});

test('pin overrides the live chat id for the job duration', () => {
  pinChatScope('job-chat');
  try {
    assert.equal(resolveChatScopeId('other-chat'), 'job-chat');
  } finally {
    unpinChatScope();
  }
  assert.equal(resolveChatScopeId('other-chat'), 'other-chat', 'pin released after unpin');
});

test('nested pins keep the outer job-origin chat id', () => {
  pinChatScope('outer-chat');
  pinChatScope('inner-chat');
  try {
    assert.equal(resolveChatScopeId('live'), 'outer-chat');
  } finally {
    unpinChatScope();
    assert.equal(resolveChatScopeId('live'), 'outer-chat', 'inner unpin does not release outer');
    unpinChatScope();
  }
  assert.equal(resolveChatScopeId('live'), 'live');
});

test('unpin beyond depth is safe and stays unpinned', () => {
  pinChatScope('a');
  unpinChatScope();
  unpinChatScope();
  unpinChatScope();
  assert.equal(resolveChatScopeId('b'), 'b');
});

test('a null pin falls back to the live chat id', () => {
  pinChatScope(null);
  try {
    assert.equal(resolveChatScopeId('live'), 'live');
  } finally {
    unpinChatScope();
  }
});
