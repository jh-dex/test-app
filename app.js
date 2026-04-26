const channel = new BroadcastChannel('live-board-mvp');

const board = document.getElementById('board');
const canvas = document.getElementById('drawCanvas');
const ctx = canvas.getContext('2d');
const imageLayer = document.getElementById('imageLayer');
const presence = document.getElementById('presence');
const displayNameInput = document.getElementById('displayName');
const colorPicker = document.getElementById('colorPicker');
const brushSize = document.getElementById('brushSize');
const clearCanvasBtn = document.getElementById('clearCanvas');
const resetBoardBtn = document.getElementById('resetBoard');
const toolButtons = [...document.querySelectorAll('[data-tool]')];
const zoomOutBtn = document.getElementById('zoomOut');
const zoomInBtn = document.getElementById('zoomIn');
const zoomValue = document.getElementById('zoomValue');

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
let zoom = 1;
let dragDepth = 0;

const minZoom = 0.5;
const maxZoom = 2;
const zoomStep = 0.1;

const peers = new Map();
const strokeHistory = [];

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
  renderStrokes();
}

function applyZoom() {
  canvas.style.transform = `scale(${zoom})`;
  imageLayer.style.transform = `scale(${zoom})`;
  zoomValue.textContent = `${Math.round(zoom * 100)}%`;
}

function setZoom(nextZoom) {
  zoom = Math.max(minZoom, Math.min(maxZoom, Number(nextZoom.toFixed(2))));
  applyZoom();
}

function clampPoint(point) {
  const rect = board.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(point.x, rect.width / zoom)),
    y: Math.max(0, Math.min(point.y, rect.height / zoom)),
  };
}

function pointFromEvent(event) {
  const rect = board.getBoundingClientRect();
  return clampPoint({
    x: (event.clientX - rect.left) / zoom,
    y: (event.clientY - rect.top) / zoom,
  });
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

function renderStrokes() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  strokeHistory.forEach(drawSegment);
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

function placeImage({ id, src, x = 20, y = 20, width = 220 }) {
  let img = imageLayer.querySelector(`[data-id="${id}"]`);
  if (!img) {
    img = document.createElement('img');
    img.dataset.id = id;
    img.draggable = false;
    img.addEventListener('pointerdown', startImageDrag);
    imageLayer.appendChild(img);
  }

  img.src = src;
  img.style.left = `${x}px`;
  img.style.top = `${y}px`;
  img.style.width = `${width}px`;
}

function startImageDrag(event) {
  if (!(event.currentTarget instanceof HTMLImageElement)) return;
  const img = event.currentTarget;
  const rect = img.getBoundingClientRect();

  dragging = {
    id: img.dataset.id,
    pointerId: event.pointerId,
    offsetX: (event.clientX - rect.left) / zoom,
    offsetY: (event.clientY - rect.top) / zoom,
  };

  img.classList.add('dragging');
  img.setPointerCapture(event.pointerId);
  event.preventDefault();
  event.stopPropagation();
}

function handleDrawingStart(event) {
  if (event.target !== canvas) return;
  isDrawing = true;
  lastPoint = pointFromEvent(event);
}

function handlePointerMove(event) {
  if (dragging) {
    const current = pointFromEvent(event);
    const x = current.x - dragging.offsetX;
    const y = current.y - dragging.offsetY;
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

  strokeHistory.push(segment);
  drawSegment(segment);
  broadcast('draw', segment);
  lastPoint = current;
}

function finishPointer(event) {
  isDrawing = false;
  lastPoint = null;

  if (dragging) {
    const img = imageLayer.querySelector(`[data-id="${dragging.id}"]`);
    if (img) {
      img.classList.remove('dragging');
      if (event && img.hasPointerCapture(dragging.pointerId)) {
        img.releasePointerCapture(dragging.pointerId);
      }
    }
    dragging = null;
  }
}

function addImageFromFile(file, dropPoint = { x: 40, y: 40 }) {
  if (!file?.type.startsWith('image/')) return;

  const reader = new FileReader();
  reader.onload = () => {
    const payload = {
      id: crypto.randomUUID(),
      src: String(reader.result),
      x: dropPoint.x,
      y: dropPoint.y,
      width: 220,
    };
    placeImage(payload);
    broadcast('image-add', payload);
  };
  reader.readAsDataURL(file);
}

function setDropHighlight(enabled) {
  board.classList.toggle('is-drop-target', enabled);
}

function handleDrop(event) {
  event.preventDefault();
  dragDepth = 0;
  setDropHighlight(false);

  const files = [...(event.dataTransfer?.files || [])].filter((file) =>
    file.type.startsWith('image/'),
  );

  if (!files.length) return;

  const point = pointFromEvent(event);
  files.forEach((file, index) => {
    addImageFromFile(file, {
      x: point.x + index * 26,
      y: point.y + index * 26,
    });
  });
}

canvas.addEventListener('pointerdown', handleDrawingStart);
window.addEventListener('pointermove', handlePointerMove);
window.addEventListener('pointerup', finishPointer);
window.addEventListener('pointercancel', finishPointer);

board.addEventListener('dragenter', (event) => {
  event.preventDefault();
  dragDepth += 1;
  setDropHighlight(true);
});

board.addEventListener('dragover', (event) => {
  event.preventDefault();
});

board.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) {
    setDropHighlight(false);
  }
});

board.addEventListener('drop', handleDrop);

window.addEventListener('resize', resizeCanvas);

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

zoomOutBtn.addEventListener('click', () => {
  setZoom(zoom - zoomStep);
});

zoomInBtn.addEventListener('click', () => {
  setZoom(zoom + zoomStep);
});

board.addEventListener(
  'wheel',
  (event) => {
    if (!event.ctrlKey) return;
    event.preventDefault();
    const delta = event.deltaY > 0 ? -zoomStep : zoomStep;
    setZoom(zoom + delta);
  },
  { passive: false },
);

clearCanvasBtn.addEventListener('click', () => {
  strokeHistory.length = 0;
  renderStrokes();
  broadcast('clear-drawing');
});

resetBoardBtn.addEventListener('click', () => {
  strokeHistory.length = 0;
  renderStrokes();
  imageLayer.innerHTML = '';
  broadcast('reset-all');
});

channel.onmessage = (event) => {
  const { type, source, payload } = event.data || {};
  if (source === clientId) return;

  if (type === 'draw') {
    strokeHistory.push(payload);
    drawSegment(payload);
  }

  if (type === 'clear-drawing') {
    strokeHistory.length = 0;
    renderStrokes();
  }

  if (type === 'reset-all') {
    strokeHistory.length = 0;
    renderStrokes();
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
setZoom(1);
resizeCanvas();
syncPresence();
renderPresence();
setInterval(() => {
  syncPresence();
  renderPresence();
}, 5000);
