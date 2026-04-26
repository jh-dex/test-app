const channel = new BroadcastChannel('live-board-mvp');

const board = document.getElementById('board');
const canvas = document.getElementById('drawCanvas');
const ctx = canvas.getContext('2d');
const imageLayer = document.getElementById('imageLayer');
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
}

function pointFromEvent(event) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
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

function pointerDown(event) {
  if (event.target.tagName === 'IMG') {
    dragging = {
      id: event.target.dataset.id,
      offsetX: event.offsetX,
      offsetY: event.offsetY,
    };
    return;
  }

  isDrawing = true;
  lastPoint = pointFromEvent(event);
}

function pointerMove(event) {
  if (dragging) {
    const rect = board.getBoundingClientRect();
    const x = event.clientX - rect.left - dragging.offsetX;
    const y = event.clientY - rect.top - dragging.offsetY;
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
  const reader = new FileReader();
  reader.onload = () => {
    const payload = {
      id: crypto.randomUUID(),
      src: String(reader.result),
      x: 30,
      y: 30,
      width: 220,
    };
    placeImage(payload);
    broadcast('image-add', payload);
  };
  reader.readAsDataURL(file);
  event.target.value = '';
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
