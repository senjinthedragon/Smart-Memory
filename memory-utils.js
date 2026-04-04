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
 * Shared utility helpers for memory retention and consolidation.
 *
 * trimByPriority        - trims a memory array to a cap, keeping high-importance and newer entries
 * reconcileTypeEntries  - merges promoted consolidation entries into a base, replacing overlapping originals
 */

/**
 * Trims a memory array to at most `max` entries, preferring to keep
 * high-importance and newer entries when dropping.
 *
 * Returns a new array; does not mutate the input.
 *
 * @param {Array<{importance?: number, ts: number}>} memories
 * @param {number} max
 * @returns {Array}
 */
export function trimByPriority(memories, max) {
  if (memories.length <= max) return memories;
  return [...memories]
    .sort((a, b) => {
      const ia = a.importance ?? 2;
      const ib = b.importance ?? 2;
      if (ia !== ib) return ib - ia; // higher importance first
      return b.ts - a.ts; // newer first within same importance
    })
    .slice(0, max);
}

/**
 * Reconciles a set of promoted consolidation entries against an existing base.
 *
 * When the model outputs an enriched or updated version of a base entry (e.g.
 * "We are married. Happily." as a follow-up to "We are married."), we want to
 * replace the original rather than append alongside it. This function uses
 * Jaccard word-overlap to detect when a promoted entry substantially overlaps
 * with a base entry of the same type - if it does, the base entry is replaced
 * in-place. Genuinely new entries are appended.
 *
 * @param {Array<{type: string, content: string}>} base - Stable consolidated entries for one type.
 * @param {Array<{type: string, content: string}>} promoted - Entries output by consolidation for the same type.
 * @param {number} threshold - Jaccard overlap threshold above which a promoted entry replaces a base entry.
 * @returns {Array} The reconciled array (new array, base is not mutated).
 */
export function reconcileTypeEntries(base, promoted, threshold) {
  const reconciled = [...base];
  for (const mem of promoted) {
    const memWords = new Set(mem.content.toLowerCase().split(/\s+/));
    const idx = reconciled.findIndex((ex) => {
      if (ex.type !== mem.type) return false;
      const exWords = new Set(ex.content.toLowerCase().split(/\s+/));
      const intersection = [...memWords].filter((w) => exWords.has(w)).length;
      const union = new Set([...memWords, ...exWords]).size;
      return union > 0 && intersection / union > threshold;
    });
    if (idx >= 0) {
      reconciled[idx] = mem;
    } else {
      reconciled.push(mem);
    }
  }
  return reconciled;
}
