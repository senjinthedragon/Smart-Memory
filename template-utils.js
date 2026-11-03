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
 * Safe template placeholder substitution.
 *
 * `String.prototype.replace` interprets `$&`, `$1`, `$50`, `$$`, and similar
 * patterns inside the replacement string. Roleplay and memory text is arbitrary
 * user/model content, so a memory like "owes a $100 bounty" could otherwise be
 * mangled (or throw on `$<name>`). Passing a replacer function disables pattern
 * interpretation and inserts the value literally.
 *
 * @param {string} template - Prompt template containing the placeholder.
 * @param {string} placeholder - Exact placeholder token, e.g. '{{memories}}'.
 * @param {*} value - Dynamic text to insert (coerced to string).
 * @returns {string} The template with the first placeholder occurrence replaced.
 */
export function replaceTemplate(template, placeholder, value) {
  if (typeof template !== 'string') return '';
  const text = value == null ? '' : String(value);
  return template.replace(placeholder, () => text);
}