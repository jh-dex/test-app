const DEFAULT_CANVAS_ID = 'default';
const RECENT_CANVASES_KEY = 'live-board-recent-canvases';
const CANVAS_PREVIEW_SIZE = 100;
const CANVAS_PREVIEW_ITEM_LIMIT = 18;
const activeCanvasId = resolveCanvasId();
const BROADCAST_CHANNEL_NAME = `live-board-mvp:${activeCanvasId}`;
const SYNC_RETRY_MS = 1500;
const seenMessageIds = new Set();
const seenMessageOrder = [];
const SEEN_MESSAGE_LIMIT = 4000;
let localMessageSeq = 0;
const boardStateBarriers = new Map();
// Per-object ordering guard: objectId -> { seq, source }. Lets us drop only the
// out-of-order (older-seq) messages that come from the SAME source for the same
// object (e.g. a stroke-end arriving after that stroke's undo stroke-remove),
// without touching concurrent edits made by OTHER clients.
const objectOpSeq = new Map();
const channel =
  typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(BROADCAST_CHANNEL_NAME) : null;

const board = document.getElementById('board');
const viewport = document.getElementById('viewport');
const drawLayer = document.getElementById('drawLayer');
const imageLayer = document.getElementById('imageLayer');
const compareLayer = document.getElementById('compareLayer');
const textLayer = document.getElementById('textLayer');
const zoomBadge = document.getElementById('zoomBadge');
const toolCursor = document.getElementById('toolCursor');
const presence = document.getElementById('presence');
const canvasMeta = document.getElementById('canvasMeta');
const homeButton = document.getElementById('homeButton');
const homeView = document.getElementById('homeView');
const homeReturnButton = document.getElementById('homeReturnButton');
const homeNewCanvasButton = document.getElementById('homeNewCanvasButton');
const recentCanvasList = document.getElementById('recentCanvasList');
const displayNameInput = document.getElementById('displayName');
const colorPicker = document.getElementById('colorPicker');
const colorButton = document.getElementById('colorButton');
const colorSwatch = document.getElementById('colorSwatch');
const brushSize = document.getElementById('brushSize');
const brushSizeValue = document.getElementById('brushSizeValue');
const textSizeInput = document.getElementById('textSize');
const textSizeValue = document.getElementById('textSizeValue');
const textColorPicker = document.getElementById('textColorPicker');
const textColorButton = document.getElementById('textColorButton');
const textColorSwatch = document.getElementById('textColorSwatch');
const imageInput = document.getElementById('imageInput');
const makeCompareBtn = document.getElementById('makeCompare');
const clearCanvasBtn = document.getElementById('clearCanvas');
const resetBoardBtn = document.getElementById('resetBoard');
const toolButtons = [...document.querySelectorAll('[data-tool]')];
const layerButtons = [...document.querySelectorAll('[data-layer-action]')];

const WORLD = {
  width: 8000,
  height: 8000,
};

const HISTORY_LIMIT = 80;
const clientId = crypto.randomUUID();
const randomColor = `#${Math.floor(Math.random() * 0xffffff)
  .toString(16)
  .padStart(6, '0')}`;
let me = {
  id: clientId,
  name: `User-${clientId.slice(0, 4)}`,
  color: randomColor,
  updatedAt: Date.now(),
};
let activeTool = 'pen';
let isDrawing = false;
let lastPoint = null;
let interaction = null;
let selectedImageId = null;
let selectedTextId = null;
let textEditingId = null;
const DEFAULT_TEXT_SIZE = 28;
const selectedIds = new Set();
let textColor = '#111827';
let textSize = DEFAULT_TEXT_SIZE;
let isSpacePressed = false;
let panSession = null;
let isRestoringHistory = false;
const history = [];
let historyIndex = -1;
let clipboardElements = [];
let drawingOps = [];
let historyFingerprint = '';
let activeStroke = null;
const liveStrokes = new Map();
const ERASER_SYNC_THROTTLE_MS = 24;
let lastEraserSyncAt = 0;
let lastEraserSyncPoint = null;
let eraserPath = [];

const camera = {
  x: 0,
  y: 0,
  zoom: 1,
};
const peers = new Map();
const syncState = {
  source: null,
  timer: null,
};

function normalizeCanvasId(value) {
  const id = String(value || '').trim().toLowerCase();
  if (!id) return DEFAULT_CANVAS_ID;
  return /^[a-z0-9_-]{1,80}$/.test(id) ? id : DEFAULT_CANVAS_ID;
}

function resolveCanvasId() {
  const params = new URLSearchParams(window.location.search);
  return normalizeCanvasId(params.get('canvas'));
}

function hasExplicitCanvasParam() {
  return new URLSearchParams(window.location.search).has('canvas');
}

function isHomeRoute() {
  return !hasExplicitCanvasParam();
}

function fallbackCanvasTitle(canvasId) {
  return canvasId === DEFAULT_CANVAS_ID ? '기본 캔버스' : `캔버스 ${canvasId}`;
}

function canvasTitle(canvasId) {
  const id = normalizeCanvasId(canvasId);
  const existing = loadRecentCanvases().find((item) => normalizeCanvasId(item.id) === id);
  return existing?.title || fallbackCanvasTitle(id);
}

function generateCanvasId() {
  return `canvas-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
}

function generateCanvasTitle() {
  return `새 캔버스 ${new Date().toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })}`;
}

function canvasUrl(canvasId) {
  const url = new URL(window.location.href);
  url.searchParams.set('canvas', normalizeCanvasId(canvasId));
  return url.toString();
}

function homeUrl() {
  const url = new URL(window.location.href);
  url.searchParams.delete('canvas');
  return url.toString();
}

function resolveSyncBaseUrl() {
  const param = new URLSearchParams(window.location.search).get('sync');
  if (param) {
    try {
      return new URL(param, window.location.href).toString().replace(/\/$/, '');
    } catch {
      return null;
    }
  }

  if (window.location.protocol === 'http:' || window.location.protocol === 'https:') {
    return window.location.origin;
  }
  return null;
}

function syncEndpoint(pathname) {
  return syncEndpointForCanvas(pathname, activeCanvasId);
}

function syncEndpointForCanvas(pathname, canvasId) {
  const baseUrl = resolveSyncBaseUrl();
  if (!baseUrl) return null;
  return `${baseUrl}${pathname}?canvas=${encodeURIComponent(normalizeCanvasId(canvasId))}`;
}

function loadRecentCanvases() {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECENT_CANVASES_KEY) || '[]');
    if (!Array.isArray(parsed)) return [];
    const seen = new Set();
    return parsed
      .filter((item) => item && item.id)
      .map((item) => {
        const id = normalizeCanvasId(item.id);
        return {
          id,
          title: typeof item.title === 'string' && item.title.trim() ? item.title.trim() : fallbackCanvasTitle(id),
          createdAt: Number(item.createdAt) || Number(item.updatedAt) || Date.now(),
          updatedAt: Number(item.updatedAt) || Number(item.createdAt) || Date.now(),
          preview: normalizeCanvasPreview(item.preview),
        };
      })
      .filter((item) => {
        if (seen.has(item.id)) return false;
        seen.add(item.id);
        return true;
      });
  } catch {
    return [];
  }
}

function saveRecentCanvases(items) {
  try {
    localStorage.setItem(RECENT_CANVASES_KEY, JSON.stringify(items.slice(0, 20)));
  } catch {
    // localStorage can be unavailable in private/file contexts.
  }
}

function rememberCanvas(canvasId, updates = {}) {
  const id = normalizeCanvasId(canvasId);
  const now = Date.now();
  const items = loadRecentCanvases();
  const existing = items.find((item) => item.id === id);
  const rest = items.filter((item) => item.id !== id);
  saveRecentCanvases([
    {
      id,
      title: updates.title || existing?.title || fallbackCanvasTitle(id),
      createdAt: updates.createdAt || existing?.createdAt || now,
      updatedAt: now,
      preview: updates.preview !== undefined ? updates.preview : existing?.preview || null,
    },
    ...rest,
  ]);
}

function forgetCanvas(canvasId) {
  const id = normalizeCanvasId(canvasId);
  saveRecentCanvases(loadRecentCanvases().filter((item) => item.id !== id));
}

function deleteCanvasSnapshot(canvasId) {
  const endpoint = syncEndpointForCanvas('/sync', canvasId);
  if (!endpoint) return;
  fetch(endpoint, {
    method: 'POST',
    keepalive: true,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: crypto.randomUUID(),
      type: 'state-store',
      source: clientId,
      payload: null,
      sentAt: Date.now(),
      seq: ++localMessageSeq,
    }),
  }).catch(() => {
    // The local recent file is still removed; this only clears live server memory.
  });
}

function deleteCanvas(canvasId, title) {
  const id = normalizeCanvasId(canvasId);
  const label = title || fallbackCanvasTitle(id);
  if (!window.confirm(`'${label}' 캔버스를 삭제할까요?`)) return;
  forgetCanvas(id);
  deleteCanvasSnapshot(id);
  if (!isHomeRoute() && id === activeCanvasId) {
    window.location.href = homeUrl();
    return;
  }
  renderRecentCanvases();
}

function updateCanvasMetaTitle() {
  if (!canvasMeta) return;
  const title = canvasTitle(activeCanvasId);
  canvasMeta.textContent = title;
  canvasMeta.title = '캔버스 이름 수정';
  canvasMeta.setAttribute('aria-label', `${title} 이름 수정`);
}

function saveCanvasTitle(canvasId, title) {
  const id = normalizeCanvasId(canvasId);
  const trimmed = String(title || '').trim();
  if (!trimmed) return false;
  if (trimmed === canvasTitle(id)) return false;
  rememberCanvas(id, { title: trimmed });
  if (id === activeCanvasId) updateCanvasMetaTitle();
  renderRecentCanvases();
  return true;
}

function beginInlineCanvasRename(host, canvasId) {
  if (!host || host.dataset.editing === 'true') return;
  const id = normalizeCanvasId(canvasId);
  const currentTitle = canvasTitle(id);
  let closed = false;
  host.dataset.editing = 'true';
  host.textContent = '';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'canvas-title-input';
  input.value = currentTitle;
  input.maxLength = 80;
  input.setAttribute('aria-label', '캔버스 이름');
  host.appendChild(input);

  const finish = (save) => {
    if (closed) return;
    closed = true;
    const nextTitle = input.value.trim();
    delete host.dataset.editing;
    host.textContent = nextTitle || currentTitle;
    if (save && nextTitle) {
      saveCanvasTitle(id, nextTitle);
    }
  };

  input.addEventListener('click', (event) => event.stopPropagation());
  input.addEventListener('pointerdown', (event) => event.stopPropagation());
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      finish(true);
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      finish(false);
    }
  });
  input.addEventListener('blur', () => finish(true));

  requestAnimationFrame(() => {
    input.focus();
    input.select();
  });
}

function renameActiveCanvasInline() {
  if (isHomeRoute()) return;
  beginInlineCanvasRename(canvasMeta, activeCanvasId);
}

function formatRecentTime(timestamp) {
  if (!timestamp) return '';
  return new Date(timestamp).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function clampPreviewValue(value, fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(CANVAS_PREVIEW_SIZE, Math.max(0, number));
}

function normalizePreviewColor(color) {
  const value = typeof color === 'string' ? color.trim() : '';
  if (/^#[0-9a-f]{3,8}$/i.test(value)) return value;
  if (/^rgba?\([\d\s.,%]+\)$/i.test(value)) return value;
  if (/^hsla?\([\d\s.,%]+\)$/i.test(value)) return value;
  return '#2563eb';
}

function normalizePreviewItem(item) {
  if (!item || typeof item !== 'object') return null;
  const type = ['stroke', 'image', 'text', 'compare'].includes(item.type) ? item.type : null;
  if (!type) return null;

  if (type === 'stroke') {
    const points = Array.isArray(item.points)
      ? item.points
          .slice(0, 12)
          .map((point) => ({ x: clampPreviewValue(point?.x), y: clampPreviewValue(point?.y) }))
      : [];
    if (points.length < 2) return null;
    return {
      type,
      color: normalizePreviewColor(item.color),
      size: Math.min(7, Math.max(1.5, Number(item.size) || 2.5)),
      points,
    };
  }

  return {
    type,
    x: clampPreviewValue(item.x),
    y: clampPreviewValue(item.y),
    width: Math.max(3, clampPreviewValue(item.width, 20)),
    height: Math.max(3, clampPreviewValue(item.height, 14)),
  };
}

function normalizeCanvasPreview(preview) {
  if (!preview || typeof preview !== 'object') return null;
  const counts = {
    strokes: Math.max(0, Number(preview.counts?.strokes) || 0),
    images: Math.max(0, Number(preview.counts?.images) || 0),
    texts: Math.max(0, Number(preview.counts?.texts) || 0),
    compares: Math.max(0, Number(preview.counts?.compares) || 0),
  };
  const items = Array.isArray(preview.items)
    ? preview.items.slice(0, CANVAS_PREVIEW_ITEM_LIMIT).map(normalizePreviewItem).filter(Boolean)
    : [];
  if (!items.length && counts.strokes + counts.images + counts.texts + counts.compares === 0) return null;
  return { counts, items };
}

function createCanvasPreview(snapshot) {
  if (!snapshot) return null;
  const rawItems = [];
  const bounds = {
    minX: Infinity,
    minY: Infinity,
    maxX: -Infinity,
    maxY: -Infinity,
  };
  const includeBounds = (x, y, width = 0, height = 0) => {
    const x1 = Number(x);
    const y1 = Number(y);
    const x2 = x1 + Number(width || 0);
    const y2 = y1 + Number(height || 0);
    if (![x1, y1, x2, y2].every(Number.isFinite)) return;
    bounds.minX = Math.min(bounds.minX, x1, x2);
    bounds.minY = Math.min(bounds.minY, y1, y2);
    bounds.maxX = Math.max(bounds.maxX, x1, x2);
    bounds.maxY = Math.max(bounds.maxY, y1, y2);
  };

  (snapshot.drawingOps || []).forEach((stroke) => {
    const points = (stroke.points || []).filter((point) => Number.isFinite(point?.x) && Number.isFinite(point?.y));
    if (points.length < 2) return;
    points.forEach((point) => includeBounds(point.x, point.y));
    rawItems.push({
      type: 'stroke',
      color: normalizePreviewColor(stroke.color),
      size: Math.min(7, Math.max(1.5, Number(stroke.size) / 2 || 2.5)),
      points,
    });
  });

  (snapshot.images || []).forEach((image) => {
    const width = Number(image.width) || 220;
    const height = Number(image.height) || Math.max(120, width * 0.68);
    includeBounds(image.x, image.y, width, height);
    rawItems.push({ type: 'image', x: image.x, y: image.y, width, height });
  });

  (snapshot.compares || []).forEach((compare) => {
    const width = Number(compare.width) || 220;
    const height = Number(compare.height) || 160;
    includeBounds(compare.x, compare.y, width, height);
    rawItems.push({ type: 'compare', x: compare.x, y: compare.y, width, height });
  });

  (snapshot.texts || []).forEach((text) => {
    const size = Number(text.size) || DEFAULT_TEXT_SIZE;
    const textLength = String(text.text || '').length;
    const width = Number(text.width) || Math.min(420, Math.max(80, textLength * size * 0.45));
    const height = Number(text.minHeight) || size * 1.55;
    includeBounds(text.x, text.y, width, height);
    rawItems.push({ type: 'text', x: text.x, y: text.y, width, height });
  });

  if (!Number.isFinite(bounds.minX) || !rawItems.length) return null;

  const width = Math.max(1, bounds.maxX - bounds.minX);
  const height = Math.max(1, bounds.maxY - bounds.minY);
  const padding = Math.max(width, height) * 0.14;
  const frame = {
    minX: bounds.minX - padding,
    minY: bounds.minY - padding,
    width: width + padding * 2,
    height: height + padding * 2,
  };
  const toPreviewX = (x) => ((Number(x) - frame.minX) / frame.width) * CANVAS_PREVIEW_SIZE;
  const toPreviewY = (y) => ((Number(y) - frame.minY) / frame.height) * CANVAS_PREVIEW_SIZE;
  const toPreviewW = (value) => (Number(value || 0) / frame.width) * CANVAS_PREVIEW_SIZE;
  const toPreviewH = (value) => (Number(value || 0) / frame.height) * CANVAS_PREVIEW_SIZE;
  const samplePoints = (points) => {
    const step = Math.max(1, Math.ceil(points.length / 10));
    const sampled = points.filter((_point, index) => index % step === 0);
    const last = points[points.length - 1];
    if (sampled[sampled.length - 1] !== last) sampled.push(last);
    return sampled.map((point) => ({
      x: Math.round(toPreviewX(point.x) * 10) / 10,
      y: Math.round(toPreviewY(point.y) * 10) / 10,
    }));
  };

  const items = rawItems.slice(-CANVAS_PREVIEW_ITEM_LIMIT).map((item) => {
    if (item.type === 'stroke') {
      return {
        type: 'stroke',
        color: item.color,
        size: item.size,
        points: samplePoints(item.points),
      };
    }
    return {
      type: item.type,
      x: Math.round(toPreviewX(item.x) * 10) / 10,
      y: Math.round(toPreviewY(item.y) * 10) / 10,
      width: Math.round(toPreviewW(item.width) * 10) / 10,
      height: Math.round(toPreviewH(item.height) * 10) / 10,
    };
  });

  return normalizeCanvasPreview({
    counts: {
      strokes: (snapshot.drawingOps || []).length,
      images: (snapshot.images || []).length,
      texts: (snapshot.texts || []).length,
      compares: (snapshot.compares || []).length,
    },
    items,
  });
}

function createSvgElement(tagName) {
  return document.createElementNS('http://www.w3.org/2000/svg', tagName);
}

function createRecentCanvasPreview(preview) {
  const frame = document.createElement('span');
  frame.className = preview ? 'recent-canvas-preview' : 'recent-canvas-preview is-empty';
  frame.setAttribute('aria-hidden', 'true');
  if (!preview) return frame;

  const svg = createSvgElement('svg');
  svg.setAttribute('viewBox', `0 0 ${CANVAS_PREVIEW_SIZE} ${CANVAS_PREVIEW_SIZE}`);
  svg.setAttribute('focusable', 'false');
  preview.items.forEach((item) => {
    if (item.type === 'stroke') {
      const path = createSvgElement('path');
      path.setAttribute(
        'd',
        item.points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' '),
      );
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', item.color);
      path.setAttribute('stroke-width', String(item.size));
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('stroke-linejoin', 'round');
      svg.appendChild(path);
      return;
    }

    const rect = createSvgElement('rect');
    rect.setAttribute('class', `preview-shape preview-${item.type}`);
    rect.setAttribute('x', String(item.x));
    rect.setAttribute('y', String(item.y));
    rect.setAttribute('width', String(item.width));
    rect.setAttribute('height', String(item.height));
    rect.setAttribute('rx', '3');
    svg.appendChild(rect);

    if (item.type === 'compare') {
      const divider = createSvgElement('line');
      divider.setAttribute('class', 'preview-detail');
      divider.setAttribute('x1', String(item.x + item.width / 2));
      divider.setAttribute('x2', String(item.x + item.width / 2));
      divider.setAttribute('y1', String(item.y));
      divider.setAttribute('y2', String(item.y + item.height));
      svg.appendChild(divider);
    }
  });
  frame.appendChild(svg);
  return frame;
}

function formatCanvasPreviewSummary(preview) {
  if (!preview) return '';
  const total = preview.counts.strokes + preview.counts.images + preview.counts.texts + preview.counts.compares;
  return total ? ` · ${total}개 요소` : '';
}

function renderRecentCanvases() {
  if (!recentCanvasList) return;
  const items = loadRecentCanvases();
  const hasOpenCanvas = !isHomeRoute();
  recentCanvasList.innerHTML = '';
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'recent-canvas-empty';
    const title = document.createElement('strong');
    title.textContent = '아직 캔버스가 없습니다.';
    const copy = document.createElement('span');
    copy.textContent = '새 파일을 눌러 첫 캔버스를 만들 수 있습니다.';
    empty.append(title, copy);
    recentCanvasList.appendChild(empty);
    return;
  }
  items.forEach((item) => {
    const id = normalizeCanvasId(item.id);
    const isCurrent = hasOpenCanvas && id === activeCanvasId;
    const card = document.createElement('div');
    card.className = isCurrent ? 'recent-canvas-item is-current' : 'recent-canvas-item';
    card.dataset.canvasId = id;

    const openArea = document.createElement('div');
    openArea.className = 'recent-canvas-open';
    openArea.setAttribute('role', 'button');
    openArea.tabIndex = 0;
    openArea.setAttribute('aria-label', `${item.title || fallbackCanvasTitle(id)} 열기`);
    if (isCurrent) openArea.setAttribute('aria-current', 'true');

    const preview = createRecentCanvasPreview(item.preview);
    openArea.append(preview);

    const label = document.createElement('strong');
    label.className = 'recent-canvas-title';
    label.textContent = item.title || fallbackCanvasTitle(id);
    label.tabIndex = 0;
    label.title = '이름 수정';
    label.setAttribute('role', 'button');
    label.setAttribute('aria-label', `${item.title || fallbackCanvasTitle(id)} 이름 수정`);
    label.addEventListener('click', (event) => {
      event.stopPropagation();
      beginInlineCanvasRename(label, id);
    });
    label.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === 'F2') {
        event.preventDefault();
        event.stopPropagation();
        beginInlineCanvasRename(label, id);
      }
    });

    const meta = document.createElement('span');
    meta.className = 'recent-canvas-meta';
    const when = formatRecentTime(item.updatedAt);
    meta.textContent = isCurrent ? `현재 열림 · ${when}` : `최근 열림 · ${when}`;
    meta.textContent += formatCanvasPreviewSummary(item.preview);

    const text = document.createElement('div');
    text.className = 'recent-canvas-main';
    text.append(label, meta);
    openArea.addEventListener('click', () => {
      if (isCurrent) {
        closeHome();
      } else {
        window.location.href = canvasUrl(id);
      }
    });
    openArea.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      if (isCurrent) {
        closeHome();
      } else {
        window.location.href = canvasUrl(id);
      }
    });

    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'recent-canvas-delete';
    deleteButton.textContent = '삭제';
    deleteButton.setAttribute('aria-label', `${item.title || fallbackCanvasTitle(id)} 삭제`);
    deleteButton.addEventListener('click', () => {
      deleteCanvas(id, item.title || fallbackCanvasTitle(id));
    });

    card.append(openArea, text, deleteButton);
    recentCanvasList.appendChild(card);
  });
}

function openHome() {
  if (!homeView) return;
  renderRecentCanvases();
  homeView.classList.remove('is-hidden');
}

function closeHome() {
  if (!homeView) return;
  homeView.classList.add('is-hidden');
}

function isHomeOpen() {
  return Boolean(homeView && !homeView.classList.contains('is-hidden'));
}

function createNewCanvas() {
  const id = generateCanvasId();
  rememberCanvas(id, { title: generateCanvasTitle(), createdAt: Date.now() });
  window.location.href = canvasUrl(id);
}

function goHome() {
  window.location.href = homeUrl();
}

function initializeCanvasHome() {
  const homeRoute = isHomeRoute();
  document.body.classList.toggle('is-home-route', homeRoute);
  document.body.classList.toggle('is-editor-route', !homeRoute);

  updateCanvasMetaTitle();
  if (!homeRoute) rememberCanvas(activeCanvasId);
  renderRecentCanvases();
  canvasMeta?.addEventListener('click', renameActiveCanvasInline);
  canvasMeta?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== 'F2') return;
    event.preventDefault();
    renameActiveCanvasInline();
  });
  homeButton?.addEventListener('click', goHome);
  homeReturnButton?.addEventListener('click', closeHome);
  homeNewCanvasButton?.addEventListener('click', createNewCanvas);
  homeView?.addEventListener('click', (event) => {
    if (!homeRoute && event.target === homeView) closeHome();
  });
  if (homeRoute) openHome();
  else closeHome();
}

function rememberMessageId(id) {
  if (!id || seenMessageIds.has(id)) return;
  seenMessageIds.add(id);
  seenMessageOrder.push(id);
  if (seenMessageOrder.length > SEEN_MESSAGE_LIMIT) {
    const staleId = seenMessageOrder.shift();
    if (staleId) seenMessageIds.delete(staleId);
  }
}

function isKnownMessage(id) {
  return Boolean(id && seenMessageIds.has(id));
}

function normalizeInboundMessage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const { id, type, source, payload, sentAt, seq } = raw;
  if (!type || !source) return null;
  return {
    id: id || crypto.randomUUID(),
    type,
    source,
    payload,
    sentAt: sentAt || Date.now(),
    seq: Number.isFinite(Number(seq)) ? Number(seq) : null,
  };
}

function connectSyncStream() {
  const endpoint = syncEndpoint('/events');
  if (!endpoint) return;

  const source = new EventSource(endpoint);
  syncState.source = source;

  source.addEventListener('open', () => {
    if (syncState.timer) {
      clearTimeout(syncState.timer);
      syncState.timer = null;
    }
    syncPresence();
  });

  source.addEventListener('message', (event) => {
    try {
      const parsed = JSON.parse(event.data);
      const message = normalizeInboundMessage(parsed);
      if (message) handleRealtimeMessage(message);
    } catch {
      // ignore malformed payloads
    }
  });

  source.addEventListener('error', () => {
    if (syncState.source === source) {
      syncState.source = null;
      source.close();
    }
    if (!syncState.timer) {
      syncState.timer = setTimeout(() => {
        syncState.timer = null;
        connectSyncStream();
      }, SYNC_RETRY_MS);
    }
  });
}

// Outbound messages are coalesced and flushed once per animation frame as a
// single POST (Figma-style per-frame batching). This collapses the dozens of
// per-point/per-segment POSTs made while drawing into ~60 requests/sec max,
// which removes the HTTP connection-limit queueing that caused lag.
let outboundQueue = [];
let flushScheduled = false;

function flushOutbound() {
  flushScheduled = false;
  if (!outboundQueue.length) return;
  const endpoint = syncEndpoint('/sync');
  if (!endpoint) {
    outboundQueue = [];
    return;
  }
  const batch = outboundQueue;
  outboundQueue = [];
  fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ batch }),
  }).catch(() => {
    // Transient failure (wifi blip, server restart): re-queue at the front and
    // retry shortly so changes aren't silently lost. Bounded to avoid blowup.
    outboundQueue = batch.concat(outboundQueue);
    const MAX = 4000;
    if (outboundQueue.length > MAX) {
      outboundQueue = outboundQueue.slice(outboundQueue.length - MAX);
    }
    setTimeout(scheduleFlush, 800);
  });
}

function scheduleFlush() {
  if (flushScheduled) return;
  flushScheduled = true;
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(flushOutbound);
  } else {
    setTimeout(flushOutbound, 16);
  }
}

function queueForServer(message) {
  if (!syncEndpoint('/sync')) return;
  outboundQueue.push(message);
  scheduleFlush();
}

function emitRealtimeMessage(message) {
  if (channel) {
    channel.postMessage(message);
  }
  queueForServer(message);
}

// --- Authoritative state sync (for late joiners) ---------------------------
// After every committed change we push a full snapshot to the server. The
// server stores only the latest one and replays it to clients that connect
// later, so anyone joining sees the current board. Debounced to avoid spamming.
let stateSyncTimer = null;

function sendStateToServer() {
  const baseUrl = resolveSyncBaseUrl();
  if (!baseUrl) return;
  queueForServer({
    id: crypto.randomUUID(),
    type: 'state-store',
    source: clientId,
    payload: snapshotBoardState(),
    sentAt: Date.now(),
    seq: ++localMessageSeq,
  });
}

function scheduleStateSync() {
  if (stateSyncTimer) clearTimeout(stateSyncTimer);
  stateSyncTimer = setTimeout(() => {
    stateSyncTimer = null;
    sendStateToServer();
  }, 400);
}

function resizeCanvas() {
  drawLayer.setAttribute('viewBox', `0 0 ${WORLD.width} ${WORLD.height}`);
  drawLayer.setAttribute('width', String(WORLD.width));
  drawLayer.setAttribute('height', String(WORLD.height));
  drawLayer.style.width = `${WORLD.width}px`;
  drawLayer.style.height = `${WORLD.height}px`;

  viewport.style.width = `${WORLD.width}px`;
  viewport.style.height = `${WORLD.height}px`;

  const rect = board.getBoundingClientRect();
  if (!camera.x && !camera.y) {
    camera.x = rect.width / 2 - WORLD.width / 2;
    camera.y = rect.height / 2 - WORLD.height / 2;
  }

  updateViewportTransform();
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function eventToWorld(event) {
  const rect = board.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left - camera.x) / camera.zoom,
    y: (event.clientY - rect.top - camera.y) / camera.zoom,
  };
}

function viewportCenterWorld() {
  const rect = board.getBoundingClientRect();
  return {
    x: (rect.width / 2 - camera.x) / camera.zoom,
    y: (rect.height / 2 - camera.y) / camera.zoom,
  };
}

function isTypingTarget(target) {
  if (!target) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable;
}

function updateCursor() {
  const isPanning = Boolean(panSession);
  if (isPanning) {
    board.style.cursor = 'grabbing';
    hideToolCursor();
    return;
  }
  if (isSpacePressed) {
    board.style.cursor = 'grab';
    hideToolCursor();
    return;
  }
  if (activeTool === 'select') {
    board.style.cursor = 'default';
    hideToolCursor();
    return;
  }
  if (activeTool === 'text') {
    board.style.cursor = 'text';
    hideToolCursor();
    return;
  }
  board.style.cursor = 'none';
}

function updateToolCursorSize() {
  if (!toolCursor) return;
  const size = Number(brushSize.value || 4) * camera.zoom;
  const safeSize = Math.max(4, size);
  toolCursor.style.width = `${safeSize}px`;
  toolCursor.style.height = `${safeSize}px`;
}

function showToolCursor(clientX, clientY) {
  if (!toolCursor) return;
  if (activeTool === 'select' || activeTool === 'text' || isSpacePressed || panSession) {
    hideToolCursor();
    return;
  }
  const rect = board.getBoundingClientRect();
  toolCursor.style.left = `${clientX - rect.left}px`;
  toolCursor.style.top = `${clientY - rect.top}px`;
  toolCursor.classList.add('is-visible');
}

function hideToolCursor() {
  if (!toolCursor) return;
  toolCursor.classList.remove('is-visible');
}

function updateImageInteractivity() {
  const canInteractImages = activeTool === 'select';
  imageLayer.querySelectorAll('.image-item').forEach((item) => {
    item.style.pointerEvents = canInteractImages ? 'auto' : 'none';
    item.style.cursor = 'default';
  });
}

function updateZoomUI() {
  zoomBadge.textContent = `${Math.round(camera.zoom * 100)}%`;
}

function updateViewportTransform() {
  viewport.style.transform = `translate(${camera.x}px, ${camera.y}px) scale(${camera.zoom})`;
  // Expose zoom so selection chrome can keep a constant on-screen size.
  board.style.setProperty('--zoom', String(camera.zoom));
  updateToolCursorSize();
  updateZoomUI();
}

function panBy(dx, dy) {
  camera.x += dx;
  camera.y += dy;
  updateViewportTransform();
}

function zoomAt(nextZoom, anchorClientX, anchorClientY) {
  const rect = board.getBoundingClientRect();
  const anchorX = anchorClientX - rect.left;
  const anchorY = anchorClientY - rect.top;
  const clampedZoom = clamp(nextZoom, 0.2, 4);

  const worldX = (anchorX - camera.x) / camera.zoom;
  const worldY = (anchorY - camera.y) / camera.zoom;

  camera.zoom = clampedZoom;
  camera.x = anchorX - worldX * camera.zoom;
  camera.y = anchorY - worldY * camera.zoom;

  updateViewportTransform();
}

function createSvgPath(stroke) {
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.dataset.strokeId = stroke.id;
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  path.setAttribute('stroke-width', String(stroke.size));
  path.setAttribute('stroke', stroke.color);
  return path;
}

function strokeToPathD(points) {
  if (!points.length) return '';
  if (points.length === 1) {
    const p = points[0];
    return `M ${p.x} ${p.y} L ${p.x + 0.01} ${p.y + 0.01}`;
  }

  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length - 1; i += 1) {
    const curr = points[i];
    const next = points[i + 1];
    const xc = (curr.x + next.x) / 2;
    const yc = (curr.y + next.y) / 2;
    d += ` Q ${curr.x} ${curr.y} ${xc} ${yc}`;
  }
  const last = points[points.length - 1];
  d += ` L ${last.x} ${last.y}`;
  return d;
}

const strokePathMap = new Map();

function renderStroke(stroke) {
  let path = strokePathMap.get(stroke.id);
  if (!path) {
    path = createSvgPath(stroke);
    drawLayer.appendChild(path);
    strokePathMap.set(stroke.id, path);
  } else {
    path.setAttribute('stroke-width', String(stroke.size));
    path.setAttribute('stroke', stroke.color);
  }
  path.setAttribute('d', strokeToPathD(stroke.points));
  stroke.pathEl = path;
}

function removeStrokePath(id) {
  const path = strokePathMap.get(id);
  if (path) {
    path.remove();
    strokePathMap.delete(id);
  }
}

function renderDrawingFromOps() {
  drawLayer.innerHTML = '';
  strokePathMap.clear();
  drawingOps.forEach((stroke) => renderStroke(stroke));
  for (const live of liveStrokes.values()) {
    if (!strokePathMap.has(live.id)) renderStroke(live);
  }
}

function pointToSegmentDistance(point, start, end) {
  const vx = end.x - start.x;
  const vy = end.y - start.y;
  if (vx === 0 && vy === 0) {
    return Math.hypot(point.x - start.x, point.y - start.y);
  }
  const t = clamp(
    ((point.x - start.x) * vx + (point.y - start.y) * vy) / (vx * vx + vy * vy),
    0,
    1,
  );
  const projX = start.x + t * vx;
  const projY = start.y + t * vy;
  return Math.hypot(point.x - projX, point.y - projY);
}

function getEraserRadius() {
  return Number(brushSize.value || 4) / 2;
}

function makeCapsuleTester(A, B, R) {
  const ax = A.x;
  const ay = A.y;
  const vx = B.x - A.x;
  const vy = B.y - A.y;
  const lenSq = vx * vx + vy * vy;
  const r2 = R * R;
  if (lenSq === 0) {
    return (px, py) => {
      const dx = px - ax;
      const dy = py - ay;
      return dx * dx + dy * dy <= r2;
    };
  }
  return (px, py) => {
    const dx = px - ax;
    const dy = py - ay;
    let t = (dx * vx + dy * vy) / lenSq;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    const cx = dx - t * vx;
    const cy = dy - t * vy;
    return cx * cx + cy * cy <= r2;
  };
}

function clipStrokeByCapsule(stroke, A, B, R) {
  if (!stroke?.points?.length) return [];
  const points = stroke.points;
  const strokeR = stroke.size / 2;
  const totalR = R + strokeR;

  const capMinX = Math.min(A.x, B.x) - totalR;
  const capMaxX = Math.max(A.x, B.x) + totalR;
  const capMinY = Math.min(A.y, B.y) - totalR;
  const capMaxY = Math.max(A.y, B.y) + totalR;

  let sMinX = Infinity;
  let sMaxX = -Infinity;
  let sMinY = Infinity;
  let sMaxY = -Infinity;
  for (const p of points) {
    if (p.x < sMinX) sMinX = p.x;
    if (p.x > sMaxX) sMaxX = p.x;
    if (p.y < sMinY) sMinY = p.y;
    if (p.y > sMaxY) sMaxY = p.y;
  }
  sMinX -= strokeR;
  sMaxX += strokeR;
  sMinY -= strokeR;
  sMaxY += strokeR;
  if (sMaxX < capMinX || sMinX > capMaxX || sMaxY < capMinY || sMinY > capMaxY) {
    return [stroke];
  }

  const insideCapsule = makeCapsuleTester(A, B, totalR);

  if (points.length === 1) {
    const p = points[0];
    return insideCapsule(p.x, p.y) ? [] : [stroke];
  }

  const minStep = Math.max(0.5, totalR * 0.25);
  const fragments = [];
  let current = [];
  let modified = false;

  let prevInside = insideCapsule(points[0].x, points[0].y);
  if (!prevInside) {
    current.push({ x: points[0].x, y: points[0].y });
  } else {
    modified = true;
  }

  for (let i = 1; i < points.length; i += 1) {
    const S = points[i - 1];
    const E = points[i];
    const eIn = insideCapsule(E.x, E.y);

    const segMinX = Math.min(S.x, E.x);
    const segMaxX = Math.max(S.x, E.x);
    const segMinY = Math.min(S.y, E.y);
    const segMaxY = Math.max(S.y, E.y);
    const segOutsideBox =
      segMaxX < capMinX || segMinX > capMaxX || segMaxY < capMinY || segMinY > capMaxY;

    if (!prevInside && !eIn && segOutsideBox) {
      current.push({ x: E.x, y: E.y });
      continue;
    }

    const dx = E.x - S.x;
    const dy = E.y - S.y;
    const segLen = Math.hypot(dx, dy);
    const nSub = Math.max(2, Math.ceil(segLen / minStep));

    for (let k = 1; k <= nSub; k += 1) {
      const t = k / nSub;
      const px = S.x + dx * t;
      const py = S.y + dy * t;
      const inside = insideCapsule(px, py);

      if (inside) {
        if (!prevInside) {
          if (current.length >= 2) fragments.push(current);
          current = [];
        }
        modified = true;
      } else {
        current.push({ x: px, y: py });
      }
      prevInside = inside;
    }
  }

  if (current.length >= 2) fragments.push(current);

  if (!modified) return [stroke];

  return fragments.map((pts, idx) => ({
    ...stroke,
    id: `${stroke.id}::frag-${idx}-${crypto.randomUUID().slice(0, 8)}`,
    points: pts,
    pathEl: undefined,
  }));
}

function eraseWithCapsule(from, to, radius = getEraserRadius()) {
  if (!from || !to) return false;
  if (!drawingOps.length) return false;

  const removedIds = [];
  const replacements = [];
  const next = [];
  let changed = false;

  for (let i = 0; i < drawingOps.length; i += 1) {
    const stroke = drawingOps[i];
    const fragments = clipStrokeByCapsule(stroke, from, to, radius);
    if (fragments.length === 1 && fragments[0] === stroke) {
      next.push(stroke);
      continue;
    }
    removedIds.push(stroke.id);
    for (const frag of fragments) {
      next.push(frag);
      replacements.push(frag);
    }
    changed = true;
  }

  if (!changed) return false;
  drawingOps = next;
  for (const id of removedIds) removeStrokePath(id);
  for (const frag of replacements) renderStroke(frag);
  return true;
}

function broadcast(type, payload = {}) {
  const message = {
    id: crypto.randomUUID(),
    type,
    source: clientId,
    payload,
    sentAt: Date.now(),
    seq: ++localMessageSeq,
  };
  rememberMessageId(message.id);
  emitRealtimeMessage(message);
}

function isBoardMutationMessage(type) {
  return type !== 'presence';
}

function rememberBoardStateBarrier(message) {
  if (!message?.source || message.source === 'server') return;
  const current = boardStateBarriers.get(message.source);
  const seq = Number.isFinite(Number(message.seq)) ? Number(message.seq) : null;
  const sentAt = Number(message.sentAt || 0);
  if (
    !current ||
    (seq !== null && (current.seq === null || seq > current.seq)) ||
    (seq === null && current.seq === null && sentAt > current.sentAt) ||
    (seq === null && current.seq !== null && sentAt > current.sentAt)
  ) {
    boardStateBarriers.set(message.source, { seq, sentAt });
  }
}

function isOlderThanBoardStateBarrier(message) {
  if (!message?.source || message.source === 'server') return false;
  if (!isBoardMutationMessage(message.type)) return false;
  const barrier = boardStateBarriers.get(message.source);
  if (!barrier) return false;

  const seq = Number.isFinite(Number(message.seq)) ? Number(message.seq) : null;
  if (seq !== null && barrier.seq !== null) {
    return seq < barrier.seq;
  }
  return Number(message.sentAt || 0) < barrier.sentAt;
}

// Object-scoped commit/remove messages that must be applied in send order
// (per source, per object) so a reordered older message can't resurrect or
// stale-overwrite an object that the same client has since changed/removed.
const GUARDED_OBJECT_OPS = new Set([
  'stroke-start',
  'stroke-append',
  'stroke-end',
  'stroke-remove',
  'image-update',
  'image-remove',
  'text-update',
  'text-remove',
  'compare-update',
  'compare-remove',
]);

function isStaleObjectOp(message) {
  const id = message?.payload?.id;
  const seq = Number.isFinite(Number(message?.seq)) ? Number(message.seq) : null;
  if (id == null || seq === null || !message.source) return false;
  const current = objectOpSeq.get(id);
  // Only drop messages from the SAME source that arrive out of order.
  // Cross-source edits are left to last-arrival-wins (unchanged behaviour).
  return Boolean(current && current.source === message.source && seq < current.seq);
}

function noteObjectOp(message) {
  const id = message?.payload?.id;
  const seq = Number.isFinite(Number(message?.seq)) ? Number(message.seq) : null;
  if (id == null || seq === null || !message.source) return;
  const current = objectOpSeq.get(id);
  if (!current || current.source !== message.source || seq >= current.seq) {
    objectOpSeq.set(id, { seq, source: message.source });
  }
}

function syncPresence() {
  me.updatedAt = Date.now();
  broadcast('presence', { user: me });
}

function renderPresence() {
  const now = Date.now();
  peers.set(me.id, me);
  for (const [id, user] of peers) {
    if (now - user.updatedAt > 15000) {
      peers.delete(id);
    }
  }

  presence.innerHTML = '';
  [...peers.values()]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .forEach((user) => {
      const el = document.createElement('span');
      el.className = 'badge';
      const dot = document.createElement('span');
      dot.className = 'badge-dot';
      dot.style.background = user.color;
      el.appendChild(dot);
      const label = document.createElement('span');
      label.textContent = user.id === me.id ? `${user.name} (me)` : user.name;
      el.appendChild(label);
      presence.appendChild(el);
    });
}

function setTool(toolName) {
  activeTool = toolName;
  toolButtons.forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.tool === toolName);
  });
  updateImageInteractivity();
  updateTextInteractivity();
  updateCompareInteractivity();
  updateToolCursorSize();
  updateCursor();
}

function getImageItem(id) {
  return imageLayer.querySelector(`.image-item[data-id="${id}"]`);
}

function getImagePayload(id) {
  const item = getImageItem(id);
  if (!item) return null;
  const img = item.querySelector('img');
  return {
    id,
    src: img?.src || '',
    x: Number(item.dataset.x || 0),
    y: Number(item.dataset.y || 0),
    width: Number(item.dataset.width || 200),
    z: Number(item.dataset.z || 0),
  };
}

function syncImageZIndices() {
  [...imageLayer.querySelectorAll('.image-item')].forEach((item, index) => {
    item.dataset.z = String(index);
    item.style.zIndex = String(index);
  });
}

// --- Unified selection (supports multi-select) -----------------------------
function elTypeOf(el) {
  if (!el) return null;
  if (el.classList.contains('image-item')) return 'image';
  if (el.classList.contains('text-item')) return 'text';
  if (el.classList.contains('compare-item')) return 'compare';
  return null;
}

function getElById(id) {
  return getImageItem(id) || getTextItem(id) || getCompareItem(id);
}

function syncTextControls(id) {
  const payload = getTextPayload(id);
  if (!payload) return;
  if (textSizeInput) textSizeInput.value = String(payload.size);
  if (textSizeValue) textSizeValue.textContent = String(payload.size);
  if (textColorPicker) textColorPicker.value = payload.color;
  if (textColorSwatch) textColorSwatch.style.background = payload.color;
}

function refreshSelectionUI() {
  const multi = selectedIds.size > 1;
  const apply = (el) => {
    const sel = selectedIds.has(el.dataset.id);
    el.classList.toggle('is-selected', sel && !multi);
    el.classList.toggle('is-multi', sel && multi);
  };
  imageLayer.querySelectorAll('.image-item').forEach(apply);
  textLayer.querySelectorAll('.text-item').forEach(apply);
  compareLayer.querySelectorAll('.compare-item').forEach(apply);

  const ids = [...selectedIds];
  selectedImageId = null;
  selectedTextId = null;
  if (ids.length === 1) {
    const type = elTypeOf(getElById(ids[0]));
    if (type === 'image') selectedImageId = ids[0];
    else if (type === 'text') selectedTextId = ids[0];
  }
  if (selectedTextId) syncTextControls(selectedTextId);
  updateCompareButton();
  updateSelectionBox();
}

function clearSelection() {
  selectedIds.clear();
  refreshSelectionUI();
}

function selectOnly(id) {
  selectedIds.clear();
  if (id) selectedIds.add(id);
  refreshSelectionUI();
}

function deselectId(id) {
  selectedIds.delete(id);
  refreshSelectionUI();
}

// Shift-click: add/remove a single element from the current selection.
function toggleSelection(id) {
  if (!id) return;
  if (selectedIds.has(id)) selectedIds.delete(id);
  else selectedIds.add(id);
  refreshSelectionUI();
}

// Alt-drag: duplicate the current selection in place; the copies become the
// new selection (so the subsequent drag moves the copies, originals stay).
function duplicateSelectionInPlace() {
  const newIds = [];
  [...selectedIds].forEach((id) => {
    const type = elTypeOf(getElById(id));
    const newId = crypto.randomUUID();
    if (type === 'image') {
      placeImage({ ...getImagePayload(id), id: newId }, { silent: true });
      broadcast('image-update', getImagePayload(newId));
    } else if (type === 'text') {
      placeText({ ...getTextPayload(id), id: newId }, { silent: true });
      broadcast('text-update', getTextPayload(newId));
    } else if (type === 'compare') {
      placeCompare({ ...getComparePayload(id), id: newId }, { silent: true });
      broadcast('compare-update', getComparePayload(newId));
    }
    newIds.push(newId);
  });
  selectedIds.clear();
  newIds.forEach((id) => selectedIds.add(id));
  refreshSelectionUI();
  return newIds;
}

// Back-compat shims used across the codebase.
function setSelectedImage(id) {
  if (id) selectOnly(id);
  else clearSelection();
}

function placeImage({ id, src, x = 20, y = 20, width = 200 }, { silent = false } = {}) {
  let item = getImageItem(id);
  const isNew = !item;
  if (!item) {
    item = document.createElement('div');
    item.className = 'image-item';
    item.dataset.id = id;

    const img = document.createElement('img');
    img.draggable = false;
    img.alt = 'board-image';

    item.append(img);
    ['nw', 'ne', 'sw', 'se'].forEach((corner) => {
      const handle = document.createElement('button');
      handle.type = 'button';
      handle.className = 'resize-handle';
      handle.dataset.corner = corner;
      handle.setAttribute('aria-label', '이미지 크기 조절');
      item.append(handle);
    });
  }

  const safeWidth = clamp(width, 40, WORLD.width);
  const safeX = clamp(x, -WORLD.width, WORLD.width);
  const safeY = clamp(y, -WORLD.height, WORLD.height);
  item.dataset.x = String(safeX);
  item.dataset.y = String(safeY);
  item.dataset.width = String(safeWidth);
  item.style.left = `${safeX}px`;
  item.style.top = `${safeY}px`;
  item.style.width = `${safeWidth}px`;

  const img = item.querySelector('img');
  if (img && src) img.src = src;
  if (isNew) {
    imageLayer.appendChild(item);
  }
  updateImageInteractivity();
  syncImageZIndices();

  if (!silent) {
    broadcast('image-update', getImagePayload(id));
  }
}

function removeImage(id, { silent = false } = {}) {
  const item = getImageItem(id);
  if (!item) return;
  item.remove();
  deselectId(id);
  syncImageZIndices();
  if (!silent) {
    broadcast('image-remove', { id });
  }
}

function serializeImages() {
  return [...imageLayer.querySelectorAll('.image-item')].map((item) => {
    const img = item.querySelector('img');
    return {
      id: item.dataset.id,
      src: img?.src || '',
      x: Number(item.dataset.x || 0),
      y: Number(item.dataset.y || 0),
      width: Number(item.dataset.width || 200),
      z: Number(item.dataset.z || 0),
    };
  });
}

// --- Text objects ----------------------------------------------------------
function getTextItem(id) {
  return textLayer.querySelector(`.text-item[data-id="${id}"]`);
}

function getTextBody(item) {
  return item ? item.querySelector('.text-body') : null;
}

function getTextPayload(id) {
  const item = getTextItem(id);
  if (!item) return null;
  const body = getTextBody(item);
  return {
    id,
    x: Number(item.dataset.x || 0),
    y: Number(item.dataset.y || 0),
    text: body ? body.textContent || '' : '',
    color: item.dataset.color || '#111827',
    size: Number(item.dataset.size || DEFAULT_TEXT_SIZE),
    width: item.dataset.width ? Number(item.dataset.width) : null,
    minHeight: item.dataset.minHeight ? Number(item.dataset.minHeight) : null,
  };
}

function placeCaretEnd(el) {
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const sel = window.getSelection();
  if (!sel) return;
  sel.removeAllRanges();
  sel.addRange(range);
}

let textSyncTimer = null;
function broadcastTextUpdateThrottled(id) {
  if (textSyncTimer) return;
  const payload = getTextPayload(id);
  if (payload) broadcast('text-update', payload);
  textSyncTimer = setTimeout(() => {
    textSyncTimer = null;
  }, 80);
}

function attachTextItemHandlers(item) {
  const body = item.querySelector('.text-body');
  body.addEventListener('input', () => {
    const id = item.dataset.id;
    if (id) broadcastTextUpdateThrottled(id);
  });
  body.addEventListener('blur', () => finishTextEdit(item));
  body.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      body.blur();
    }
    // Keep typing local: don't let board shortcuts fire while editing.
    event.stopPropagation();
  });
  item.addEventListener('dblclick', (event) => {
    event.stopPropagation();
    beginTextEdit(item.dataset.id);
  });
}

function placeText(
  {
    id,
    x = 20,
    y = 20,
    text = '',
    color = '#111827',
    size = DEFAULT_TEXT_SIZE,
    width = null,
    minHeight = null,
  },
  { silent = false } = {},
) {
  let item = getTextItem(id);
  const isNew = !item;
  if (!item) {
    item = document.createElement('div');
    item.className = 'text-item';
    item.dataset.id = id;

    const body = document.createElement('div');
    body.className = 'text-body';
    item.appendChild(body);

    ['nw', 'ne', 'sw', 'se'].forEach((corner) => {
      const handle = document.createElement('button');
      handle.type = 'button';
      handle.className = 'resize-handle';
      handle.dataset.corner = corner;
      handle.contentEditable = 'false';
      handle.setAttribute('aria-label', '텍스트 박스 크기 조절');
      item.appendChild(handle);
    });

    attachTextItemHandlers(item);
  }

  const safeX = clamp(x, -WORLD.width, WORLD.width);
  const safeY = clamp(y, -WORLD.height, WORLD.height);
  item.dataset.x = String(safeX);
  item.dataset.y = String(safeY);
  item.dataset.color = color;
  item.dataset.size = String(size);
  item.style.left = `${safeX}px`;
  item.style.top = `${safeY}px`;
  item.style.color = color;
  item.style.fontSize = `${size}px`;

  // Fixed-width text box (drawn with the text tool) vs. auto-width.
  if (width != null) {
    item.dataset.width = String(width);
    item.style.width = `${width}px`;
  } else {
    delete item.dataset.width;
    item.style.width = '';
  }
  if (minHeight != null) {
    item.dataset.minHeight = String(minHeight);
    item.style.minHeight = `${minHeight}px`;
  } else {
    delete item.dataset.minHeight;
    item.style.minHeight = '';
  }

  // Don't clobber the caret while this client is editing the same node.
  const body = getTextBody(item);
  if (body && textEditingId !== id && body.textContent !== text) {
    body.textContent = text;
  }

  if (isNew) textLayer.appendChild(item);
  updateTextInteractivity();

  if (!silent) broadcast('text-update', getTextPayload(id));
  return item;
}

function setSelectedText(id) {
  if (id) selectOnly(id);
  else clearSelection();
}

function beginTextEdit(id) {
  const item = getTextItem(id);
  if (!item) return;
  const body = getTextBody(item);
  if (!body) return;
  setSelectedText(id);
  textEditingId = id;
  item.classList.add('is-editing');
  body.contentEditable = 'true';
  item.style.pointerEvents = 'auto';
  body.focus();
  placeCaretEnd(body);
}

function finishTextEdit(item) {
  if (!item) return;
  const id = item.dataset.id;
  const body = getTextBody(item);
  if (body) body.contentEditable = 'false';
  item.classList.remove('is-editing');
  if (textEditingId === id) textEditingId = null;

  const text = ((body && body.textContent) || '').trim();
  if (!text) {
    // Empty text box -> discard it.
    removeText(id);
    pushHistory('text-remove-empty');
    return;
  }
  if (body && body.textContent !== text) body.textContent = text;
  broadcast('text-update', getTextPayload(id));
  pushHistory('text-edit');
  updateTextInteractivity();
}

function removeText(id, { silent = false } = {}) {
  const item = getTextItem(id);
  if (!item) return;
  item.remove();
  if (textEditingId === id) textEditingId = null;
  deselectId(id);
  if (!silent) broadcast('text-remove', { id });
}

function serializeTexts() {
  return [...textLayer.querySelectorAll('.text-item')].map((item) => {
    const body = getTextBody(item);
    return {
      id: item.dataset.id,
      x: Number(item.dataset.x || 0),
      y: Number(item.dataset.y || 0),
      text: body ? body.textContent || '' : '',
      color: item.dataset.color || '#111827',
      size: Number(item.dataset.size || DEFAULT_TEXT_SIZE),
      width: item.dataset.width ? Number(item.dataset.width) : null,
      minHeight: item.dataset.minHeight ? Number(item.dataset.minHeight) : null,
    };
  });
}

function updateTextInteractivity() {
  const interactive = activeTool === 'select' || activeTool === 'text';
  textLayer.querySelectorAll('.text-item').forEach((item) => {
    const editing = item.classList.contains('is-editing');
    item.style.pointerEvents = interactive || editing ? 'auto' : 'none';
    if (!editing) {
      item.style.cursor = activeTool === 'text' ? 'text' : 'default';
    }
  });
}

// --- Image compare (before/after wipe) -------------------------------------
// Matches the 2px solid border on .compare-item in styles.css. The frame's
// inner width is `width - 2*COMPARE_BORDER`, which the split math relies on.
const COMPARE_BORDER = 2;
function getCompareItem(id) {
  return compareLayer.querySelector(`.compare-item[data-id="${id}"]`);
}

function getComparePayload(id) {
  const item = getCompareItem(id);
  if (!item) return null;
  return {
    id,
    type: 'compare',
    x: Number(item.dataset.x || 0),
    y: Number(item.dataset.y || 0),
    width: Number(item.dataset.width || 200),
    height: Number(item.dataset.height || 150),
    srcA: item.dataset.srca || '',
    srcB: item.dataset.srcb || '',
    split: Number(item.dataset.split || 0.5),
    orientation: item.dataset.orientation || 'v',
  };
}

function applyCompareLayout(item) {
  const W = Number(item.dataset.width || 200);
  const H = Number(item.dataset.height || 150);
  const split = clamp(Number(item.dataset.split || 0.5), 0, 1);
  item.style.width = `${W}px`;
  item.style.height = `${H}px`;
  const top = item.querySelector('.compare-top');
  const clip = item.querySelector('.compare-clip');
  const divider = item.querySelector('.compare-divider');
  // .compare-top lives inside .compare-clip, so '100%' would shrink with the
  // clip and squash the top image. Pin it to the frame's inner size in px so
  // the clip just reveals a window onto a full-size image.
  const innerW = Math.max(0, W - COMPARE_BORDER * 2);
  const innerH = Math.max(0, H - COMPARE_BORDER * 2);
  if (top) {
    top.style.width = `${innerW}px`;
    top.style.height = `${innerH}px`;
  }
  // clip and divider are direct children of .compare-frame, so % tracks the
  // frame's inner width (W - 2*border). Using `split * W` pushed the divider
  // past the right edge by the border width and made the ends asymmetric.
  if (clip) clip.style.width = `${split * 100}%`;
  if (divider) divider.style.left = `${split * 100}%`;
}

function placeCompare(payload, { silent = false } = {}) {
  const { id } = payload;
  let item = getCompareItem(id);
  const isNew = !item;
  if (!item) {
    item = document.createElement('div');
    item.className = 'compare-item';
    item.dataset.id = id;

    const base = document.createElement('img');
    base.className = 'compare-base';
    base.draggable = false;
    base.alt = 'compare-b';

    const clip = document.createElement('div');
    clip.className = 'compare-clip';
    const top = document.createElement('img');
    top.className = 'compare-top';
    top.draggable = false;
    top.alt = 'compare-a';
    clip.appendChild(top);

    const divider = document.createElement('div');
    divider.className = 'compare-divider';
    const handle = document.createElement('div');
    handle.className = 'compare-handle';
    handle.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 8l-4 4 4 4"/><path d="M14 8l4 4-4 4"/></svg>';
    divider.appendChild(handle);

    const frame = document.createElement('div');
    frame.className = 'compare-frame';
    frame.append(base, clip, divider);
    item.appendChild(frame);

    ['nw', 'ne', 'sw', 'se'].forEach((corner) => {
      const h = document.createElement('button');
      h.type = 'button';
      h.className = 'resize-handle';
      h.dataset.corner = corner;
      h.setAttribute('aria-label', '비교 박스 크기 조절');
      item.appendChild(h);
    });
  }

  const W = clamp(Number(payload.width || 200), 40, WORLD.width);
  const H = clamp(Number(payload.height || 150), 40, WORLD.height);
  const safeX = clamp(Number(payload.x || 0), -WORLD.width, WORLD.width);
  const safeY = clamp(Number(payload.y || 0), -WORLD.height, WORLD.height);
  item.dataset.x = String(safeX);
  item.dataset.y = String(safeY);
  item.dataset.width = String(W);
  item.dataset.height = String(H);
  item.dataset.split = String(clamp(Number(payload.split ?? 0.5), 0, 1));
  item.dataset.orientation = payload.orientation || 'v';
  // Preserve existing images when src is omitted (e.g. geometry-only drag
  // updates) — otherwise live drag would wipe the compare's pictures.
  if (payload.srcA !== undefined) item.dataset.srca = payload.srcA;
  if (payload.srcB !== undefined) item.dataset.srcb = payload.srcB;
  item.style.left = `${safeX}px`;
  item.style.top = `${safeY}px`;

  const base = item.querySelector('.compare-base');
  const top = item.querySelector('.compare-top');
  if (base && payload.srcB && base.src !== payload.srcB) base.src = payload.srcB;
  if (top && payload.srcA && top.src !== payload.srcA) top.src = payload.srcA;

  applyCompareLayout(item);

  if (isNew) compareLayer.appendChild(item);
  updateCompareInteractivity();

  if (!silent) broadcast('compare-update', getComparePayload(id));
  return item;
}

function removeCompare(id, { silent = false } = {}) {
  const item = getCompareItem(id);
  if (!item) return;
  item.remove();
  deselectId(id);
  if (!silent) broadcast('compare-remove', { id });
}

function serializeCompares() {
  return [...compareLayer.querySelectorAll('.compare-item')].map((item) => ({
    id: item.dataset.id,
    type: 'compare',
    x: Number(item.dataset.x || 0),
    y: Number(item.dataset.y || 0),
    width: Number(item.dataset.width || 200),
    height: Number(item.dataset.height || 150),
    srcA: item.dataset.srca || '',
    srcB: item.dataset.srcb || '',
    split: Number(item.dataset.split || 0.5),
    orientation: item.dataset.orientation || 'v',
  }));
}

function updateCompareInteractivity() {
  const interactive = activeTool === 'select';
  compareLayer.querySelectorAll('.compare-item').forEach((item) => {
    item.style.pointerEvents = interactive ? 'auto' : 'none';
    item.style.cursor = 'default';
  });
}

let compareSyncTimer = null;
function broadcastCompareThrottled(id) {
  if (compareSyncTimer) return;
  const payload = getComparePayload(id);
  if (payload) broadcast('compare-update', payload);
  compareSyncTimer = setTimeout(() => {
    compareSyncTimer = null;
  }, 70);
}

// --- Live drag/resize broadcast (throttled, geometry-only) -----------------
// While dragging/resizing, push lightweight updates so peers see the motion in
// real time. We strip base64 (src) so we don't re-send whole images each tick.
const DRAG_SYNC_MS = 40;
let lastDragSyncAt = 0;
function dragSyncDue() {
  const now = Date.now();
  if (now - lastDragSyncAt >= DRAG_SYNC_MS) {
    lastDragSyncAt = now;
    return true;
  }
  return false;
}

function liveBroadcast(id) {
  const type = elTypeOf(getElById(id));
  if (type === 'image') {
    const p = getImagePayload(id);
    if (p) {
      delete p.src; // keep existing image on peers; send geometry only
      p.transient = true;
      broadcast('image-update', p);
    }
  } else if (type === 'compare') {
    const p = getComparePayload(id);
    if (p) {
      delete p.srcA;
      delete p.srcB;
      p.transient = true;
      broadcast('compare-update', p);
    }
  } else if (type === 'text') {
    const p = getTextPayload(id);
    if (p) {
      p.transient = true;
      broadcast('text-update', p);
    }
  }
}

function updateCompareButton() {
  if (!makeCompareBtn) return;
  const imageCount = [...selectedIds].filter((id) => getImageItem(id)).length;
  makeCompareBtn.disabled = !(selectedIds.size === 2 && imageCount === 2);
}

function createCompareFromSelection() {
  const imgs = [...selectedIds].map((id) => getImageItem(id)).filter(Boolean);
  if (imgs.length !== 2) return;
  // Lower layer (smaller z) becomes A (left side).
  imgs.sort((a, b) => Number(a.dataset.z || 0) - Number(b.dataset.z || 0));
  const [a, b] = imgs;
  const aImg = a.querySelector('img');
  const bImg = b.querySelector('img');
  const srcA = aImg ? aImg.src : '';
  const srcB = bImg ? bImg.src : '';
  const x = Number(a.dataset.x || 0);
  const y = Number(a.dataset.y || 0);
  const width = Number(a.dataset.width || 220);
  const aspect =
    aImg && aImg.naturalWidth && aImg.naturalHeight
      ? aImg.naturalWidth / aImg.naturalHeight
      : a.offsetWidth / Math.max(1, a.offsetHeight);
  const height = width / (aspect || 1.5);
  const id = crypto.randomUUID();

  // Keep the original images; place the compare box beside them (to the right).
  const newX = x + width + 24;
  placeCompare({ id, x: newX, y, width, height, srcA, srcB, split: 0.5, orientation: 'v' });
  selectOnly(id);
  pushHistory('create-compare');
}

function makeHistoryFingerprint(images, texts = [], compares = [], strokes = drawingOps) {
  // Content-based drawing signature (not just count): an eraser can replace a
  // stroke with a fragment of the same count, so length alone misses changes.
  const drawingSignature = strokes
    .map((s) => {
      const points = (s.points || []).map((p) => `${Math.round(p.x * 10) / 10},${Math.round(p.y * 10) / 10}`).join(';');
      return `${s.id}:${s.color}:${s.size}:${s.tool}:${points}`;
    })
    .join('|');
  const imageSignature = images
    .map((image) => `${image.id}:${image.x}:${image.y}:${image.width}:${image.src.length}`)
    .join('|');
  const textSignature = texts
    .map((t) => `${t.id}:${t.x}:${t.y}:${t.size}:${t.color}:${t.width}:${t.text}`)
    .join('|');
  const compareSignature = compares
    .map((c) => `${c.id}:${c.x}:${c.y}:${c.width}:${c.height}:${c.split}:${c.orientation}`)
    .join('|');
  return `${drawingSignature}::${imageSignature}::${textSignature}::${compareSignature}`;
}

function snapshotBoardState() {
  const images = serializeImages();
  const texts = serializeTexts();
  const compares = serializeCompares();
  const strokes = drawingOps.map((stroke) => ({
    ...stroke,
    points: stroke.points.map((point) => ({ ...point })),
  }));
  return {
    drawingOps: strokes,
    images,
    texts,
    compares,
    fingerprint: makeHistoryFingerprint(images, texts, compares, strokes),
  };
}

function cloneBoardSnapshot(snapshot) {
  return {
    drawingOps: (snapshot.drawingOps || []).map((stroke) => ({
      ...stroke,
      points: (stroke.points || []).map((point) => ({ ...point })),
    })),
    images: (snapshot.images || []).map((payload) => ({ ...payload })),
    texts: (snapshot.texts || []).map((payload) => ({ ...payload })),
    compares: (snapshot.compares || []).map((payload) => ({ ...payload })),
    fingerprint: snapshot.fingerprint,
  };
}

function appendHistorySnapshot(snapshot) {
  if (!snapshot) return false;
  const next = cloneBoardSnapshot(snapshot);
  if (!next.fingerprint) {
    next.fingerprint = makeHistoryFingerprint(next.images, next.texts, next.compares, next.drawingOps);
  }
  if (next.fingerprint === historyFingerprint) return false;

  history.splice(historyIndex + 1);
  history.push(next);
  if (history.length > HISTORY_LIMIT) {
    history.shift();
  }
  historyIndex = history.length - 1;
  historyFingerprint = next.fingerprint;
  return true;
}

function recordCurrentStateInHistory() {
  const snapshot = snapshotBoardState();
  if (appendHistorySnapshot(snapshot)) {
    rememberCanvas(activeCanvasId, { preview: createCanvasPreview(snapshot) });
  }
}

// Undo/redo broadcasts only what actually changed (a diff against the live
// board), NOT a full board-state snapshot. A full snapshot is built from the
// actor's local view and would overwrite peers' concurrent edits it hasn't
// merged yet, permanently desyncing the boards. A diff touches only the objects
// this undo/redo changed, so concurrent edits to OTHER objects survive and the
// boards converge. (The server still keeps a full snapshot for late joiners.)
function broadcastBoardDiff(before, after) {
  const byId = (arr) => {
    const map = new Map();
    (arr || []).forEach((obj) => {
      if (obj && obj.id != null) map.set(obj.id, obj);
    });
    return map;
  };
  const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  // Strokes (pen): add/replace changed, remove the gone.
  const beforeStrokes = byId(before.drawingOps);
  const afterStrokes = byId(after.drawingOps);
  afterStrokes.forEach((stroke, id) => {
    const prev = beforeStrokes.get(id);
    if (!prev || !sameJson(prev, stroke)) {
      broadcast('stroke-end', {
        id: stroke.id,
        color: stroke.color,
        size: stroke.size,
        tool: stroke.tool,
        points: (stroke.points || []).map((point) => ({ ...point })),
      });
    }
  });
  beforeStrokes.forEach((_stroke, id) => {
    if (!afterStrokes.has(id)) broadcast('stroke-remove', { id });
  });

  // Images: z-order is derived from DOM order, so compare content without z and
  // fix ordering separately via image-order.
  const beforeImg = byId(before.images);
  const afterImg = byId(after.images);
  const imgContentEq = (a, b) =>
    a.src === b.src && a.x === b.x && a.y === b.y && a.width === b.width;
  afterImg.forEach((img, id) => {
    const prev = beforeImg.get(id);
    if (!prev || !imgContentEq(prev, img)) broadcast('image-update', { ...img });
  });
  beforeImg.forEach((_img, id) => {
    if (!afterImg.has(id)) broadcast('image-remove', { id });
  });
  const beforeOrder = (before.images || []).map((img) => img.id).join(',');
  const afterOrder = (after.images || []).map((img) => img.id).join(',');
  if (beforeOrder !== afterOrder && afterImg.size > 0) {
    broadcast('image-order', { order: (after.images || []).map((img) => img.id) });
  }

  // Texts.
  const beforeText = byId(before.texts);
  const afterText = byId(after.texts);
  afterText.forEach((text, id) => {
    const prev = beforeText.get(id);
    if (!prev || !sameJson(prev, text)) broadcast('text-update', { ...text });
  });
  beforeText.forEach((_text, id) => {
    if (!afterText.has(id)) broadcast('text-remove', { id });
  });

  // Compares.
  const beforeCmp = byId(before.compares);
  const afterCmp = byId(after.compares);
  afterCmp.forEach((cmp, id) => {
    const prev = beforeCmp.get(id);
    if (!prev || !sameJson(prev, cmp)) broadcast('compare-update', { ...cmp });
  });
  beforeCmp.forEach((_cmp, id) => {
    if (!afterCmp.has(id)) broadcast('compare-remove', { id });
  });
}

function restoreBoardState(state, { broadcastRestore = false, recordHistory = false } = {}) {
  if (!state) return;
  const images = Array.isArray(state.images) ? state.images : [];
  const texts = Array.isArray(state.texts) ? state.texts : [];
  const compares = Array.isArray(state.compares) ? state.compares : [];

  // Snapshot the live board BEFORE mutating it, so an undo/redo can broadcast a
  // precise diff (only what changed) instead of a clobbering full snapshot.
  const before = broadcastRestore ? snapshotBoardState() : null;

  isRestoringHistory = true;
  liveStrokes.clear();
  activeStroke = null;
  isDrawing = false;
  lastPoint = null;
  lastEraserSyncPoint = null;
  eraserPath = [];
  drawingOps = (state.drawingOps || []).map((stroke) => ({
    ...stroke,
    points: (stroke.points || []).map((point) => ({ ...point })),
  }));
  renderDrawingFromOps();

  imageLayer.innerHTML = '';
  images.forEach((payload) => placeImage(payload, { silent: true }));

  textLayer.innerHTML = '';
  texts.forEach((payload) => placeText(payload, { silent: true }));

  compareLayer.innerHTML = '';
  compares.forEach((payload) => placeCompare(payload, { silent: true }));

  setSelectedImage(null);
  setSelectedText(null);
  const restoredSnapshot = snapshotBoardState();
  isRestoringHistory = false;

  if (recordHistory) {
    appendHistorySnapshot(restoredSnapshot);
  } else {
    historyFingerprint = restoredSnapshot.fingerprint;
  }
  rememberCanvas(activeCanvasId, { preview: createCanvasPreview(restoredSnapshot) });

  if (broadcastRestore) {
    // Live peers get only the objects this undo/redo changed (so their own
    // concurrent edits to other objects are preserved)...
    broadcastBoardDiff(before, restoredSnapshot);
    // ...and the server's stored snapshot is updated too, so a refresh or a
    // late joiner also sees the result of this undo/redo.
    scheduleStateSync();
  }
}

function pushHistory(reason = '') {
  if (isRestoringHistory) return;
  const snapshot = snapshotBoardState();
  if (!appendHistorySnapshot(snapshot)) {
    return;
  }

  // Persist the new state to the server so late joiners receive it.
  // Skip the startup 'initial' push so an empty board never clobbers
  // content that another client has already stored on the server.
  if (reason !== 'initial') {
    rememberCanvas(activeCanvasId, { preview: createCanvasPreview(snapshot) });
    scheduleStateSync();
  }
}

function undo() {
  if (historyIndex <= 0) return;
  historyIndex -= 1;
  restoreBoardState(history[historyIndex], { broadcastRestore: true });
}

function redo() {
  if (historyIndex >= history.length - 1) return;
  historyIndex += 1;
  restoreBoardState(history[historyIndex], { broadcastRestore: true });
}

function isPanTrigger(event) {
  return event.button === 1 || (event.button === 0 && isSpacePressed);
}

// --- Transient overlays (text draft + marquee) -----------------------------
let textDraftEl = null;
function updateTextDraft(x, y, w, h) {
  if (!textDraftEl) {
    textDraftEl = document.createElement('div');
    textDraftEl.className = 'text-draft';
    viewport.appendChild(textDraftEl);
  }
  textDraftEl.style.left = `${x}px`;
  textDraftEl.style.top = `${y}px`;
  textDraftEl.style.width = `${w}px`;
  textDraftEl.style.height = `${h}px`;
  textDraftEl.style.display = 'block';
}
function hideTextDraft() {
  if (textDraftEl) {
    textDraftEl.remove();
    textDraftEl = null;
  }
}

let marqueeEl = null;
function updateMarquee(x, y, w, h) {
  if (!marqueeEl) {
    marqueeEl = document.createElement('div');
    marqueeEl.className = 'marquee';
    viewport.appendChild(marqueeEl);
  }
  marqueeEl.style.left = `${x}px`;
  marqueeEl.style.top = `${y}px`;
  marqueeEl.style.width = `${w}px`;
  marqueeEl.style.height = `${h}px`;
  marqueeEl.style.display = 'block';
}
function hideMarquee() {
  if (marqueeEl) {
    marqueeEl.remove();
    marqueeEl = null;
  }
}

// --- Smart snap (alignment to other elements' edges/centers) ----------------
const SNAP_PX = 6;
let snapGuideV = null;
let snapGuideH = null;

function collectSnapTargets(excludeIds) {
  const boxes = [];
  const add = (el) => {
    if (excludeIds.has(el.dataset.id)) return;
    boxes.push({
      x: Number(el.dataset.x || 0),
      y: Number(el.dataset.y || 0),
      w: el.offsetWidth,
      h: el.offsetHeight,
    });
  };
  imageLayer.querySelectorAll('.image-item').forEach(add);
  textLayer.querySelectorAll('.text-item').forEach(add);
  compareLayer.querySelectorAll('.compare-item').forEach(add);
  return boxes;
}

function computeSnap(box, targets) {
  const th = SNAP_PX / camera.zoom;
  const movX = [box.x, box.x + box.w / 2, box.x + box.w];
  const movY = [box.y, box.y + box.h / 2, box.y + box.h];
  let bestDx = null;
  let guideX = null;
  let bestDy = null;
  let guideY = null;
  targets.forEach((t) => {
    const tX = [t.x, t.x + t.w / 2, t.x + t.w];
    const tY = [t.y, t.y + t.h / 2, t.y + t.h];
    movX.forEach((mx) => {
      tX.forEach((tx) => {
        const d = tx - mx;
        if (Math.abs(d) <= th && (bestDx === null || Math.abs(d) < Math.abs(bestDx))) {
          bestDx = d;
          guideX = tx;
        }
      });
    });
    movY.forEach((my) => {
      tY.forEach((ty) => {
        const d = ty - my;
        if (Math.abs(d) <= th && (bestDy === null || Math.abs(d) < Math.abs(bestDy))) {
          bestDy = d;
          guideY = ty;
        }
      });
    });
  });
  return { dx: bestDx || 0, dy: bestDy || 0, guideX, guideY };
}

// 1-D snap for a single moving edge (used while resizing).
function snapValue(v, lines, th) {
  let best = null;
  let guide = null;
  lines.forEach((l) => {
    const d = l - v;
    if (Math.abs(d) <= th && (best === null || Math.abs(d) < Math.abs(best))) {
      best = d;
      guide = l;
    }
  });
  return { snapped: best === null ? v : v + best, guide };
}

function snapLinesX(excludeIds) {
  const xs = [];
  collectSnapTargets(excludeIds).forEach((t) => {
    xs.push(t.x, t.x + t.w / 2, t.x + t.w);
  });
  return xs;
}

function snapLinesY(excludeIds) {
  const ys = [];
  collectSnapTargets(excludeIds).forEach((t) => {
    ys.push(t.y, t.y + t.h / 2, t.y + t.h);
  });
  return ys;
}

// Aspect-locked resize snap: consider both the moving X edge and Y edge,
// snap to whichever is closest, and return the resulting width.
function snapAspectResize(world, interaction, aspect, excludeIds) {
  const th = SNAP_PX / camera.zoom;
  const isTop = interaction.corner === 'nw' || interaction.corner === 'ne';
  const w0 = Math.abs(world.x - interaction.fixedX); // raw width from cursor X
  const sx = snapValue(world.x, snapLinesX(excludeIds), th);
  const movingY = isTop
    ? interaction.fixedY - w0 / aspect
    : interaction.fixedY + w0 / aspect;
  const sy = snapValue(movingY, snapLinesY(excludeIds), th);

  const candidates = [];
  if (sx.guide != null) {
    const w = Math.abs(sx.snapped - interaction.fixedX);
    candidates.push({ width: w, guideX: sx.guide, guideY: null, d: Math.abs(w - w0) });
  }
  if (sy.guide != null) {
    const w = Math.abs(sy.snapped - interaction.fixedY) * aspect;
    candidates.push({ width: w, guideX: null, guideY: sy.guide, d: Math.abs(w - w0) });
  }
  if (candidates.length) {
    candidates.sort((a, b) => a.d - b.d);
    return candidates[0];
  }
  return { width: w0, guideX: null, guideY: null };
}

function showSnapGuides(guideX, guideY) {
  if (guideX != null) {
    if (!snapGuideV) {
      snapGuideV = document.createElement('div');
      snapGuideV.className = 'snap-guide snap-guide-v';
      snapGuideV.style.height = `${WORLD.height}px`;
      viewport.appendChild(snapGuideV);
    }
    snapGuideV.style.left = `${guideX}px`;
    snapGuideV.style.display = 'block';
  } else if (snapGuideV) {
    snapGuideV.style.display = 'none';
  }

  if (guideY != null) {
    if (!snapGuideH) {
      snapGuideH = document.createElement('div');
      snapGuideH.className = 'snap-guide snap-guide-h';
      snapGuideH.style.width = `${WORLD.width}px`;
      viewport.appendChild(snapGuideH);
    }
    snapGuideH.style.top = `${guideY}px`;
    snapGuideH.style.display = 'block';
  } else if (snapGuideH) {
    snapGuideH.style.display = 'none';
  }
}

function hideSnapGuides() {
  if (snapGuideV) snapGuideV.style.display = 'none';
  if (snapGuideH) snapGuideH.style.display = 'none';
}

// Snap a moving box against other elements; returns adjusted {x, y}.
function applySnap(excludeIds, nx, ny, w, h) {
  const snap = computeSnap({ x: nx, y: ny, w, h }, collectSnapTargets(excludeIds));
  showSnapGuides(snap.guideX, snap.guideY);
  return { x: nx + snap.dx, y: ny + snap.dy };
}

function beginGroupMove(event) {
  const world = eventToWorld(event);
  const items = [...selectedIds]
    .map((id) => {
      const el = getElById(id);
      if (!el) return null;
      return {
        id,
        type: elTypeOf(el),
        startX: Number(el.dataset.x || 0),
        startY: Number(el.dataset.y || 0),
      };
    })
    .filter(Boolean);
  interaction = {
    mode: 'move-group',
    pointerId: event.pointerId,
    startWorldX: world.x,
    startWorldY: world.y,
    items,
    bbox: getSelectionBounds(),
  };
  board.setPointerCapture(event.pointerId);
}

// --- Group bounding box (multi-selection) ----------------------------------
function getSelectionBounds() {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  [...selectedIds].forEach((id) => {
    const el = getElById(id);
    if (!el) return;
    const x = Number(el.dataset.x || 0);
    const y = Number(el.dataset.y || 0);
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x + w > x1) x1 = x + w;
    if (y + h > y1) y1 = y + h;
  });
  if (x0 === Infinity) return null;
  return { x0, y0, x1, y1 };
}

let selectionBoxEl = null;
function updateSelectionBox() {
  if (!selectionBoxEl) {
    selectionBoxEl = document.createElement('div');
    selectionBoxEl.className = 'selection-box';
    ['nw', 'ne', 'sw', 'se'].forEach((corner) => {
      const h = document.createElement('div');
      h.className = 'sel-handle';
      h.dataset.corner = corner;
      selectionBoxEl.appendChild(h);
    });
    viewport.appendChild(selectionBoxEl);
  }
  const bounds = selectedIds.size > 1 ? getSelectionBounds() : null;
  if (bounds) {
    selectionBoxEl.style.left = `${bounds.x0}px`;
    selectionBoxEl.style.top = `${bounds.y0}px`;
    selectionBoxEl.style.width = `${bounds.x1 - bounds.x0}px`;
    selectionBoxEl.style.height = `${bounds.y1 - bounds.y0}px`;
    selectionBoxEl.style.display = 'block';
  } else {
    selectionBoxEl.style.display = 'none';
  }
}

function beginGroupResize(event, corner) {
  const bounds = getSelectionBounds();
  if (!bounds) return;
  const W = Math.max(1, bounds.x1 - bounds.x0);
  const H = Math.max(1, bounds.y1 - bounds.y0);
  const fixedX = corner === 'nw' || corner === 'sw' ? bounds.x1 : bounds.x0;
  const fixedY = corner === 'nw' || corner === 'ne' ? bounds.y1 : bounds.y0;
  const items = [...selectedIds]
    .map((id) => {
      const el = getElById(id);
      if (!el) return null;
      const type = elTypeOf(el);
      const base = { id, type, x: Number(el.dataset.x || 0), y: Number(el.dataset.y || 0) };
      if (type === 'image') {
        base.width = Number(el.dataset.width || 200);
      } else if (type === 'text') {
        base.width = el.dataset.width ? Number(el.dataset.width) : el.offsetWidth;
        base.size = Number(el.dataset.size || DEFAULT_TEXT_SIZE);
        base.minHeight = el.dataset.minHeight ? Number(el.dataset.minHeight) : el.offsetHeight;
      } else if (type === 'compare') {
        base.width = Number(el.dataset.width || 200);
        base.height = Number(el.dataset.height || 150);
      }
      return base;
    })
    .filter(Boolean);
  interaction = { mode: 'resize-group', pointerId: event.pointerId, corner, fixedX, fixedY, W, H, items };
  board.setPointerCapture(event.pointerId);
}

function finishCreateText(event) {
  hideTextDraft();
  const world = eventToWorld(event);
  const x = Math.min(interaction.startX, world.x);
  const y = Math.min(interaction.startY, world.y);
  let width = Math.abs(world.x - interaction.startX);
  const height = Math.abs(world.y - interaction.startY);
  if (width < 6) width = 240; // plain click -> default box width
  width = clamp(width, 40, WORLD.width);
  const minHeight = Math.max(Math.round(textSize * 1.4), Math.round(height));
  const id = crypto.randomUUID();
  placeText(
    { id, x, y, text: '', color: textColor, size: textSize, width, minHeight },
    { silent: true },
  );
  beginTextEdit(id);
}

function finishMarquee(event) {
  hideMarquee();
  const world = eventToWorld(event);
  const x0 = Math.min(interaction.startX, world.x);
  const y0 = Math.min(interaction.startY, world.y);
  const x1 = Math.max(interaction.startX, world.x);
  const y1 = Math.max(interaction.startY, world.y);
  const dragged = x1 - x0 > 3 || y1 - y0 > 3;
  if (!dragged) {
    // Plain click on empty space clears; Shift-click keeps current selection.
    if (!interaction.additive) clearSelection();
    return;
  }
  const hits = [];
  const test = (el) => {
    const ex = Number(el.dataset.x || 0);
    const ey = Number(el.dataset.y || 0);
    const ew = el.offsetWidth;
    const eh = el.offsetHeight;
    if (ex < x1 && ex + ew > x0 && ey < y1 && ey + eh > y0) hits.push(el.dataset.id);
  };
  imageLayer.querySelectorAll('.image-item').forEach(test);
  textLayer.querySelectorAll('.text-item').forEach(test);
  compareLayer.querySelectorAll('.compare-item').forEach(test);

  selectedIds.clear();
  if (interaction.additive) interaction.baseIds.forEach((id) => selectedIds.add(id));
  hits.forEach((id) => selectedIds.add(id));
  refreshSelectionUI();
}

function pointerDown(event) {
  if (isPanTrigger(event)) {
    event.preventDefault();
    panSession = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: camera.x,
      originY: camera.y,
    };
    board.setPointerCapture(event.pointerId);
    updateCursor();
    return;
  }

  // While editing a text box with the text tool, clicking outside it should
  // just commit the text (not spawn a new box).
  if (activeTool === 'text' && textEditingId) {
    const editingItem = getTextItem(textEditingId);
    if (editingItem && !editingItem.contains(event.target)) {
      event.preventDefault();
      const body = editingItem.querySelector('.text-body');
      if (body) body.blur();
      return;
    }
  }

  // Group bounding-box resize handle (multi-selection).
  const selHandle = event.target.closest('.sel-handle');
  if (selHandle && activeTool === 'select' && selectedIds.size > 1) {
    event.preventDefault();
    beginGroupResize(event, selHandle.dataset.corner);
    return;
  }

  const item = event.target.closest('.image-item');
  if (item && activeTool === 'select') {
    event.preventDefault();
    const id = item.dataset.id;
    if (event.shiftKey) {
      toggleSelection(id);
      return;
    }
    const handle = event.target.closest('.resize-handle');
    const world = eventToWorld(event);
    const x = Number(item.dataset.x || 0);
    const y = Number(item.dataset.y || 0);
    const width = Number(item.dataset.width || 200);

    if (handle) {
      selectOnly(id);
      const img = item.querySelector('img');
      const aspect =
        img && img.naturalWidth && img.naturalHeight
          ? img.naturalWidth / img.naturalHeight
          : item.offsetWidth / Math.max(1, item.offsetHeight);
      const height = width / aspect;
      const corner = handle.dataset.corner || 'se';
      // Anchor = the corner opposite the one being dragged.
      const fixedX = corner === 'nw' || corner === 'sw' ? x + width : x;
      const fixedY = corner === 'nw' || corner === 'ne' ? y + height : y;
      interaction = {
        mode: 'resize-image',
        id,
        pointerId: event.pointerId,
        corner,
        fixedX,
        fixedY,
        aspect,
      };
      item.setPointerCapture(event.pointerId);
      return;
    }

    // Alt-drag duplicates, then drags the copies (originals stay put).
    if (event.altKey) {
      if (!selectedIds.has(id)) selectOnly(id);
      duplicateSelectionInPlace();
      beginGroupMove(event);
      return;
    }

    // Dragging an already multi-selected item moves the whole group.
    if (selectedIds.has(id) && selectedIds.size > 1) {
      beginGroupMove(event);
      return;
    }

    selectOnly(id);
    interaction = {
      mode: 'move-image',
      id,
      pointerId: event.pointerId,
      offsetX: world.x - x,
      offsetY: world.y - y,
    };
    item.setPointerCapture(event.pointerId);
    return;
  }

  const cmpEl = event.target.closest('.compare-item');
  if (cmpEl && activeTool === 'select') {
    event.preventDefault();
    const id = cmpEl.dataset.id;
    if (event.shiftKey) {
      toggleSelection(id);
      return;
    }
    const handle = event.target.closest('.resize-handle');
    const onDivider = event.target.closest('.compare-divider');

    if (handle) {
      selectOnly(id);
      const x = Number(cmpEl.dataset.x || 0);
      const y = Number(cmpEl.dataset.y || 0);
      const width = Number(cmpEl.dataset.width || 200);
      const height = Number(cmpEl.dataset.height || 150);
      const corner = handle.dataset.corner || 'se';
      const fixedX = corner === 'nw' || corner === 'sw' ? x + width : x;
      const fixedY = corner === 'nw' || corner === 'ne' ? y + height : y;
      interaction = {
        mode: 'resize-compare',
        id,
        pointerId: event.pointerId,
        corner,
        fixedX,
        fixedY,
        aspect: width / Math.max(1, height),
      };
      cmpEl.setPointerCapture(event.pointerId);
      return;
    }

    if (onDivider) {
      selectOnly(id);
      interaction = { mode: 'wipe', id, pointerId: event.pointerId };
      cmpEl.setPointerCapture(event.pointerId);
      return;
    }

    if (event.altKey) {
      if (!selectedIds.has(id)) selectOnly(id);
      duplicateSelectionInPlace();
      beginGroupMove(event);
      return;
    }

    if (selectedIds.has(id) && selectedIds.size > 1) {
      beginGroupMove(event);
      return;
    }

    selectOnly(id);
    const world = eventToWorld(event);
    interaction = {
      mode: 'move-compare',
      id,
      pointerId: event.pointerId,
      offsetX: world.x - Number(cmpEl.dataset.x || 0),
      offsetY: world.y - Number(cmpEl.dataset.y || 0),
    };
    cmpEl.setPointerCapture(event.pointerId);
    return;
  }

  const textEl = event.target.closest('.text-item');
  if (textEl && (activeTool === 'select' || activeTool === 'text')) {
    const id = textEl.dataset.id;
    if (activeTool === 'select' && event.shiftKey) {
      event.preventDefault();
      toggleSelection(id);
      return;
    }
    const textHandle = event.target.closest('.resize-handle');

    // Resize the text box by dragging a corner handle (select mode).
    if (activeTool === 'select' && textHandle) {
      event.preventDefault();
      selectOnly(id);
      const x = Number(textEl.dataset.x || 0);
      const y = Number(textEl.dataset.y || 0);
      const width = textEl.dataset.width ? Number(textEl.dataset.width) : textEl.offsetWidth;
      const height = textEl.dataset.minHeight
        ? Number(textEl.dataset.minHeight)
        : textEl.offsetHeight;
      const corner = textHandle.dataset.corner || 'se';
      const fixedX = corner === 'nw' || corner === 'sw' ? x + width : x;
      const fixedY = corner === 'nw' || corner === 'ne' ? y + height : y;
      interaction = {
        mode: 'resize-text',
        id,
        pointerId: event.pointerId,
        corner,
        fixedX,
        fixedY,
      };
      textEl.setPointerCapture(event.pointerId);
      return;
    }

    if (activeTool === 'text') {
      if (textEditingId === id) return; // already editing -> allow native caret placement
      event.preventDefault();
      beginTextEdit(id);
      return;
    }
    // select mode: select the text and prepare to drag it
    event.preventDefault();
    if (event.altKey) {
      if (!selectedIds.has(id)) selectOnly(id);
      duplicateSelectionInPlace();
      beginGroupMove(event);
      return;
    }
    if (selectedIds.has(id) && selectedIds.size > 1) {
      beginGroupMove(event);
      return;
    }
    selectOnly(id);
    const world = eventToWorld(event);
    interaction = {
      mode: 'move-text',
      id,
      pointerId: event.pointerId,
      offsetX: world.x - Number(textEl.dataset.x || 0),
      offsetY: world.y - Number(textEl.dataset.y || 0),
    };
    textEl.setPointerCapture(event.pointerId);
    return;
  }

  if (event.button !== 0) {
    clearSelection();
    return;
  }

  if (activeTool === 'select') {
    // Drag an empty area to marquee-select multiple objects.
    event.preventDefault();
    const world = eventToWorld(event);
    interaction = {
      mode: 'marquee',
      pointerId: event.pointerId,
      startX: world.x,
      startY: world.y,
      additive: event.shiftKey,
      baseIds: event.shiftKey ? [...selectedIds] : [],
    };
    board.setPointerCapture(event.pointerId);
    updateMarquee(world.x, world.y, 0, 0);
    return;
  }

  clearSelection();

  if (activeTool === 'text') {
    // Drag to draw a fixed-width text box (Figma-style); a plain click makes a default box.
    event.preventDefault();
    const world = eventToWorld(event);
    interaction = {
      mode: 'create-text',
      pointerId: event.pointerId,
      startX: world.x,
      startY: world.y,
    };
    board.setPointerCapture(event.pointerId);
    return;
  }

  if (activeTool === 'eraser') {
    isDrawing = true;
    lastPoint = eventToWorld(event);
    eraserPath = [{ ...lastPoint }];
    const radius = getEraserRadius();
    eraseWithCapsule(lastPoint, lastPoint, radius);
    lastEraserSyncPoint = { ...lastPoint };
    broadcast('erase-segment', {
      from: lastPoint,
      to: lastPoint,
      size: Number(brushSize.value),
    });
    lastEraserSyncAt = Date.now();
    return;
  }
  isDrawing = true;
  lastPoint = eventToWorld(event);
  activeStroke = {
    id: crypto.randomUUID(),
    color: me.color,
    size: Number(brushSize.value),
    tool: activeTool,
    points: [{ ...lastPoint }],
  };
  renderStroke(activeStroke);
  liveStrokes.set(activeStroke.id, activeStroke);
  broadcast('stroke-start', {
    id: activeStroke.id,
    color: activeStroke.color,
    size: activeStroke.size,
    tool: activeStroke.tool,
    point: lastPoint,
  });
}

function pointerMove(event) {
  showToolCursor(event.clientX, event.clientY);

  if (panSession && event.pointerId === panSession.pointerId) {
    camera.x = panSession.originX + (event.clientX - panSession.startX);
    camera.y = panSession.originY + (event.clientY - panSession.startY);
    updateViewportTransform();
    return;
  }

  if (interaction && event.pointerId === interaction.pointerId) {
    const world = eventToWorld(event);

    if (interaction.mode === 'marquee') {
      updateMarquee(
        Math.min(interaction.startX, world.x),
        Math.min(interaction.startY, world.y),
        Math.abs(world.x - interaction.startX),
        Math.abs(world.y - interaction.startY),
      );
      return;
    }

    if (interaction.mode === 'create-text') {
      updateTextDraft(
        Math.min(interaction.startX, world.x),
        Math.min(interaction.startY, world.y),
        Math.abs(world.x - interaction.startX),
        Math.abs(world.y - interaction.startY),
      );
      return;
    }

    if (interaction.mode === 'move-group') {
      const dx = world.x - interaction.startWorldX;
      const dy = world.y - interaction.startWorldY;
      let sdx = 0;
      let sdy = 0;
      if (interaction.bbox) {
        const excl = new Set(interaction.items.map((i) => i.id));
        const snap = computeSnap(
          {
            x: interaction.bbox.x0 + dx,
            y: interaction.bbox.y0 + dy,
            w: interaction.bbox.x1 - interaction.bbox.x0,
            h: interaction.bbox.y1 - interaction.bbox.y0,
          },
          collectSnapTargets(excl),
        );
        sdx = snap.dx;
        sdy = snap.dy;
        showSnapGuides(snap.guideX, snap.guideY);
      }
      interaction.items.forEach((it) => {
        const nx = it.startX + dx + sdx;
        const ny = it.startY + dy + sdy;
        if (it.type === 'image') {
          placeImage({ ...getImagePayload(it.id), x: nx, y: ny }, { silent: true });
        } else if (it.type === 'text') {
          placeText({ ...getTextPayload(it.id), x: nx, y: ny }, { silent: true });
        } else if (it.type === 'compare') {
          placeCompare({ ...getComparePayload(it.id), x: nx, y: ny }, { silent: true });
        }
      });
      if (dragSyncDue()) interaction.items.forEach((it) => liveBroadcast(it.id));
      updateSelectionBox();
      return;
    }

    if (interaction.mode === 'resize-group') {
      const excl = new Set(interaction.items.map((i) => i.id));
      const r = snapAspectResize(world, interaction, interaction.W / interaction.H, excl);
      const s = clamp(r.width / interaction.W, 0.05, 50);
      showSnapGuides(r.guideX, r.guideY);
      interaction.items.forEach((it) => {
        const nx = interaction.fixedX + (it.x - interaction.fixedX) * s;
        const ny = interaction.fixedY + (it.y - interaction.fixedY) * s;
        if (it.type === 'image') {
          placeImage(
            { ...getImagePayload(it.id), x: nx, y: ny, width: it.width * s },
            { silent: true },
          );
        } else if (it.type === 'text') {
          placeText(
            {
              ...getTextPayload(it.id),
              x: nx,
              y: ny,
              width: it.width * s,
              size: Math.max(6, Math.round(it.size * s)),
              minHeight: it.minHeight * s,
            },
            { silent: true },
          );
        } else if (it.type === 'compare') {
          placeCompare(
            { ...getComparePayload(it.id), x: nx, y: ny, width: it.width * s, height: it.height * s },
            { silent: true },
          );
        }
      });
      if (dragSyncDue()) interaction.items.forEach((it) => liveBroadcast(it.id));
      updateSelectionBox();
      return;
    }

    if (interaction.mode === 'resize-text') {
      const payload = getTextPayload(interaction.id);
      if (payload) {
        const th = SNAP_PX / camera.zoom;
        const excl = new Set([interaction.id]);
        const sx = snapValue(world.x, snapLinesX(excl), th);
        const sy = snapValue(world.y, snapLinesY(excl), th);
        const newWidth = clamp(Math.abs(sx.snapped - interaction.fixedX), 24, WORLD.width);
        const minH = Math.max(20, Math.round(payload.size * 1.2));
        const newHeight = clamp(Math.abs(sy.snapped - interaction.fixedY), minH, WORLD.height);
        const isLeft = interaction.corner === 'nw' || interaction.corner === 'sw';
        const isTop = interaction.corner === 'nw' || interaction.corner === 'ne';
        const newX = isLeft ? interaction.fixedX - newWidth : interaction.fixedX;
        const newY = isTop ? interaction.fixedY - newHeight : interaction.fixedY;
        showSnapGuides(sx.guide, sy.guide);
        placeText(
          { ...payload, x: newX, y: newY, width: newWidth, minHeight: newHeight },
          { silent: true },
        );
        if (dragSyncDue()) liveBroadcast(interaction.id);
      }
      return;
    }

    if (interaction.mode === 'move-text') {
      const textItem = getTextItem(interaction.id);
      if (textItem) {
        const p = applySnap(
          new Set([interaction.id]),
          world.x - interaction.offsetX,
          world.y - interaction.offsetY,
          textItem.offsetWidth,
          textItem.offsetHeight,
        );
        placeText({ ...getTextPayload(interaction.id), x: p.x, y: p.y }, { silent: true });
        if (dragSyncDue()) liveBroadcast(interaction.id);
      }
      return;
    }

    if (interaction.mode === 'wipe') {
      const cmp = getCompareItem(interaction.id);
      if (cmp) {
        const W = Number(cmp.dataset.width || 1);
        // .compare-item has a 2px border (box-sizing: border-box), so the
        // frame is W-4 wide and inset 2px from the item's outer-left.
        const innerW = Math.max(1, W - COMPARE_BORDER * 2);
        const localX = world.x - Number(cmp.dataset.x || 0) - COMPARE_BORDER;
        const split = clamp(localX / innerW, 0, 1);
        cmp.dataset.split = String(split);
        applyCompareLayout(cmp);
        if (dragSyncDue()) liveBroadcast(interaction.id);
      }
      return;
    }

    if (interaction.mode === 'move-compare') {
      const cmp = getCompareItem(interaction.id);
      if (cmp) {
        const p = applySnap(
          new Set([interaction.id]),
          world.x - interaction.offsetX,
          world.y - interaction.offsetY,
          cmp.offsetWidth,
          cmp.offsetHeight,
        );
        placeCompare({ ...getComparePayload(interaction.id), x: p.x, y: p.y }, { silent: true });
        if (dragSyncDue()) liveBroadcast(interaction.id);
      }
      return;
    }

    if (interaction.mode === 'resize-compare') {
      const payload = getComparePayload(interaction.id);
      if (payload) {
        const r = snapAspectResize(world, interaction, interaction.aspect, new Set([interaction.id]));
        const newWidth = clamp(r.width, 40, WORLD.width);
        const newHeight = newWidth / interaction.aspect;
        const isLeft = interaction.corner === 'nw' || interaction.corner === 'sw';
        const isTop = interaction.corner === 'nw' || interaction.corner === 'ne';
        const newX = isLeft ? interaction.fixedX - newWidth : interaction.fixedX;
        const newY = isTop ? interaction.fixedY - newHeight : interaction.fixedY;
        showSnapGuides(r.guideX, r.guideY);
        placeCompare(
          { ...payload, x: newX, y: newY, width: newWidth, height: newHeight },
          { silent: true },
        );
        if (dragSyncDue()) liveBroadcast(interaction.id);
      }
      return;
    }

    const item = getImageItem(interaction.id);
    if (!item) return;

    if (interaction.mode === 'move-image') {
      const p = applySnap(
        new Set([interaction.id]),
        world.x - interaction.offsetX,
        world.y - interaction.offsetY,
        item.offsetWidth,
        item.offsetHeight,
      );
      placeImage({ ...getImagePayload(interaction.id), x: p.x, y: p.y }, { silent: true });
      if (dragSyncDue()) liveBroadcast(interaction.id);
    } else if (interaction.mode === 'resize-image') {
      const r = snapAspectResize(world, interaction, interaction.aspect, new Set([interaction.id]));
      const newWidth = clamp(r.width, 40, WORLD.width);
      const newHeight = newWidth / interaction.aspect;
      const isLeft = interaction.corner === 'nw' || interaction.corner === 'sw';
      const isTop = interaction.corner === 'nw' || interaction.corner === 'ne';
      const newX = isLeft ? interaction.fixedX - newWidth : interaction.fixedX;
      const newY = isTop ? interaction.fixedY - newHeight : interaction.fixedY;
      showSnapGuides(r.guideX, r.guideY);
      placeImage(
        { ...getImagePayload(interaction.id), x: newX, y: newY, width: newWidth },
        { silent: true },
      );
      if (dragSyncDue()) liveBroadcast(interaction.id);
    }

    return;
  }

  if (!isDrawing || !lastPoint) return;
  const current = eventToWorld(event);
  const dx = current.x - lastPoint.x;
  const dy = current.y - lastPoint.y;
  const distance = Math.hypot(dx, dy);
  if (distance < 0.3) {
    return;
  }
  if (activeTool === 'eraser') {
    eraseWithCapsule(lastPoint, current, getEraserRadius());
    eraserPath.push({ ...current });
    const now = Date.now();
    if (now - lastEraserSyncAt >= ERASER_SYNC_THROTTLE_MS) {
      broadcast('erase-segment', {
        from: lastEraserSyncPoint || lastPoint,
        to: current,
        size: Number(brushSize.value),
      });
      lastEraserSyncPoint = { ...current };
      lastEraserSyncAt = now;
    }
    lastPoint = current;
    return;
  }
  if (!activeStroke) return;
  activeStroke.points.push({ ...current });
  renderStroke(activeStroke);
  broadcast('stroke-append', {
    id: activeStroke.id,
    point: current,
  });
  lastPoint = current;
}

function pointerUp(event) {
  if (panSession && event.pointerId === panSession.pointerId) {
    panSession = null;
    updateCursor();
  }

  if (interaction && event.pointerId === interaction.pointerId) {
    const mode = interaction.mode;
    if (mode === 'marquee') {
      finishMarquee(event);
    } else if (mode === 'create-text') {
      finishCreateText(event);
    } else if (mode === 'move-group') {
      interaction.items.forEach((it) => {
        if (it.type === 'image') {
          const p = getImagePayload(it.id);
          if (p) broadcast('image-update', p);
        } else if (it.type === 'text') {
          const p = getTextPayload(it.id);
          if (p) broadcast('text-update', p);
        } else if (it.type === 'compare') {
          const p = getComparePayload(it.id);
          if (p) broadcast('compare-update', p);
        }
      });
      pushHistory('move-group');
      updateSelectionBox();
    } else if (mode === 'resize-group') {
      interaction.items.forEach((it) => {
        if (it.type === 'image') {
          const p = getImagePayload(it.id);
          if (p) broadcast('image-update', p);
        } else if (it.type === 'text') {
          const p = getTextPayload(it.id);
          if (p) broadcast('text-update', p);
        } else if (it.type === 'compare') {
          const p = getComparePayload(it.id);
          if (p) broadcast('compare-update', p);
        }
      });
      pushHistory('resize-group');
      updateSelectionBox();
    } else if (mode === 'move-text' || mode === 'resize-text') {
      const payload = getTextPayload(interaction.id);
      if (payload) {
        broadcast('text-update', payload);
        pushHistory(mode === 'resize-text' ? 'text-resize' : 'text-move');
      }
    } else if (mode === 'wipe' || mode === 'move-compare' || mode === 'resize-compare') {
      const payload = getComparePayload(interaction.id);
      if (payload) {
        broadcast('compare-update', payload);
        pushHistory(`compare-${mode}`);
      }
    } else {
      const payload = getImagePayload(interaction.id);
      if (payload) {
        broadcast('image-update', payload);
        pushHistory('image-transform');
      }
    }
    hideSnapGuides();
    interaction = null;
  }

  if (isDrawing && event.button === 0) {
    if (activeTool === 'eraser') {
      // Authoritative final erase: replay the whole eraser path so peers that
      // dropped some incremental erase-segment messages still converge.
      if (eraserPath.length) {
        broadcast('erase-path', {
          points: eraserPath.map((p) => ({ ...p })),
          size: Number(brushSize.value),
        });
      }
      pushHistory('erase-stroke');
      isDrawing = false;
      lastPoint = null;
      lastEraserSyncPoint = null;
      eraserPath = [];
      activeStroke = null;
      return;
    }
    if (activeStroke) {
      drawingOps.push({
        id: activeStroke.id,
        color: activeStroke.color,
        size: activeStroke.size,
        tool: activeStroke.tool,
        points: activeStroke.points.map((point) => ({ ...point })),
      });
      liveStrokes.delete(activeStroke.id);
      // Send the COMPLETE stroke (not just the id) so a peer renders the full
      // line even if some stroke-append messages were lost or reordered.
      broadcast('stroke-end', {
        id: activeStroke.id,
        color: activeStroke.color,
        size: activeStroke.size,
        tool: activeStroke.tool,
        points: activeStroke.points.map((point) => ({ ...point })),
      });
    }
    pushHistory('draw-stroke');
  }
  isDrawing = false;
  lastPoint = null;
  activeStroke = null;
}

function broadcastImageOrder() {
  const order = [...imageLayer.querySelectorAll('.image-item')].map((item) => item.dataset.id);
  broadcast('image-order', { order });
}

function moveSelectedImageLayer(direction) {
  if (!selectedImageId) return;
  const item = getImageItem(selectedImageId);
  if (!item) return;

  if (direction === 'front') {
    imageLayer.appendChild(item);
  } else if (direction === 'back') {
    imageLayer.prepend(item);
  } else if (direction === 'forward') {
    const next = item.nextElementSibling;
    if (!next) return;
    imageLayer.insertBefore(next, item);
  } else if (direction === 'backward') {
    const prev = item.previousElementSibling;
    if (!prev) return;
    imageLayer.insertBefore(item, prev);
  }

  syncImageZIndices();
  broadcastImageOrder();
  pushHistory(`reorder-image-${direction}`);
}

layerButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    moveSelectedImageLayer(btn.dataset.layerAction);
  });
});

board.addEventListener('pointerdown', pointerDown);
board.addEventListener('pointermove', pointerMove);
board.addEventListener('pointerenter', (event) => {
  showToolCursor(event.clientX, event.clientY);
});
board.addEventListener('pointerleave', hideToolCursor);
window.addEventListener('pointerup', pointerUp);
board.addEventListener(
  'wheel',
  (event) => {
    const zoomGesture = event.ctrlKey || event.metaKey;
    if (zoomGesture) {
      event.preventDefault();
      const delta = -event.deltaY * 0.0015;
      zoomAt(camera.zoom * (1 + delta), event.clientX, event.clientY);
      return;
    }

    event.preventDefault();
    const speed = 1;
    const panX = event.shiftKey ? -event.deltaY * speed : -event.deltaX * speed;
    const panY = event.shiftKey ? 0 : -event.deltaY * speed;
    panBy(panX, panY);
  },
  { passive: false },
);

window.addEventListener('keydown', (event) => {
  if (!isTypingTarget(event.target) && !event.ctrlKey && !event.metaKey && !event.altKey) {
    const loweredKey = event.key.toLowerCase();
    if (loweredKey === 'v') {
      event.preventDefault();
      setTool('select');
      return;
    }
    if (loweredKey === 'b') {
      event.preventDefault();
      setTool('pen');
      return;
    }
    if (loweredKey === 't') {
      event.preventDefault();
      setTool('text');
      return;
    }
    if (loweredKey === 'e') {
      event.preventDefault();
      setTool('eraser');
      return;
    }
  }

  if (event.code === 'Space' && !isTypingTarget(event.target)) {
    if (!isSpacePressed) {
      isSpacePressed = true;
      updateCursor();
    }
    event.preventDefault();
    return;
  }

  const mod = event.ctrlKey || event.metaKey;
  if (!mod) return;

  if (event.key === '=' || event.key === '+') {
    event.preventDefault();
    const rect = board.getBoundingClientRect();
    zoomAt(camera.zoom + 0.1, rect.left + rect.width / 2, rect.top + rect.height / 2);
    return;
  }
  if (event.key === '-') {
    event.preventDefault();
    const rect = board.getBoundingClientRect();
    zoomAt(camera.zoom - 0.1, rect.left + rect.width / 2, rect.top + rect.height / 2);
    return;
  }
  if (event.key === '0') {
    event.preventDefault();
    const rect = board.getBoundingClientRect();
    camera.zoom = 1;
    camera.x = rect.width / 2 - WORLD.width / 2;
    camera.y = rect.height / 2 - WORLD.height / 2;
    updateViewportTransform();
    return;
  }

  const loweredKey = event.key.toLowerCase();
  if (loweredKey === 'z') {
    event.preventDefault();
    if (event.shiftKey) {
      redo();
    } else {
      undo();
    }
    return;
  }

  if (loweredKey === 'y') {
    event.preventDefault();
    redo();
    return;
  }

  if (loweredKey === 'c' && selectedIds.size > 0 && !isTypingTarget(event.target)) {
    event.preventDefault();
    clipboardElements = [...selectedIds]
      .map((id) => {
        const type = elTypeOf(getElById(id));
        if (type === 'image') return { _type: 'image', ...getImagePayload(id) };
        if (type === 'text') return { _type: 'text', ...getTextPayload(id) };
        if (type === 'compare') return { _type: 'compare', ...getComparePayload(id) };
        return null;
      })
      .filter(Boolean);
    return;
  }

  if (loweredKey === 'v') {
    if (!clipboardElements.length || isTypingTarget(event.target)) return;
    event.preventDefault();
    const newIds = [];
    clipboardElements.forEach((src) => {
      const id = crypto.randomUUID();
      const payload = { ...src, id, x: (src.x || 0) + 24, y: (src.y || 0) + 24 };
      if (src._type === 'image') {
        placeImage(payload, { silent: true });
        broadcast('image-update', getImagePayload(id));
      } else if (src._type === 'text') {
        placeText(payload, { silent: true });
        broadcast('text-update', getTextPayload(id));
      } else if (src._type === 'compare') {
        placeCompare(payload, { silent: true });
        broadcast('compare-update', getComparePayload(id));
      }
      newIds.push(id);
    });
    selectedIds.clear();
    newIds.forEach((id) => selectedIds.add(id));
    refreshSelectionUI();
    pushHistory('paste-elements');
    return;
  }

  if (event.key === ']' && selectedImageId) {
    event.preventDefault();
    if (event.shiftKey) {
      moveSelectedImageLayer('front');
    } else {
      moveSelectedImageLayer('forward');
    }
    return;
  }

  if (event.key === '[' && selectedImageId) {
    event.preventDefault();
    if (event.shiftKey) {
      moveSelectedImageLayer('back');
    } else {
      moveSelectedImageLayer('backward');
    }
  }
});

window.addEventListener('keyup', (event) => {
  if (event.code === 'Space') {
    isSpacePressed = false;
    updateCursor();
  }
});

window.addEventListener('resize', resizeCanvas);
resizeCanvas();

displayNameInput.value = me.name;
displayNameInput.addEventListener('input', () => {
  me.name = displayNameInput.value.trim() || `User-${clientId.slice(0, 4)}`;
  syncPresence();
  renderPresence();
});

function applySelectedColor(nextColor) {
  me.color = nextColor;
  if (colorSwatch) {
    colorSwatch.style.background = me.color;
  }
  syncPresence();
  renderPresence();
}

colorPicker.value = me.color;
if (colorSwatch) {
  colorSwatch.style.background = me.color;
}
if (colorButton) {
  colorButton.addEventListener('click', () => {
    colorPicker.click();
  });
}
colorPicker.addEventListener('input', () => {
  applySelectedColor(colorPicker.value);
});
colorPicker.addEventListener('change', () => {
  applySelectedColor(colorPicker.value);
});

brushSize.addEventListener('input', () => {
  if (brushSizeValue) brushSizeValue.textContent = String(brushSize.value);
  updateToolCursorSize();
});

// --- Text options (size + color) -------------------------------------------
function applyTextSizeLive(size) {
  textSize = clamp(Math.round(size), 10, 400);
  if (textSizeValue) textSizeValue.textContent = String(textSize);
  if (selectedTextId) {
    const item = getTextItem(selectedTextId);
    if (item) {
      item.dataset.size = String(textSize);
      item.style.fontSize = `${textSize}px`;
      broadcastTextUpdateThrottled(selectedTextId);
    }
  }
}

function applyTextColorLive(color) {
  textColor = color;
  if (textColorSwatch) textColorSwatch.style.background = color;
  if (selectedTextId) {
    const item = getTextItem(selectedTextId);
    if (item) {
      item.dataset.color = color;
      item.style.color = color;
      broadcastTextUpdateThrottled(selectedTextId);
    }
  }
}

if (textSizeInput) {
  textSizeInput.addEventListener('input', () => applyTextSizeLive(Number(textSizeInput.value)));
  textSizeInput.addEventListener('change', () => {
    applyTextSizeLive(Number(textSizeInput.value));
    if (selectedTextId) {
      broadcast('text-update', getTextPayload(selectedTextId));
      pushHistory('text-size');
    }
  });
}

if (textColorPicker) {
  textColorPicker.addEventListener('input', () => applyTextColorLive(textColorPicker.value));
  textColorPicker.addEventListener('change', () => {
    applyTextColorLive(textColorPicker.value);
    if (selectedTextId) {
      broadcast('text-update', getTextPayload(selectedTextId));
      pushHistory('text-color');
    }
  });
}

if (textColorButton) {
  textColorButton.addEventListener('click', () => textColorPicker.click());
}
if (textColorSwatch) textColorSwatch.style.background = textColor;

toolButtons.forEach((btn) => {
  btn.addEventListener('click', () => setTool(btn.dataset.tool));
});

imageInput.addEventListener('change', (event) => {
  const files = [...(event.target.files || [])];
  if (!files.length) return;
  const center = viewportCenterWorld();
  files.forEach((file, index) => {
    importImageFile(file, {
      x: center.x - 110 + index * 24,
      y: center.y - 70 + index * 24,
    });
  });
  event.target.value = '';
});

function importImageFile(file, point = { x: 30, y: 30 }) {
  if (!file || !file.type.startsWith('image/')) return;
  const reader = new FileReader();
  reader.onload = () => {
    const payload = {
      id: crypto.randomUUID(),
      src: String(reader.result),
      x: clamp(point.x, -WORLD.width, WORLD.width),
      y: clamp(point.y, -WORLD.height, WORLD.height),
      width: 220,
    };
    placeImage(payload, { silent: true });
    selectOnly(payload.id);
    broadcast('image-update', payload);
    pushHistory('import-image');
  };
  reader.readAsDataURL(file);
}

function uniqueImageFiles(files) {
  const seen = new Set();
  return files.filter((file) => {
    if (!file || !file.type.startsWith('image/')) return false;
    const key = [file.name, file.type, file.size, file.lastModified].join('::');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

board.addEventListener('dragover', (event) => {
  if ([...(event.dataTransfer?.types || [])].includes('Files')) {
    event.preventDefault();
  }
});

board.addEventListener('drop', (event) => {
  event.preventDefault();
  const files = [...(event.dataTransfer?.files || [])].filter((file) => file.type.startsWith('image/'));
  if (!files.length) return;
  const world = eventToWorld(event);
  files.forEach((file, index) => {
    importImageFile(file, {
      x: world.x - 110 + index * 20,
      y: world.y - 60 + index * 20,
    });
  });
});

window.addEventListener('paste', (event) => {
  if (isTypingTarget(event.target)) return;

  const clipboard = event.clipboardData;
  if (!clipboard) return;

  // A pasted image usually appears in BOTH clipboardData.files and
  // clipboardData.items, which previously caused the same image to be added
  // twice. Use files when available, and only fall back to items otherwise.
  let files = [...(clipboard.files || [])].filter((file) => file.type.startsWith('image/'));
  if (!files.length) {
    files = [...(clipboard.items || [])]
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter(Boolean);
  }
  files = uniqueImageFiles(files);
  if (!files.length) return;

  event.preventDefault();
  const centerWorld = viewportCenterWorld();

  files.forEach((file, index) => {
    importImageFile(file, {
      x: centerWorld.x - 120 + index * 24,
      y: centerWorld.y - 70 + index * 24,
    });
  });
});

clearCanvasBtn.addEventListener('click', () => {
  drawingOps = [];
  liveStrokes.clear();
  renderDrawingFromOps();
  broadcast('clear-drawing');
  pushHistory('clear-drawing');
});

resetBoardBtn.addEventListener('click', () => {
  drawingOps = [];
  liveStrokes.clear();
  renderDrawingFromOps();
  imageLayer.innerHTML = '';
  syncImageZIndices();
  setSelectedImage(null);
  textLayer.innerHTML = '';
  selectedTextId = null;
  textEditingId = null;
  compareLayer.innerHTML = '';
  broadcast('reset-all');
  pushHistory('reset-board');
});

if (makeCompareBtn) {
  makeCompareBtn.addEventListener('click', () => {
    createCompareFromSelection();
  });
}

window.addEventListener('keydown', (event) => {
  if (isHomeOpen()) {
    if (event.key === 'Escape') closeHome();
    return;
  }
  if (isTypingTarget(event.target)) return;
  if (event.key === 'Delete' || event.key === 'Backspace') {
    if (selectedIds.size === 0) return;
    event.preventDefault();
    [...selectedIds].forEach((id) => {
      if (getImageItem(id)) removeImage(id);
      else if (getTextItem(id)) removeText(id);
      else if (getCompareItem(id)) removeCompare(id);
    });
    clearSelection();
    pushHistory('delete-selection');
  }
});

function handleRealtimeMessage(message) {
  if (!message) return;
  if (isKnownMessage(message.id)) return;
  rememberMessageId(message.id);

  const { type, source, payload } = message;
  if (source === clientId) return;
  if (isOlderThanBoardStateBarrier(message)) return;
  // Per-object send-order guard: drop a same-source message that arrives after a
  // newer one for the same object (prevents a reordered stroke-end from undoing
  // an undo's stroke-remove, etc.). Record the seq for ops we will apply.
  if (GUARDED_OBJECT_OPS.has(type)) {
    if (isStaleObjectOp(message)) return;
    noteObjectOp(message);
  }
  const isTransient = payload?.transient === true;
  let shouldRecordRemoteHistory = false;

  if (type === 'stroke-start' && payload?.id && payload?.point) {
    const remoteStroke = {
      id: payload.id,
      color: payload.color || '#000000',
      size: Number(payload.size || 4),
      tool: payload.tool || 'pen',
      points: [{ ...payload.point }],
    };
    liveStrokes.set(remoteStroke.id, remoteStroke);
    renderStroke(remoteStroke);
  }
  if (type === 'stroke-append' && payload?.id && payload?.point) {
    const remoteStroke = liveStrokes.get(payload.id);
    if (remoteStroke) {
      remoteStroke.points.push({ ...payload.point });
      renderStroke(remoteStroke);
    }
  }
  if (type === 'stroke-end' && payload?.id) {
    const remoteStroke = liveStrokes.get(payload.id);
    // Prefer the authoritative full points carried by stroke-end; fall back to
    // whatever was accumulated from stroke-append messages.
    const finalPoints =
      Array.isArray(payload.points) && payload.points.length
        ? payload.points.map((point) => ({ ...point }))
        : remoteStroke
          ? remoteStroke.points.map((point) => ({ ...point }))
          : null;
    if (finalPoints) {
      const finalStroke = {
        id: payload.id,
        color: (remoteStroke && remoteStroke.color) || payload.color || '#000000',
        size: Number((remoteStroke && remoteStroke.size) ?? payload.size ?? 4),
        tool: (remoteStroke && remoteStroke.tool) || payload.tool || 'pen',
        points: finalPoints,
      };
      // Remove any partial live copy and de-dupe, then commit the full stroke.
      removeStrokePath(payload.id);
      drawingOps = drawingOps.filter((s) => s.id !== payload.id);
      liveStrokes.delete(payload.id);
      drawingOps.push(finalStroke);
      renderStroke(finalStroke);
      shouldRecordRemoteHistory = true;
    }
  }
  if (type === 'stroke-remove' && payload?.id) {
    // A peer's undo/redo removed this stroke. Drop it locally too.
    removeStrokePath(payload.id);
    drawingOps = drawingOps.filter((stroke) => stroke.id !== payload.id);
    liveStrokes.delete(payload.id);
    shouldRecordRemoteHistory = true;
  }
  if (type === 'draw' && payload?.from && payload?.to) {
    const fallbackStroke = {
      id: crypto.randomUUID(),
      color: payload.color || '#000000',
      size: Number(payload.size || 4),
      tool: payload.tool || 'pen',
      points: [{ ...payload.from }, { ...payload.to }],
    };
    drawingOps.push(fallbackStroke);
    renderStroke(fallbackStroke);
    shouldRecordRemoteHistory = true;
  }
  if (type === 'clear-drawing') {
    drawingOps = [];
    liveStrokes.clear();
    renderDrawingFromOps();
    shouldRecordRemoteHistory = true;
  }
  if (type === 'erase-point' && payload?.point) {
    const r = Number(payload.size || 4) / 2;
    eraseWithCapsule(payload.point, payload.point, r);
  }
  if (type === 'erase-segment' && payload?.from && payload?.to) {
    const r = Number(payload.size || 4) / 2;
    eraseWithCapsule(payload.from, payload.to, r);
  }
  if (type === 'erase-path' && Array.isArray(payload?.points)) {
    // Authoritative final erase: replay the whole path so dropped segments converge.
    const r = Number(payload.size || 4) / 2;
    const pts = payload.points;
    if (pts.length === 1) {
      eraseWithCapsule(pts[0], pts[0], r);
    } else {
      for (let i = 1; i < pts.length; i += 1) {
        eraseWithCapsule(pts[i - 1], pts[i], r);
      }
    }
    shouldRecordRemoteHistory = true;
  }
  if (type === 'reset-all') {
    drawingOps = [];
    liveStrokes.clear();
    renderDrawingFromOps();
    imageLayer.innerHTML = '';
    syncImageZIndices();
    setSelectedImage(null);
    textLayer.innerHTML = '';
    selectedTextId = null;
    textEditingId = null;
    compareLayer.innerHTML = '';
    shouldRecordRemoteHistory = true;
  }
  if (type === 'image-update' && payload?.id) {
    placeImage(payload, { silent: true });
    if (!isTransient) shouldRecordRemoteHistory = true;
  }
  if (type === 'image-remove' && payload?.id) {
    removeImage(payload.id, { silent: true });
    shouldRecordRemoteHistory = true;
  }
  if (type === 'text-update' && payload?.id) {
    placeText(payload, { silent: true });
    if (!isTransient) shouldRecordRemoteHistory = true;
  }
  if (type === 'text-remove' && payload?.id) {
    removeText(payload.id, { silent: true });
    shouldRecordRemoteHistory = true;
  }
  if (type === 'compare-update' && payload?.id) {
    placeCompare(payload, { silent: true });
    if (!isTransient) shouldRecordRemoteHistory = true;
  }
  if (type === 'compare-remove' && payload?.id) {
    removeCompare(payload.id, { silent: true });
    shouldRecordRemoteHistory = true;
  }
  if (type === 'image-order' && payload?.order) {
    payload.order.forEach((id) => {
      const item = getImageItem(id);
      if (item) imageLayer.appendChild(item);
    });
    syncImageZIndices();
    shouldRecordRemoteHistory = true;
  }
  if (type === 'board-state') {
    rememberBoardStateBarrier(message);
    restoreBoardState(payload, { recordHistory: true });
    return;
  }

  if (type === 'presence' && payload?.user) {
    peers.set(payload.user.id, payload.user);
    renderPresence();
  }

  if (shouldRecordRemoteHistory) {
    recordCurrentStateInHistory();
  }
}

if (channel) {
  channel.onmessage = (event) => {
    const message = normalizeInboundMessage(event.data);
    if (message) handleRealtimeMessage(message);
  };
}

initializeCanvasHome();

if (!isHomeRoute()) {
  connectSyncStream();
  setTool('pen');
  syncPresence();
  renderPresence();
  pushHistory('initial');
  setInterval(() => {
    syncPresence();
    renderPresence();
  }, 5000);
}

window.addEventListener('blur', () => {
  isSpacePressed = false;
  panSession = null;
  interaction = null;
  isDrawing = false;
  lastPoint = null;
  lastEraserSyncPoint = null;
  activeStroke = null;
  hideSnapGuides();
  hideToolCursor();
  updateCursor();
});
