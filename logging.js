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
 * Verbose logging utility. Operational console.log calls across all modules
 * route through smLog so they can be silenced without touching the callsites.
 *
 * smLog - drops args when verbose_logging is off; behaves like console.log when on
 */

import { extension_settings } from '../../../extensions.js';
import { MODULE_NAME } from './constants.js';

/**
 * Logs args to the console only when verbose_logging is enabled in settings.
 * All operational extraction/consolidation/migration progress messages should
 * use this instead of console.log. Errors (console.error) are always shown.
 * @param {...*} args - Forwarded directly to console.log.
 */
export function smLog(...args) {
  if (extension_settings[MODULE_NAME]?.verbose_logging) {
    console.log(...args);
  }
}
