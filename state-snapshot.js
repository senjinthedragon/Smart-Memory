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
 * Message-anchored state snapshots for rollback-safe rollback on swipe/delete.
 *
 * Every extraction/state-update pass records a snapshot of the chat-scoped
 * mutable state (state ledger, story arcs, perspectives/secrets, and durable
 * continuity retcons) tagged with the chat message index it was captured at.
 * When a message is swiped or deleted, the state is rolled back to the latest
 * snapshot at or before the removed turn, so facts, state cards, arcs, and
 * secrets from a discarded branch NEVER survive.
 *
 * This module is intentionally free of the SillyTavern runtime so it can be
 * unit-tested under plain Node. The context-bound wrappers
 * (`takeStateSnapshot` / `rollbackStateToSnapshot`) live in state-ledger.js,
 * which already imports the SillyTavern context and calls into these helpers.
 *
 * takeSnapshotOnMeta          - captures a snapshot into a chatMetadata block (mutating)
 * rollbackSnapshotOnMeta      - restores + prunes snapshots for a metadata block (mutating)
 * findSnapshotIndexForRollback - index of the latest snapshot at or before a target turn
 * MAX_STATE_SNAPSHOTS         - maximum number of snapshots retained
 */

/** Maximum number of state snapshots kept per chat (oldest dropped first). */
export const MAX_STATE_SNAPSHOTS = 20;

/**
 * Deep-clones a snapshot payload. Uses structuredClone when the host provides it
 * (browsers, Node 17+) and falls back to JSON cloning otherwise.
 *
 * @param {*} value
 * @returns {*}
 */
function clone(value) {
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(value);
    } catch {
      // Fall through to JSON cloning for values structuredClone cannot handle.
    }
  }
  if (value === undefined || value === null) return value;
  return JSON.parse(JSON.stringify(value));
}

/**
 * Returns the index of the latest snapshot with `msg_index <= targetMsgIndex`,
 * or -1 when no snapshot qualifies.
 *
 * @param {Array<{msg_index: number}>} snapshots
 * @param {number} targetMsgIndex
 * @returns {number}
 */
export function findSnapshotIndexForRollback(snapshots, targetMsgIndex) {
  if (!Array.isArray(snapshots)) return -1;
  const target = Number.isFinite(targetMsgIndex) ? targetMsgIndex : -1;
  let bestIndex = -1;
  let bestMsg = -Infinity;
  for (let i = 0; i < snapshots.length; i++) {
    const snapshot = snapshots[i];
    if (!snapshot || !Number.isInteger(snapshot.msg_index)) continue;
    if (snapshot.msg_index <= target && snapshot.msg_index > bestMsg) {
      bestMsg = snapshot.msg_index;
      bestIndex = i;
    }
  }
  return bestIndex;
}

/**
 * Captures a snapshot of the mutable chat state into a chatMetadata block.
 *
 * The snapshot is tagged with `msg_index` (the highest chat index whose facts
 * are fully reflected in the captured state). Re-capturing the same index
 * replaces the existing snapshot so repeated passes stay idempotent. At most
 * MAX_STATE_SNAPSHOTS snapshots are retained; the oldest are dropped first.
 *
 * @param {Object} meta - The chatMetadata[META_KEY] object (mutated in place).
 * @param {number} msgIndex - Chat message index this snapshot represents.
 * @returns {Object|null} The recorded snapshot, or null when meta is invalid.
 */
export function takeSnapshotOnMeta(meta, msgIndex) {
  if (!meta || typeof meta !== 'object') return null;
  if (!Number.isInteger(msgIndex)) return null;

  if (!Array.isArray(meta.state_snapshots)) meta.state_snapshots = [];

  const snapshot = {
    msg_index: msgIndex,
    state_ledger: clone(meta.state_ledger ?? {}),
    storyArcs: clone(meta.storyArcs ?? []),
    epistemic: clone(meta.epistemic_knowledge ?? []),
    durable_retcons: clone(meta.durable_retcons ?? []),
  };

  const existing = meta.state_snapshots.findIndex((s) => s && s.msg_index === msgIndex);
  if (existing !== -1) {
    meta.state_snapshots[existing] = snapshot;
  } else {
    meta.state_snapshots.push(snapshot);
  }

  // Keep chronological order so pruning the tail is dropping the newest.
  meta.state_snapshots.sort((a, b) => a.msg_index - b.msg_index);
  while (meta.state_snapshots.length > MAX_STATE_SNAPSHOTS) {
    meta.state_snapshots.shift();
  }

  return snapshot;
}

/**
 * Rolls the mutable chat state back to the latest snapshot at or before
 * `targetMsgIndex`, then prunes every snapshot after it.
 *
 * When no snapshot qualifies (nothing was committed before the target turn),
 * the tracked state is reset to empty so a swipe of the very first tracked
 * turn cannot leave that turn's facts behind.
 *
 * @param {Object} meta - The chatMetadata[META_KEY] object (mutated in place).
 * @param {number} targetMsgIndex - Highest chat index whose state should survive.
 * @returns {Object|null} The snapshot that was restored, or null when reset/empty.
 */
export function rollbackSnapshotOnMeta(meta, targetMsgIndex) {
  if (!meta || typeof meta !== 'object') return null;

  const snapshots = Array.isArray(meta.state_snapshots) ? meta.state_snapshots : [];
  const index = findSnapshotIndexForRollback(snapshots, targetMsgIndex);

  if (index === -1) {
    // No baseline for this target - roll the whole tracked state back to empty.
    meta.state_ledger = {};
    meta.storyArcs = [];
    meta.epistemic_knowledge = [];
    meta.durable_retcons = [];
    meta.state_snapshots = [];
    return null;
  }

  const snapshot = snapshots[index];
  meta.state_ledger = clone(snapshot.state_ledger ?? {});
  meta.storyArcs = clone(snapshot.storyArcs ?? []);
  meta.epistemic_knowledge = clone(snapshot.epistemic ?? []);
  meta.durable_retcons = clone(snapshot.durable_retcons ?? []);

  // Drop every snapshot that represents a turn after the rollback target.
  meta.state_snapshots = snapshots.filter(
    (s) => s && Number.isInteger(s.msg_index) && s.msg_index <= targetMsgIndex,
  );

  return snapshot;
}
