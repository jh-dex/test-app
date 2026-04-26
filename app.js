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
let zoomLevel = 1;
const peers = new Map();

function resizeCanvas() {
  const rect = board.getBoundingClientRect();
  const pixelRatio = window.devicePixelRatio || 1;
  canvas.width = rect.width * pixelRatio;
  canvas.height = rect.height * pixelRatio;
  canvas.style.width = `${rect.width}px`;
  canvas.style.height = `${rect.height}px`;
  ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  viewport.style.width = `${rect.width}px`;
  viewport.style.height = `${rect.height}px`;
  updateZoomUI();
}

function pointFromEvent(event) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left) / zoomLevel,
    y: (event.clientY - rect.top) / zoomLevel,
  };
}

function updateZoomUI() {
  const zoomText = `${Math.round(zoomLevel * 100)}%`;
  zoomBadge.textContent = zoomText;
  viewport.style.transform = `scale(${zoomLevel})`;
}

function setZoom(nextZoom) {
  zoomLevel = Math.min(3, Math.max(0.4, nextZoom));
  updateZoomUI();
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

function pointerDown(event) {
  if (event.target.tagName === 'IMG') {
    event.preventDefault();
    event.target.setPointerCapture(event.pointerId);
    const imgRect = event.target.getBoundingClientRect();
    dragging = {
      id: event.target.dataset.id,
      pointerId: event.pointerId,
      offsetX: (event.clientX - imgRect.left) / zoomLevel,
      offsetY: (event.clientY - imgRect.top) / zoomLevel,
    };
    return;
  }

  isDrawing = true;
  lastPoint = pointFromEvent(event);
}

function pointerMove(event) {
  if (dragging && event.pointerId === dragging.pointerId) {
    const rect = board.getBoundingClientRect();
    const x = (event.clientX - rect.left) / zoomLevel - dragging.offsetX;
    const y = (event.clientY - rect.top) / zoomLevel - dragging.offsetY;
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

function pointerUp() {
  isDrawing = false;
  lastPoint = null;
  dragging = null;
}

canvas.addEventListener('pointerdown', pointerDown);
canvas.addEventListener('pointermove', pointerMove);
window.addEventListener('pointerup', pointerUp);
imageLayer.addEventListener('pointerdown', pointerDown);
imageLayer.addEventListener('pointermove', pointerMove);
board.addEventListener(
  'wheel',
  (event) => {
    if (!event.ctrlKey) return;
    event.preventDefault();
    const delta = event.deltaY < 0 ? 0.1 : -0.1;
    setZoom(zoomLevel + delta);
  },
  { passive: false }
);

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
      x: Math.max(0, point.x),
      y: Math.max(0, point.y),
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
  const rect = board.getBoundingClientRect();
  importImageFile(file, {
    x: (event.clientX - rect.left) / zoomLevel - 110,
    y: (event.clientY - rect.top) / zoomLevel - 60,
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
