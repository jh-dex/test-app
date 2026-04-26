const channel = new BroadcastChannel('live-board-mvp');

const board = document.getElementById('board');
const viewport = document.getElementById('viewport');
const canvas = document.getElementById('drawCanvas');
const ctx = canvas.getContext('2d');
const imageLayer = document.getElementById('imageLayer');
const zoomBadge = document.getElementById('zoomBadge');
const presence = document.getElementById('presence');
const displayNameInput = document.getElementById('displayName');
const colorPicker = document.getElementById('colorPicker');
const brushSize = document.getElementById('brushSize');
const imageInput = document.getElementById('imageInput');
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
let activeTool = 'select';
let isDrawing = false;
let lastPoint = null;
let interaction = null;
let selectedImageId = null;
let isSpacePressed = false;
let panSession = null;
let isRestoringHistory = false;
const history = [];
let historyIndex = -1;
let copiedImagePayload = null;
let drawingOps = [];
let historyFingerprint = '';

const camera = {
  x: 0,
  y: 0,
  zoom: 1,
};
const peers = new Map();

function resizeCanvas() {
  const pixelRatio = window.devicePixelRatio || 1;
  canvas.width = WORLD.width * pixelRatio;
  canvas.height = WORLD.height * pixelRatio;
  canvas.style.width = `${WORLD.width}px`;
  canvas.style.height = `${WORLD.height}px`;

  ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

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

function isTypingTarget(target) {
  if (!target) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable;
}

function updateCursor() {
  const isPanning = Boolean(panSession);
  if (isPanning) {
    board.style.cursor = 'grabbing';
    return;
  }
  if (isSpacePressed) {
    board.style.cursor = 'grab';
    return;
  }
  if (activeTool === 'select') {
    board.style.cursor = selectedImageId ? 'move' : 'default';
    return;
  }
  board.style.cursor = activeTool === 'eraser' ? 'cell' : 'crosshair';
}

function updateZoomUI() {
  zoomBadge.textContent = `${Math.round(camera.zoom * 100)}%`;
}

function updateViewportTransform() {
  viewport.style.transform = `translate(${camera.x}px, ${camera.y}px) scale(${camera.zoom})`;
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

function drawSegment(segment) {
  ctx.save();
  if (segment.tool === 'eraser') {
    ctx.globalCompositeOperation = 'destination-out';
    ctx.strokeStyle = 'rgba(0,0,0,1)';
  } else {
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = segment.color;
  }
  ctx.lineWidth = segment.size;
  ctx.beginPath();
  ctx.moveTo(segment.from.x, segment.from.y);
  ctx.lineTo(segment.to.x, segment.to.y);
  ctx.stroke();
  ctx.restore();
}

function renderDrawingFromOps() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawingOps.forEach((segment) => drawSegment(segment));
}

function broadcast(type, payload = {}) {
  channel.postMessage({
    type,
    source: clientId,
    payload,
    sentAt: Date.now(),
  });
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
      el.style.borderColor = user.color;
      el.textContent = user.id === me.id ? `${user.name} (me)` : user.name;
      presence.appendChild(el);
    });
}

function setTool(toolName) {
  activeTool = toolName;
  toolButtons.forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.tool === toolName);
  });
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

function setSelectedImage(id) {
  selectedImageId = id;
  imageLayer.querySelectorAll('.image-item').forEach((item) => {
    item.classList.toggle('is-selected', item.dataset.id === id);
  });
  updateCursor();
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

    const handle = document.createElement('button');
    handle.type = 'button';
    handle.className = 'resize-handle';
    handle.setAttribute('aria-label', '이미지 크기 조절');

    item.append(img, handle);
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
  syncImageZIndices();
  setSelectedImage(id);

  if (!silent) {
    broadcast('image-update', getImagePayload(id));
  }
}

function removeImage(id, { silent = false } = {}) {
  const item = getImageItem(id);
  if (!item) return;
  item.remove();
  if (selectedImageId === id) {
    setSelectedImage(null);
  }
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

function makeHistoryFingerprint(images) {
  const imageSignature = images
    .map((image) => `${image.id}:${image.x}:${image.y}:${image.width}:${image.src.length}`)
    .join('|');
  return `${drawingOps.length}::${imageSignature}`;
}

function snapshotBoardState() {
  const images = serializeImages();
  return {
    drawingOps: drawingOps.map((segment) => ({ ...segment })),
    images,
    fingerprint: makeHistoryFingerprint(images),
  };
}

function restoreBoardState(state, { broadcastRestore = false } = {}) {
  if (!state) return;
  isRestoringHistory = true;
  drawingOps = (state.drawingOps || []).map((segment) => ({ ...segment }));
  renderDrawingFromOps();

  imageLayer.innerHTML = '';
  state.images.forEach((payload) => placeImage(payload, { silent: true }));
  setSelectedImage(null);
  historyFingerprint = state.fingerprint || makeHistoryFingerprint(state.images || []);
  isRestoringHistory = false;

  if (broadcastRestore) {
    broadcast('board-state', state);
  }
}

function pushHistory(reason = '') {
  if (isRestoringHistory) return;
  const snapshot = snapshotBoardState();
  if (snapshot.fingerprint === historyFingerprint) {
    return;
  }

  history.splice(historyIndex + 1);
  history.push(snapshot);
  if (history.length > HISTORY_LIMIT) {
    history.shift();
  }
  historyIndex = history.length - 1;
  historyFingerprint = snapshot.fingerprint;

  if (reason) {
    // no-op hook for debugging
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

  const item = event.target.closest('.image-item');
  if (item && activeTool === 'select') {
    event.preventDefault();
    const id = item.dataset.id;
    setSelectedImage(id);

    const world = eventToWorld(event);
    const x = Number(item.dataset.x || 0);
    const y = Number(item.dataset.y || 0);
    const width = Number(item.dataset.width || 200);
    const isResize = event.target.classList.contains('resize-handle');

    interaction = {
      mode: isResize ? 'resize-image' : 'move-image',
      id,
      pointerId: event.pointerId,
      offsetX: world.x - x,
      offsetY: world.y - y,
      startX: world.x,
      startY: world.y,
      startWidth: width,
    };
    item.setPointerCapture(event.pointerId);
    return;
  }

  if (activeTool === 'select') {
    setSelectedImage(null);
    return;
  }

  setSelectedImage(null);

  if (event.button !== 0) return;
  isDrawing = true;
  lastPoint = eventToWorld(event);
}

function pointerMove(event) {
  if (panSession && event.pointerId === panSession.pointerId) {
    camera.x = panSession.originX + (event.clientX - panSession.startX);
    camera.y = panSession.originY + (event.clientY - panSession.startY);
    updateViewportTransform();
    return;
  }

  if (interaction && event.pointerId === interaction.pointerId) {
    const world = eventToWorld(event);
    const item = getImageItem(interaction.id);
    if (!item) return;

    if (interaction.mode === 'move-image') {
      const x = world.x - interaction.offsetX;
      const y = world.y - interaction.offsetY;
      placeImage({ ...getImagePayload(interaction.id), x, y }, { silent: true });
    } else if (interaction.mode === 'resize-image') {
      const delta = Math.max(world.x - interaction.startX, world.y - interaction.startY);
      const width = clamp(interaction.startWidth + delta, 40, WORLD.width);
      placeImage({ ...getImagePayload(interaction.id), width }, { silent: true });
    }

    return;
  }

  if (!isDrawing || !lastPoint) return;
  const current = eventToWorld(event);
  const segment = {
    from: lastPoint,
    to: current,
    color: me.color,
    size: Number(brushSize.value),
    tool: activeTool,
  };
  drawSegment(segment);
  drawingOps.push({ ...segment });
  broadcast('draw', segment);
  lastPoint = current;
}

function pointerUp(event) {
  if (panSession && event.pointerId === panSession.pointerId) {
    panSession = null;
    updateCursor();
  }

  if (interaction && event.pointerId === interaction.pointerId) {
    const payload = getImagePayload(interaction.id);
    if (payload) {
      broadcast('image-update', payload);
      pushHistory('image-transform');
    }
    interaction = null;
  }

  if (isDrawing && event.button === 0) {
    pushHistory('draw-stroke');
  }
  isDrawing = false;
  lastPoint = null;
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

  if (loweredKey === 'c' && selectedImageId) {
    event.preventDefault();
    copiedImagePayload = getImagePayload(selectedImageId);
    return;
  }

  if (loweredKey === 'v') {
    if (!copiedImagePayload) return;
    event.preventDefault();
    const duplicated = {
      ...copiedImagePayload,
      id: crypto.randomUUID(),
      x: copiedImagePayload.x + 24,
      y: copiedImagePayload.y + 24,
    };
    placeImage(duplicated, { silent: true });
    broadcast('image-update', duplicated);
    pushHistory('paste-image');
    setSelectedImage(duplicated.id);
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

colorPicker.value = me.color;
colorPicker.addEventListener('change', () => {
  me.color = colorPicker.value;
  syncPresence();
  renderPresence();
});

toolButtons.forEach((btn) => {
  btn.addEventListener('click', () => setTool(btn.dataset.tool));
});

imageInput.addEventListener('change', (event) => {
  const files = [...(event.target.files || [])];
  if (!files.length) return;
  files.forEach((file, index) => importImageFile(file, { x: 30 + index * 26, y: 30 + index * 26 }));
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
    broadcast('image-update', payload);
    pushHistory('import-image');
  };
  reader.readAsDataURL(file);
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

  const itemFiles = [...(event.clipboardData?.items || [])]
    .filter((item) => item.type.startsWith('image/'))
    .map((item) => item.getAsFile())
    .filter(Boolean);
  const files = [...(event.clipboardData?.files || []), ...itemFiles].filter((file) =>
    file.type.startsWith('image/'),
  );
  if (!files.length) return;

  event.preventDefault();
  const rect = board.getBoundingClientRect();
  const centerWorld = {
    x: (rect.width / 2 - camera.x) / camera.zoom,
    y: (rect.height / 2 - camera.y) / camera.zoom,
  };

  files.forEach((file, index) => {
    importImageFile(file, {
      x: centerWorld.x - 120 + index * 24,
      y: centerWorld.y - 70 + index * 24,
    });
  });
});

clearCanvasBtn.addEventListener('click', () => {
  drawingOps = [];
  renderDrawingFromOps();
  broadcast('clear-drawing');
  pushHistory('clear-drawing');
});

resetBoardBtn.addEventListener('click', () => {
  drawingOps = [];
  renderDrawingFromOps();
  imageLayer.innerHTML = '';
  syncImageZIndices();
  setSelectedImage(null);
  broadcast('reset-all');
  pushHistory('reset-board');
});

window.addEventListener('keydown', (event) => {
  if (isTypingTarget(event.target)) return;
  if ((event.key === 'Delete' || event.key === 'Backspace') && selectedImageId) {
    event.preventDefault();
    removeImage(selectedImageId);
    pushHistory('delete-image');
  }
});

channel.onmessage = (event) => {
  const { type, source, payload } = event.data || {};
  if (source === clientId) return;

  if (type === 'draw') {
    drawSegment(payload);
    drawingOps.push({ ...payload });
  }
  if (type === 'clear-drawing') {
    drawingOps = [];
    renderDrawingFromOps();
  }
  if (type === 'reset-all') {
    drawingOps = [];
    renderDrawingFromOps();
    imageLayer.innerHTML = '';
    syncImageZIndices();
    setSelectedImage(null);
  }
  if (type === 'image-update') placeImage(payload, { silent: true });
  if (type === 'image-remove') removeImage(payload.id, { silent: true });
  if (type === 'image-order' && payload?.order) {
    payload.order.forEach((id) => {
      const item = getImageItem(id);
      if (item) imageLayer.appendChild(item);
    });
    syncImageZIndices();
  }
  if (type === 'board-state') restoreBoardState(payload);

  if (type === 'presence' && payload?.user) {
    peers.set(payload.user.id, payload.user);
    renderPresence();
  }
};

setTool('select');
syncPresence();
renderPresence();
pushHistory('initial');
setInterval(() => {
  syncPresence();
  renderPresence();
}, 5000);

window.addEventListener('blur', () => {
  isSpacePressed = false;
  panSession = null;
  interaction = null;
  updateCursor();
});
