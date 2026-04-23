const STORAGE_KEY = "focus-sprint-goals-v1";

const state = {
  goals: loadGoals(),
  filter: "all",
};

const form = document.getElementById("goal-form");
const input = document.getElementById("goal-input");
const goalList = document.getElementById("goal-list");
const template = document.getElementById("goal-item-template");
const summaryText = document.getElementById("summary-text");
const clearDoneBtn = document.getElementById("clear-done-btn");
const filterButtons = document.querySelectorAll(".filter-btn");

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const value = input.value.trim();
  if (!value) return;

  state.goals.unshift({
    id: crypto.randomUUID(),
    text: value,
    done: false,
    createdAt: Date.now(),
  });

  input.value = "";
  persistAndRender();
});

clearDoneBtn.addEventListener("click", () => {
  state.goals = state.goals.filter((goal) => !goal.done);
  persistAndRender();
});

filterButtons.forEach((button) => {
  button.addEventListener("click", () => {
    state.filter = button.dataset.filter;
    filterButtons.forEach((btn) => btn.classList.remove("active"));
    button.classList.add("active");
    render();
  });
});

function persistAndRender() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.goals));
  render();
}

function loadGoals() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) return [];
    const parsed = JSON.parse(saved);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function getVisibleGoals() {
  if (state.filter === "active") return state.goals.filter((goal) => !goal.done);
  if (state.filter === "done") return state.goals.filter((goal) => goal.done);
  return state.goals;
}

function render() {
  goalList.innerHTML = "";
  const goalsToRender = getVisibleGoals();

  goalsToRender.forEach((goal) => {
    const node = template.content.firstElementChild.cloneNode(true);
    const toggle = node.querySelector(".goal-toggle");
    const text = node.querySelector(".goal-text");
    const deleteBtn = node.querySelector(".delete-btn");

    toggle.checked = goal.done;
    text.textContent = goal.text;
    node.classList.toggle("done", goal.done);

    toggle.addEventListener("change", () => {
      goal.done = toggle.checked;
      persistAndRender();
    });

    deleteBtn.addEventListener("click", () => {
      state.goals = state.goals.filter((item) => item.id !== goal.id);
      persistAndRender();
    });

    goalList.append(node);
  });

  const doneCount = state.goals.filter((goal) => goal.done).length;
  summaryText.textContent = `총 ${state.goals.length}개 · 완료 ${doneCount}개`;
}

render();
