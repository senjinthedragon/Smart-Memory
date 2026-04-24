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
 * Memory graph visualization: force-directed canvas rendering of entities and memories.
 *
 * showMemoryGraph - opens the full-screen graph overlay for a given character
 */

import { loadCharacterMemories } from './longterm.js';
import { loadSessionMemories } from './session.js';
import { loadCharacterEntityRegistry, loadSessionEntityRegistry } from './graph-migration.js';

// ---- Visual constants -------------------------------------------------------

// Entity type colors (kept in sync with CSS badge definitions in style.css).
const ENTITY_COLORS = {
  character: '#7ecfff',
  place: '#a8d88f',
  object: '#d4b97a',
  faction: '#c49de8',
  concept: '#f0a0a0',
  unknown: '#999999',
};

// Memory type colors (kept in sync with CSS badge definitions in style.css).
const MEMORY_COLORS = {
  fact: '#4a6fa5',
  relationship: '#8e5a8e',
  preference: '#5a8e5a',
  event: '#8e6e3a',
  scene: '#5a8e7a',
  revelation: '#8e5a5a',
  development: '#7a7a3a',
  detail: '#3a7a8e',
};

const ENTITY_RADIUS = 32;
// Memory node radii by importance level (1/2/3).
// Wide ratio so tiers read clearly on large screens.
const MEMORY_RADII = [7, 13, 21];

// ---- Force simulation constants ---------------------------------------------

const REPULSION_K = 3500; // Coulomb-like repulsion strength
const SPRING_K = 0.05; // Hooke's law spring stiffness
const SPRING_REST_EM = 140; // entity-memory edge rest length
const SPRING_REST_MM = 55; // memory-memory (supersedes) rest length
const DAMPING = 0.86; // velocity multiplied by this each tick
const GRAVITY_K = 0.012; // pull toward world origin (0,0)
const ALPHA_DECAY = 0.992; // simulation cools by this factor each tick
const ALPHA_MIN = 0.004; // stop when alpha falls below this
const MAX_MEMORIES = 100; // max memory nodes rendered (top by importance)

// ---- Module state -----------------------------------------------------------

// All state lives here and is reset on close so there are no leaks.
let gs = null; // active graph state, null when closed

// ---- Public API -------------------------------------------------------------

/**
 * Opens the memory graph overlay for a character.
 * If the overlay is already open it is closed first.
 * @param {string|null} characterName - Active character name for long-term lookups.
 */
export function showMemoryGraph(characterName) {
  if (gs) closeGraph();

  const opts = { showSession: true, showRetired: false };
  const { nodes, edges } = buildGraph(characterName, opts);

  if (nodes.length === 0) {
    // Show a brief inline message rather than opening an empty graph.
    const $panel = $('#sm_entity_panel');
    const $msg = $(
      '<div class="sm-muted" style="padding:6px 0">No entities or memories to display yet.</div>',
    );
    $panel.prepend($msg);
    setTimeout(() => $msg.remove(), 3000);
    return;
  }

  const $overlay = $(buildOverlayHTML(characterName));
  $('body').append($overlay);

  const canvas = document.getElementById('sm_graph_canvas');
  const ctx = canvas.getContext('2d');
  fitCanvas(canvas);

  initPositions(nodes, edges);

  gs = {
    nodes,
    edges,
    canvas,
    ctx,
    characterName,
    opts,
    // Camera: pan offset (world units) and zoom scale.
    camera: { x: 0, y: 0, scale: 1 },
    // Interaction state.
    dragging: null, // { node, offsetX, offsetY }
    hovered: null, // node or null
    selected: null, // node or null
    mouseWorld: { x: 0, y: 0 },
    // Animation.
    alpha: 1.0,
    rafId: null,
    // Pan state.
    panning: false,
    panStart: null,
    cameraAtPanStart: null,
  };

  bindEvents(canvas, $overlay, characterName);

  // Run the simulation briefly to get an initial settled layout, then
  // auto-fit the camera so the graph fills the canvas on any screen size.
  for (let i = 0; i < 120; i++) tick();
  fitCameraToNodes();

  scheduleFrame();
}

// ---- Graph data builder -----------------------------------------------------

/**
 * Builds the nodes and edges arrays from stored memory data.
 * @param {string|null} characterName
 * @param {{ showSession: boolean, showRetired: boolean }} opts
 * @returns {{ nodes: object[], edges: object[] }}
 */
function buildGraph(characterName, opts) {
  const nodes = [];
  const edges = [];
  const nodeById = new Map();

  // ---- Entity nodes ----
  const ltEntities = characterName ? loadCharacterEntityRegistry(characterName) : [];
  const sessionEntities = opts.showSession ? loadSessionEntityRegistry() : [];

  // Deduplicate by name|type (same merging strategy as the entity panel).
  const entityByKey = new Map();
  for (const e of [...ltEntities, ...sessionEntities]) {
    const key = `${e.name.toLowerCase().trim()}|${e.type ?? 'unknown'}`;
    if (!entityByKey.has(key)) entityByKey.set(key, e);
  }

  for (const entity of entityByKey.values()) {
    const node = {
      id: entity.id,
      nodeType: 'entity',
      label: entity.name,
      detail: `${entity.type}`,
      subtype: entity.type ?? 'unknown',
      color: ENTITY_COLORS[entity.type] ?? ENTITY_COLORS.unknown,
      radius: ENTITY_RADIUS,
      memoryIds: new Set(entity.memory_ids ?? []),
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      fixed: false,
    };
    nodes.push(node);
    nodeById.set(entity.id, node);
  }

  // ---- Memory nodes ----
  const ltMems = characterName ? loadCharacterMemories(characterName) : [];
  const sessionMems = opts.showSession ? loadSessionMemories() : [];
  const allMems = [...ltMems, ...sessionMems];

  const filtered = opts.showRetired ? allMems : allMems.filter((m) => !m.superseded_by);
  // Keep top MAX_MEMORIES by importance, then recency.
  const sorted = [...filtered].sort(
    (a, b) => (b.importance ?? 1) - (a.importance ?? 1) || (b.ts ?? 0) - (a.ts ?? 0),
  );
  const visible = sorted.slice(0, MAX_MEMORIES);
  const visibleIds = new Set(visible.map((m) => m.id));

  for (const mem of visible) {
    const r = MEMORY_RADII[(mem.importance ?? 1) - 1] ?? MEMORY_RADII[0];
    const node = {
      id: mem.id,
      nodeType: 'memory',
      label: '',
      // Truncate for tooltip.
      detail: mem.content?.length > 200 ? mem.content.slice(0, 197) + '...' : (mem.content ?? ''),
      subtype: mem.type ?? 'fact',
      color: MEMORY_COLORS[mem.type] ?? '#666',
      radius: r,
      retired: Boolean(mem.superseded_by),
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      fixed: false,
    };
    nodes.push(node);
    nodeById.set(mem.id, node);
  }

  // ---- Edges ----
  // Entity -> memory links.
  for (const node of nodes) {
    if (node.nodeType !== 'entity') continue;
    for (const memId of node.memoryIds) {
      if (visibleIds.has(memId) && nodeById.has(memId)) {
        edges.push({ source: node.id, target: memId, edgeType: 'link' });
      }
    }
  }

  // Memory supersedes chains.
  for (const mem of visible) {
    if (!Array.isArray(mem.supersedes)) continue;
    for (const oldId of mem.supersedes) {
      if (visibleIds.has(oldId) && nodeById.has(oldId)) {
        edges.push({ source: oldId, target: mem.id, edgeType: 'supersedes' });
      }
    }
  }

  return { nodes, edges };
}

/**
 * Places nodes at reasonable starting positions so the simulation converges quickly.
 * Entities are arranged in a circle; memories near their first linked entity.
 * @param {object[]} nodes
 * @param {object[]} edges
 */
function initPositions(nodes, edges) {
  const entities = nodes.filter((n) => n.nodeType === 'entity');
  const memories = nodes.filter((n) => n.nodeType === 'memory');

  // Entities: evenly spaced on a circle, radius scales with count.
  const er = Math.max(180, entities.length * 40);
  entities.forEach((e, i) => {
    const angle = (2 * Math.PI * i) / Math.max(entities.length, 1) - Math.PI / 2;
    e.x = Math.cos(angle) * er;
    e.y = Math.sin(angle) * er;
  });

  // Build a quick lookup: memId -> first entity that links to it.
  const memAnchor = new Map();
  for (const edge of edges) {
    if (edge.edgeType !== 'link') continue;
    if (!memAnchor.has(edge.target)) {
      const entityNode = nodes.find((n) => n.id === edge.source);
      if (entityNode) memAnchor.set(edge.target, entityNode);
    }
  }

  // Memories: jitter near anchor entity, or random near origin if unlinked.
  for (const mem of memories) {
    const anchor = memAnchor.get(mem.id);
    const cx = anchor ? anchor.x : 0;
    const cy = anchor ? anchor.y : 0;
    const spread = anchor ? 70 : 200;
    mem.x = cx + (Math.random() - 0.5) * spread;
    mem.y = cy + (Math.random() - 0.5) * spread;
  }
}

// ---- Force simulation -------------------------------------------------------

/**
 * Advances the simulation by one tick. Applies repulsion, spring forces,
 * gravity, and integrates velocity. Cools alpha each tick.
 */
function tick() {
  const { nodes, edges, alpha } = gs;
  const n = nodes.length;

  // Repulsion between all pairs (O(n²) - fine for n <= ~150).
  // Effective distance is floored at the sum of both radii + padding so the
  // repulsion force always separates circles regardless of their sizes.
  const NODE_GAP = 14; // minimum gap between node edges in world units
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = nodes[i];
      const b = nodes[j];
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const minDist = a.radius + b.radius + NODE_GAP;
      const effectiveDist = Math.max(dist, minDist * 0.5); // soft floor
      const force = (REPULSION_K * alpha) / (effectiveDist * effectiveDist);
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      a.vx += fx;
      a.vy += fy;
      b.vx -= fx;
      b.vy -= fy;
    }
  }

  // Spring forces along edges.
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  for (const edge of edges) {
    const a = nodeById.get(edge.source);
    const b = nodeById.get(edge.target);
    if (!a || !b) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
    const rest = edge.edgeType === 'supersedes' ? SPRING_REST_MM : SPRING_REST_EM;
    const force = SPRING_K * (dist - rest) * alpha;
    const fx = (dx / dist) * force;
    const fy = (dy / dist) * force;
    a.vx += fx;
    a.vy += fy;
    b.vx -= fx;
    b.vy -= fy;
  }

  // Gravity toward origin and velocity integration.
  for (const node of nodes) {
    if (node.fixed) continue;
    node.vx += -GRAVITY_K * node.x * alpha;
    node.vy += -GRAVITY_K * node.y * alpha;
    node.vx *= DAMPING;
    node.vy *= DAMPING;
    node.x += node.vx;
    node.y += node.vy;
  }

  // Hard collision resolution: push overlapping nodes apart so circles never
  // intersect regardless of how strongly the springs pull them together.
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = nodes[i];
      const b = nodes[j];
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const minDist = a.radius + b.radius + NODE_GAP;
      if (dist < minDist) {
        const push = (minDist - dist) / 2;
        const ux = dx / dist;
        const uy = dy / dist;
        if (!a.fixed) {
          a.x += ux * push;
          a.y += uy * push;
        }
        if (!b.fixed) {
          b.x -= ux * push;
          b.y -= uy * push;
        }
      }
    }
  }

  gs.alpha *= ALPHA_DECAY;
}

// ---- Renderer ---------------------------------------------------------------

/**
 * Draws the current graph state onto the canvas.
 */
function render() {
  const { nodes, edges, canvas, ctx, camera, selected, hovered } = gs;
  const { width, height } = canvas;

  ctx.clearRect(0, 0, width, height);

  // Background.
  ctx.fillStyle = '#12121e';
  ctx.fillRect(0, 0, width, height);

  // Camera transform: world origin maps to canvas center + pan offset.
  ctx.save();
  ctx.translate(width / 2 + camera.x, height / 2 + camera.y);
  ctx.scale(camera.scale, camera.scale);

  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  // When a node is selected, dim everything not directly connected.
  const highlightIds = buildHighlightSet(selected, edges);

  // ---- Edges ----
  for (const edge of edges) {
    const a = nodeById.get(edge.source);
    const b = nodeById.get(edge.target);
    if (!a || !b) continue;

    const dimmed = selected && !highlightIds.has(edge.source) && !highlightIds.has(edge.target);
    const baseAlpha = edge.edgeType === 'supersedes' ? 0.75 : 0.22;
    const alpha = dimmed ? 0.04 : baseAlpha;

    if (edge.edgeType === 'supersedes') {
      drawArrow(ctx, a.x, a.y, b.x, b.y, '#d4905b', alpha, b.radius);
    } else {
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = '#8899aa';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.restore();
    }
  }

  // ---- Node circles (first pass) ----
  for (const node of nodes) {
    const dimmed = selected && !highlightIds.has(node.id);
    const isSelected = selected && node.id === selected.id;
    const isHovered = hovered && node.id === hovered.id;

    ctx.save();
    ctx.globalAlpha = dimmed ? 0.15 : 1.0;

    // Glow ring for selected or hovered.
    if (isSelected || isHovered) {
      ctx.beginPath();
      ctx.arc(node.x, node.y, node.radius + 5, 0, 2 * Math.PI);
      ctx.fillStyle = isSelected ? 'rgba(255,255,200,0.18)' : 'rgba(255,255,255,0.08)';
      ctx.fill();
    }

    // Node circle.
    ctx.beginPath();
    ctx.arc(node.x, node.y, node.radius, 0, 2 * Math.PI);
    ctx.fillStyle = node.color;
    ctx.fill();

    // Retired memory: dashed border.
    if (node.nodeType === 'memory' && node.retired) {
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = 'rgba(255,255,255,0.3)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.setLineDash([]);
    }

    ctx.restore();
  }

  // ---- Entity labels (second pass, always on top of all circles) ----
  for (const node of nodes) {
    if (node.nodeType !== 'entity') continue;
    const dimmed = selected && !highlightIds.has(node.id);
    ctx.save();
    ctx.globalAlpha = dimmed ? 0.15 : 1.0;
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.shadowColor = 'rgba(0,0,0,0.85)';
    ctx.shadowBlur = 3;
    ctx.fillStyle = '#ffffff';
    ctx.fillText(node.label, node.x, node.y + node.radius + 4);
    ctx.shadowBlur = 0;
    ctx.restore();
  }

  ctx.restore(); // undo camera transform

  // ---- Tooltip (in screen space) ----
  renderTooltip();
}

/**
 * Returns the set of node ids that should be highlighted when a node is selected:
 * the selected node itself plus all directly connected neighbours.
 * @param {object|null} selected
 * @param {object[]} edges
 * @returns {Set<string>}
 */
function buildHighlightSet(selected, edges) {
  if (!selected) return new Set();
  const ids = new Set([selected.id]);
  for (const edge of edges) {
    if (edge.source === selected.id) ids.add(edge.target);
    if (edge.target === selected.id) ids.add(edge.source);
  }
  return ids;
}

/**
 * Draws a directed arrow between two points, stopping short of the target node centre.
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} x1 - source x (world)
 * @param {number} y1 - source y
 * @param {number} x2 - target x
 * @param {number} y2 - target y
 * @param {string} color
 * @param {number} alpha - global alpha
 * @param {number} targetRadius - stop this many units from target centre
 */
function drawArrow(ctx, x1, y1, x2, y2, color, alpha, targetRadius = 10) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 2) return;

  const ux = dx / len;
  const uy = dy / len;
  // End point: stop just outside the target node's edge.
  const tx = x2 - ux * (targetRadius + 4);
  const ty = y2 - uy * (targetRadius + 4);

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(tx, ty);
  ctx.stroke();

  // Arrowhead.
  const headLen = 8;
  const angle = Math.atan2(ty - y1, tx - x1);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(tx, ty);
  ctx.lineTo(
    tx - headLen * Math.cos(angle - Math.PI / 6),
    ty - headLen * Math.sin(angle - Math.PI / 6),
  );
  ctx.lineTo(
    tx - headLen * Math.cos(angle + Math.PI / 6),
    ty - headLen * Math.sin(angle + Math.PI / 6),
  );
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/**
 * Updates the tooltip element position and content based on the hovered or selected node.
 */
function renderTooltip() {
  const $tip = $('#sm_graph_tooltip');
  const node = gs.hovered ?? gs.selected;
  if (!node) {
    $tip.hide();
    return;
  }

  // Convert world coords to screen coords for positioning.
  const { camera, canvas } = gs;
  const sx = node.x * camera.scale + canvas.width / 2 + camera.x;
  const sy = node.y * camera.scale + canvas.height / 2 + camera.y;

  const typeLabel = node.nodeType === 'entity' ? `Entity - ${node.subtype}` : node.subtype;
  const content = `<strong>${node.nodeType === 'entity' ? node.label : node.subtype}</strong>
    <span class="sm_graph_tip_type">${typeLabel}</span>
    <span class="sm_graph_tip_detail">${$('<div>').text(node.detail).html()}</span>`;

  $tip.html(content);

  // Position tooltip: prefer above/right of node, clamp to canvas bounds.
  const tipW = $tip.outerWidth(true) || 220;
  const tipH = $tip.outerHeight(true) || 80;
  const pad = 10;
  let left = sx + node.radius * camera.scale + pad;
  let top = sy - tipH / 2;

  const canvasRect = canvas.getBoundingClientRect();
  const overlayLeft =
    canvasRect.left - document.getElementById('sm_graph_card').getBoundingClientRect().left;
  const overlayTop =
    canvasRect.top - document.getElementById('sm_graph_card').getBoundingClientRect().top;

  left += overlayLeft;
  top += overlayTop;

  if (left + tipW > canvas.width + overlayLeft - 4)
    left = sx - tipW - node.radius * camera.scale - pad + overlayLeft;
  top = Math.max(4, Math.min(top, canvas.height + overlayTop - tipH - 4));

  $tip.css({ left, top }).show();
}

// ---- Animation loop ---------------------------------------------------------

function scheduleFrame() {
  if (!gs) return;
  gs.rafId = requestAnimationFrame(() => {
    if (!gs) return;
    if (gs.alpha > ALPHA_MIN || gs.dragging) {
      tick();
    }
    render();
    scheduleFrame();
  });
}

// ---- Input handling ---------------------------------------------------------

/**
 * Converts a mouse event's position to world coordinates.
 * @param {MouseEvent} e
 * @returns {{ x: number, y: number }}
 */
function mouseToWorld(e) {
  const rect = gs.canvas.getBoundingClientRect();
  const sx = e.clientX - rect.left;
  const sy = e.clientY - rect.top;
  return {
    x: (sx - gs.canvas.width / 2 - gs.camera.x) / gs.camera.scale,
    y: (sy - gs.canvas.height / 2 - gs.camera.y) / gs.camera.scale,
  };
}

/**
 * Returns the node at world position (wx, wy), or null if none.
 * @param {number} wx
 * @param {number} wy
 * @returns {object|null}
 */
function nodeAtWorld(wx, wy) {
  // Iterate in reverse so topmost-drawn nodes get hit first.
  for (let i = gs.nodes.length - 1; i >= 0; i--) {
    const n = gs.nodes[i];
    const dx = n.x - wx;
    const dy = n.y - wy;
    if (dx * dx + dy * dy <= (n.radius + 4) * (n.radius + 4)) return n;
  }
  return null;
}

/**
 * Binds all canvas and overlay event listeners, storing them for cleanup.
 * @param {HTMLCanvasElement} canvas
 * @param {jQuery} $overlay
 * @param {string|null} characterName
 */
function bindEvents(canvas, $overlay, characterName) {
  // ---- Mouse move: hover + drag + pan ----
  // Bound on document so drag and pan continue when the cursor leaves the canvas.
  const onMouseMove = (e) => {
    if (!gs) return;
    const world = mouseToWorld(e);
    gs.mouseWorld = world;

    if (gs.dragging) {
      const node = gs.dragging;
      node.x = world.x + gs.dragging.offsetX;
      node.y = world.y + gs.dragging.offsetY;
      node.vx = 0;
      node.vy = 0;
      gs.alpha = Math.max(gs.alpha, 0.25); // briefly reheat so graph settles
      return;
    }

    if (gs.panning) {
      const dx = e.clientX - gs.panStart.x;
      const dy = e.clientY - gs.panStart.y;
      gs.camera.x = gs.cameraAtPanStart.x + dx;
      gs.camera.y = gs.cameraAtPanStart.y + dy;
      return;
    }

    // Hover detection: only when cursor is actually over the canvas.
    const rect = canvas.getBoundingClientRect();
    const overCanvas =
      e.clientX >= rect.left &&
      e.clientX <= rect.right &&
      e.clientY >= rect.top &&
      e.clientY <= rect.bottom;
    const node = overCanvas ? nodeAtWorld(world.x, world.y) : null;
    if (node !== gs.hovered) {
      gs.hovered = node;
      canvas.style.cursor = node ? 'pointer' : 'grab';
    }
  };

  // ---- Mouse down: start drag or pan ----
  const onMouseDown = (e) => {
    if (!gs) return;
    e.preventDefault();
    const world = mouseToWorld(e);
    const node = nodeAtWorld(world.x, world.y);

    if (node && e.button === 0) {
      // Drag node.
      gs.dragging = node;
      gs.dragging.offsetX = node.x - world.x;
      gs.dragging.offsetY = node.y - world.y;
      node.fixed = true;
      canvas.style.cursor = 'grabbing';
    } else if (!node && e.button === 0) {
      // Pan.
      gs.panning = true;
      gs.panStart = { x: e.clientX, y: e.clientY };
      gs.cameraAtPanStart = { ...gs.camera };
      canvas.style.cursor = 'grabbing';
    }
  };

  // ---- Mouse up: end drag or pan, handle click ----
  // Bound on document so releasing outside the canvas still clears drag/pan state.
  const onMouseUp = (e) => {
    if (!gs) return;
    if (gs.dragging) {
      const node = gs.dragging;
      node.fixed = false;
      gs.dragging = null;
      gs._endedDrag = true; // suppress the overlay click-outside handler this cycle
      canvas.style.cursor = 'pointer';
      return;
    }
    if (gs.panning) {
      gs.panning = false;
      gs._endedDrag = true;
      canvas.style.cursor = 'grab';
      return;
    }
    // Click: select/deselect - only when released over the canvas.
    if (e.button === 0 && e.target === canvas) {
      const world = mouseToWorld(e);
      const node = nodeAtWorld(world.x, world.y);
      gs.selected = node === gs.selected ? null : node;
    }
  };

  // ---- Scroll: zoom ----
  const onWheel = (e) => {
    if (!gs) return;
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 0.91;
    const newScale = Math.max(0.2, Math.min(4, gs.camera.scale * factor));
    // Zoom toward the cursor position.
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left - canvas.width / 2;
    const my = e.clientY - rect.top - canvas.height / 2;
    gs.camera.x = mx - (mx - gs.camera.x) * (newScale / gs.camera.scale);
    gs.camera.y = my - (my - gs.camera.y) * (newScale / gs.camera.scale);
    gs.camera.scale = newScale;
  };

  // ---- Keyboard: Escape to close ----
  const onKeyDown = (e) => {
    if (e.key === 'Escape') closeGraph();
  };

  document.addEventListener('mousemove', onMouseMove);
  canvas.addEventListener('mousedown', onMouseDown);
  document.addEventListener('mouseup', onMouseUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  document.addEventListener('keydown', onKeyDown);

  // Store for cleanup.
  gs._cleanup = () => {
    document.removeEventListener('mousemove', onMouseMove);
    canvas.removeEventListener('mousedown', onMouseDown);
    document.removeEventListener('mouseup', onMouseUp);
    canvas.removeEventListener('wheel', onWheel);
    document.removeEventListener('keydown', onKeyDown);
  };

  // ---- Overlay UI buttons ----
  $overlay.find('#sm_graph_close').on('click', closeGraph);

  $overlay.find('#sm_graph_reset').on('click', () => {
    if (!gs) return;
    initPositions(gs.nodes, gs.edges);
    gs.camera = { x: 0, y: 0, scale: 1 };
    gs.alpha = 1.0;
    // Re-fit after the simulation has had a moment to settle.
    setTimeout(() => {
      if (gs) {
        for (let i = 0; i < 120; i++) tick();
        fitCameraToNodes();
      }
    }, 50);
  });

  $overlay.find('#sm_graph_show_session').on('change', function () {
    if (!gs) return;
    gs.opts.showSession = this.checked;
    rebuildGraph(characterName);
  });

  $overlay.find('#sm_graph_show_retired').on('change', function () {
    if (!gs) return;
    gs.opts.showRetired = this.checked;
    rebuildGraph(characterName);
  });

  // Click outside the card to close - but not if a drag just ended.
  $overlay.on('click', (e) => {
    if (gs?._endedDrag) {
      gs._endedDrag = false;
      return;
    }
    if (e.target === $overlay[0]) closeGraph();
  });
}

/**
 * Rebuilds the graph data in place (after toggling a filter) without closing the overlay.
 * @param {string|null} characterName
 */
function rebuildGraph(characterName) {
  const { nodes, edges } = buildGraph(characterName, gs.opts);
  gs.nodes = nodes;
  gs.edges = edges;
  initPositions(nodes, edges);
  gs.alpha = 1.0;
  gs.selected = null;
  gs.hovered = null;
}

// ---- Lifecycle helpers ------------------------------------------------------

/**
 * Sets the camera scale and pan so all nodes fit within the canvas with padding.
 * Called once after the initial layout pre-run so the graph is never tiny or
 * clipped regardless of screen size.
 */
function fitCameraToNodes() {
  const { nodes, canvas } = gs;
  if (nodes.length === 0) return;

  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x - n.radius);
    minY = Math.min(minY, n.y - n.radius);
    maxX = Math.max(maxX, n.x + n.radius);
    maxY = Math.max(maxY, n.y + n.radius);
  }

  const pad = 60;
  const contentW = maxX - minX + pad * 2;
  const contentH = maxY - minY + pad * 2;
  const scale = Math.min(
    canvas.width / contentW,
    canvas.height / contentH,
    2, // don't over-zoom for very sparse graphs
  );

  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  gs.camera.scale = scale;
  gs.camera.x = -cx * scale;
  gs.camera.y = -cy * scale;
}

/**
 * Closes and fully tears down the graph overlay.
 */
function closeGraph() {
  if (!gs) return;
  cancelAnimationFrame(gs.rafId);
  gs._cleanup?.();
  $('#sm_graph_overlay').remove();
  gs = null;
}

/**
 * Sizes the canvas to match its wrapper element's actual pixel dimensions.
 * @param {HTMLCanvasElement} canvas
 */
function fitCanvas(canvas) {
  const wrap = canvas.parentElement;
  canvas.width = wrap.clientWidth || 800;
  canvas.height = wrap.clientHeight || 500;
}

// ---- DOM builder ------------------------------------------------------------

/**
 * Returns the HTML string for the graph overlay.
 * @param {string|null} characterName
 * @returns {string}
 */
function buildOverlayHTML(characterName) {
  const title = characterName ? `Memory Graph - ${characterName}` : 'Memory Graph';

  const entityLegend = Object.entries(ENTITY_COLORS)
    .filter(([k]) => k !== 'unknown')
    .map(
      ([k, c]) =>
        `<span class="sm_graph_legend_item"><span class="sm_graph_legend_swatch" style="background:${c}"></span>${k}</span>`,
    )
    .join('');

  const memLegend = Object.entries(MEMORY_COLORS)
    .map(
      ([k, c]) =>
        `<span class="sm_graph_legend_item"><span class="sm_graph_legend_swatch sm_graph_legend_swatch_small" style="background:${c}"></span>${k}</span>`,
    )
    .join('');

  return `<div id="sm_graph_overlay">
  <div id="sm_graph_card">
    <div id="sm_graph_toolbar">
      <span id="sm_graph_title">${$('<div>').text(title).html()}</span>
      <div id="sm_graph_controls">
        <label class="sm_graph_toggle"><input type="checkbox" id="sm_graph_show_session" checked> Session</label>
        <label class="sm_graph_toggle"><input type="checkbox" id="sm_graph_show_retired"> Retired</label>
        <button id="sm_graph_reset" class="menu_button" title="Reset layout">Reset</button>
        <button id="sm_graph_close" class="menu_button" title="Close (Esc)">&#x2715; Close</button>
      </div>
    </div>
    <div id="sm_graph_canvas_wrap">
      <canvas id="sm_graph_canvas"></canvas>
      <div id="sm_graph_tooltip"></div>
    </div>
    <div id="sm_graph_legend">
      <span class="sm_graph_legend_group"><strong>Entities:</strong> ${entityLegend}
        <span class="sm_graph_legend_item sm_graph_legend_edge_link">&#x2015; link</span>
      </span>
      <span class="sm_graph_legend_group"><strong>Memories:</strong> ${memLegend}
        <span class="sm_graph_legend_item sm_graph_legend_edge_supersedes">&#x2192; supersedes</span>
      </span>
    </div>
  </div>
</div>`;
}
