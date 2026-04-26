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

const WORLD = {
  width: 6000,
  height: 6000,
};

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
let dragging = null;
let isSpacePressed = false;
let panSession = null;
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

function placeImage({ id, src, x = 20, y = 20, width = 200 }) {
  let img = imageLayer.querySelector(`[data-id="${id}"]`);
  if (!img) {
    img = document.createElement('img');
    img.dataset.id = id;
    img.draggable = false;
    imageLayer.appendChild(img);
  }
  img.src = src;
  img.style.left = `${x}px`;
  img.style.top = `${y}px`;
  img.style.width = `${width}px`;
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

  if (event.target.tagName === 'IMG') {
    event.preventDefault();
    event.target.setPointerCapture(event.pointerId);
    const imgRect = event.target.getBoundingClientRect();
    dragging = {
      id: event.target.dataset.id,
      pointerId: event.pointerId,
      offsetX: (event.clientX - imgRect.left) / camera.zoom,
      offsetY: (event.clientY - imgRect.top) / camera.zoom,
    };
    return;
  }

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

  if (dragging && event.pointerId === dragging.pointerId) {
    const world = eventToWorld(event);
    const x = world.x - dragging.offsetX;
    const y = world.y - dragging.offsetY;
    const img = imageLayer.querySelector(`[data-id="${dragging.id}"]`);
    if (img) {
      img.style.left = `${x}px`;
      img.style.top = `${y}px`;
      broadcast('image-move', { id: dragging.id, x, y });
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
  broadcast('draw', segment);
  lastPoint = current;
}

function pointerUp(event) {
  if (panSession && event.pointerId === panSession.pointerId) {
    panSession = null;
    updateCursor();
  }
  isDrawing = false;
  lastPoint = null;
  dragging = null;
}

board.addEventListener('pointerdown', pointerDown);
board.addEventListener('pointermove', pointerMove);
window.addEventListener('pointerup', pointerUp);
board.addEventListener('wheel', (event) => {
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
}, { passive: false });

window.addEventListener('keydown', (event) => {
  if (event.code === 'Space') {
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
  } else if (event.key === '-') {
    event.preventDefault();
    const rect = board.getBoundingClientRect();
    zoomAt(camera.zoom - 0.1, rect.left + rect.width / 2, rect.top + rect.height / 2);
  } else if (event.key === '0') {
    event.preventDefault();
    const rect = board.getBoundingClientRect();
    camera.zoom = 1;
    camera.x = rect.width / 2 - WORLD.width / 2;
    camera.y = rect.height / 2 - WORLD.height / 2;
    updateViewportTransform();
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
  const file = event.target.files?.[0];
  if (!file) return;
  importImageFile(file, { x: 30, y: 30 });
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
    placeImage(payload);
    broadcast('image-add', payload);
  };
  reader.readAsDataURL(file);
}

board.addEventListener('dragover', (event) => {
  event.preventDefault();
});

board.addEventListener('drop', (event) => {
  event.preventDefault();
  const file = event.dataTransfer?.files?.[0];
  if (!file) return;
  const world = eventToWorld(event);
  importImageFile(file, {
    x: world.x - 110,
    y: world.y - 60,
  });
});

clearCanvasBtn.addEventListener('click', () => {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  broadcast('clear-drawing');
});

resetBoardBtn.addEventListener('click', () => {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  imageLayer.innerHTML = '';
  broadcast('reset-all');
});

channel.onmessage = (event) => {
  const { type, source, payload } = event.data || {};
  if (source === clientId) return;

  if (type === 'draw') drawSegment(payload);
  if (type === 'clear-drawing') ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (type === 'reset-all') {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    imageLayer.innerHTML = '';
  }
  if (type === 'image-add') placeImage(payload);
  if (type === 'image-move') {
    const img = imageLayer.querySelector(`[data-id="${payload.id}"]`);
    if (img) {
      img.style.left = `${payload.x}px`;
      img.style.top = `${payload.y}px`;
    }
  }
  if (type === 'presence' && payload?.user) {
    peers.set(payload.user.id, payload.user);
    renderPresence();
  }
};

setTool('pen');
syncPresence();
renderPresence();
setInterval(() => {
  syncPresence();
  renderPresence();
}, 5000);
