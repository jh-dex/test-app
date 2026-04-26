const channel = new BroadcastChannel('live-board-mvp');

const WORLD_WIDTH = 4000;
const WORLD_HEIGHT = 3000;

const board = document.getElementById('board');
const viewport = document.getElementById('viewport');
const stage = document.getElementById('stage');
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
let panning = null;
let zoomLevel = 1;
let isSpacePressed = false;
const peers = new Map();
const camera = { x: 0, y: 0 };

function centerStage() {
  const rect = board.getBoundingClientRect();
  camera.x = (rect.width - WORLD_WIDTH * zoomLevel) / 2;
  camera.y = (rect.height - WORLD_HEIGHT * zoomLevel) / 2;
}

function resizeCanvas() {
  const pixelRatio = window.devicePixelRatio || 1;
  canvas.width = WORLD_WIDTH * pixelRatio;
  canvas.height = WORLD_HEIGHT * pixelRatio;
  canvas.style.width = `${WORLD_WIDTH}px`;
  canvas.style.height = `${WORLD_HEIGHT}px`;
  ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  stage.style.width = `${WORLD_WIDTH}px`;
  stage.style.height = `${WORLD_HEIGHT}px`;
  viewport.style.width = '100%';
  viewport.style.height = '100%';

  if (camera.x === 0 && camera.y === 0) {
    centerStage();
  }
  updateView();
}

function updateView() {
  const zoomText = `${Math.round(zoomLevel * 100)}%`;
  zoomBadge.textContent = zoomText;
  stage.style.transform = `translate(${camera.x}px, ${camera.y}px) scale(${zoomLevel})`;
}

function setZoom(nextZoom, anchor = null) {
  const prevZoom = zoomLevel;
  const next = Math.min(4, Math.max(0.2, nextZoom));
  if (next === prevZoom) return;

  const boardRect = board.getBoundingClientRect();
  const anchorX = anchor?.x ?? boardRect.width / 2;
  const anchorY = anchor?.y ?? boardRect.height / 2;
  const worldX = (anchorX - camera.x) / prevZoom;
  const worldY = (anchorY - camera.y) / prevZoom;

  zoomLevel = next;
  camera.x = anchorX - worldX * zoomLevel;
  camera.y = anchorY - worldY * zoomLevel;
  updateView();
}

function pointFromEvent(event) {
  const rect = board.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left - camera.x) / zoomLevel,
    y: (event.clientY - rect.top - camera.y) / zoomLevel,
  };
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

function importImageFile(file, point = { x: 30, y: 30 }) {
  if (!file || !file.type.startsWith('image/')) return;
  const reader = new FileReader();
  reader.onload = () => {
    const payload = {
      id: crypto.randomUUID(),
      src: String(reader.result),
      x: Math.max(0, Math.min(WORLD_WIDTH - 220, point.x)),
      y: Math.max(0, Math.min(WORLD_HEIGHT - 120, point.y)),
      width: 220,
    };
    placeImage(payload);
    broadcast('image-add', payload);
  };
  reader.readAsDataURL(file);
}

function pointerDown(event) {
  const isPanTrigger = event.button === 1 || (event.button === 0 && isSpacePressed);
  if (isPanTrigger) {
    event.preventDefault();
    panning = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: camera.x,
      originY: camera.y,
    };
    board.setPointerCapture(event.pointerId);
    board.classList.add('is-panning');
    return;
  }

  if (event.button !== 0) return;

  if (event.target.tagName === 'IMG') {
    event.preventDefault();
    event.target.setPointerCapture(event.pointerId);
    const currentX = Number.parseFloat(event.target.style.left || '0');
    const currentY = Number.parseFloat(event.target.style.top || '0');
    const pointerWorld = pointFromEvent(event);
    dragging = {
      id: event.target.dataset.id,
      pointerId: event.pointerId,
      offsetX: pointerWorld.x - currentX,
      offsetY: pointerWorld.y - currentY,
    };
    return;
  }

  isDrawing = true;
  lastPoint = pointFromEvent(event);
}

function pointerMove(event) {
  if (panning && event.pointerId === panning.pointerId) {
    camera.x = panning.originX + (event.clientX - panning.startX);
    camera.y = panning.originY + (event.clientY - panning.startY);
    updateView();
    return;
  }

  if (dragging && event.pointerId === dragging.pointerId) {
    const pointerWorld = pointFromEvent(event);
    const x = Math.max(0, Math.min(WORLD_WIDTH - 50, pointerWorld.x - dragging.offsetX));
    const y = Math.max(0, Math.min(WORLD_HEIGHT - 50, pointerWorld.y - dragging.offsetY));
    const img = imageLayer.querySelector(`[data-id="${dragging.id}"]`);
    if (img) {
      img.style.left = `${x}px`;
      img.style.top = `${y}px`;
      broadcast('image-move', { id: dragging.id, x, y });
    }
    return;
  }

  if (!isDrawing || !lastPoint) return;
  const current = pointFromEvent(event);
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
  if (panning && event.pointerId === panning.pointerId) {
    panning = null;
    board.classList.remove('is-panning');
  }
  if (dragging && event.pointerId === dragging.pointerId) {
    dragging = null;
  }
  isDrawing = false;
  lastPoint = null;
}

board.addEventListener('pointerdown', pointerDown);
board.addEventListener('pointermove', pointerMove);
window.addEventListener('pointerup', pointerUp);
board.addEventListener(
  'wheel',
  (event) => {
    if (!(event.ctrlKey || event.metaKey)) return;
    event.preventDefault();
    const rect = board.getBoundingClientRect();
    const anchor = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    const delta = event.deltaY < 0 ? 0.1 : -0.1;
    setZoom(zoomLevel + delta, anchor);
  },
  { passive: false }
);

window.addEventListener('keydown', (event) => {
  if (event.code === 'Space') {
    isSpacePressed = true;
    board.classList.add('is-hand-mode');
    event.preventDefault();
  }

  if ((event.ctrlKey || event.metaKey) && (event.key === '+' || event.key === '=')) {
    event.preventDefault();
    setZoom(zoomLevel + 0.1);
  }
  if ((event.ctrlKey || event.metaKey) && event.key === '-') {
    event.preventDefault();
    setZoom(zoomLevel - 0.1);
  }
  if ((event.ctrlKey || event.metaKey) && event.key === '0') {
    event.preventDefault();
    zoomLevel = 1;
    centerStage();
    updateView();
  }
});

window.addEventListener('keyup', (event) => {
  if (event.code === 'Space') {
    isSpacePressed = false;
    board.classList.remove('is-hand-mode');
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
  importImageFile(file, { x: WORLD_WIDTH / 2 - 110, y: WORLD_HEIGHT / 2 - 60 });
  event.target.value = '';
});

board.addEventListener('dragover', (event) => {
  event.preventDefault();
});

board.addEventListener('drop', (event) => {
  event.preventDefault();
  const file = event.dataTransfer?.files?.[0];
  if (!file) return;
  importImageFile(file, pointFromEvent(event));
});

clearCanvasBtn.addEventListener('click', () => {
  ctx.clearRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);
  broadcast('clear-drawing');
});

resetBoardBtn.addEventListener('click', () => {
  ctx.clearRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);
  imageLayer.innerHTML = '';
  broadcast('reset-all');
});

channel.onmessage = (event) => {
  const { type, source, payload } = event.data || {};
  if (source === clientId) return;

  if (type === 'draw') drawSegment(payload);
  if (type === 'clear-drawing') ctx.clearRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);
  if (type === 'reset-all') {
    ctx.clearRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);
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
