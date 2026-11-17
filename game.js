/* ==========================================================================
   ¹²ßñàké

   Rules:
     • Losing a life respawns the snake but KEEPS the score, the target progress
       and the snake's length (it never shrinks).
     • Losing all lives is game over: the whole game (level, score, target, snake
       length, lives) resets to the start. The best score is remembered separately.
   Tech:
     • a phase state machine: ready → countdown → playing ⇄ paused → over
     • input = keyboard (arrows / WASD) + swipe anywhere on touch devices
     • a 4K-ready canvas renderer (up to 4096 px, native device pixels) with
       frame-interpolated snake movement, independent of the logic tick rate
   ========================================================================== */

/* ---------- Constants ---------- */

const GRID = 30;
const MAX_LIVES = 5;
const START_LENGTH = 3; // length of a fresh snake (new level / new game)
const STORAGE_PREFIX = 'snake_game_progress';
const LAST_MOBILE_KEY = 'snake_last_mobile_number';
const BEST_KEY = 'snake_best_score';
const MAX_CANVAS_PX = 4096; // 4K-safe canvas ceiling (GPU texture limits)

const COUNTDOWN_STEP_MS = 550;
const DEATH_PAUSE_MS = 700;
const LEVEL_PAUSE_MS = 900;
const MAX_QUEUED_TURNS = 2;

const PHASE = {
  READY: 'ready',
  COUNTDOWN: 'countdown',
  PLAYING: 'playing',
  PAUSED: 'paused',
  DYING: 'dying',
  LEVEL_UP: 'levelup',
  OVER: 'over',
};

/* ---------- DOM ---------- */

const $ = (id) => document.getElementById(id);

const canvas = $('gameCanvas');
const ctx = canvas.getContext('2d');
const boardEl = $('board');

const statusBars = document.querySelectorAll('.status'); // portrait + landscape copies
const levelLabel = $('levelLabel');
const eatenLabel = $('eatenLabel');
const targetLabel = $('targetLabel');
const livesLabel = $('livesLabel');
const meterFill = $('meterFill');
const hardBadge = $('hardBadge');
const scoreLabel = $('scoreLabel');
const bestLabel = $('bestLabel');

const overlayEl = $('overlay');
const overlayKicker = $('overlayKicker');
const overlayTitle = $('overlayTitle');
const overlayText = $('overlayText');
const overlayBtn = $('overlayBtn');
const overlayHint = $('overlayHint');
const pauseBtn = $('pauseBtn');

const accountBtn = $('accountBtn');
const accountLabel = $('accountLabel');
const accountDialog = $('accountDialog');
const closeAccountBtn = $('closeAccountBtn');
const authForm = $('authForm');
const authSignedOut = $('authSignedOut');
const authSignedIn = $('authSignedIn');
const authError = $('authError');
const signedInNumber = $('signedInNumber');
const mobileInput = $('mobileInput');
const logoutBtn = $('logoutBtn');

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ---------- State ---------- */

const state = {
  phase: PHASE.READY,
  level: 1,
  lives: MAX_LIVES,
  score: 0,
  target: 1,
  eatenInLevel: 0,
  direction: { x: 1, y: 0 },
  queue: [], // buffered turns, so quick swipes / key taps are never dropped
  snake: [],
  food: { x: 0, y: 0 },
  collectedPills: new Set(),
  poisonCells: new Set(),
  enemies: [],
  fx: [], // short-lived visual effects (eat rings)
  best: 0, // best score on this device
  newBest: false, // beaten the old best during this game?
  prevSnake: [], // positions before the last tick (for smooth interpolation)
  lastTick: 0, // performance.now() of the last logic tick
  tickMs: 150, // current tick length
  isHard: false,
  mobile: '', // logged-in mobile number ('' = logged out)
  moveTimer: null,
  countdownTimer: null,
  phaseTimer: null,
};

/* ==========================================================================
   Storage + login (keys and format unchanged, so existing saves keep working)
   ========================================================================== */

const store = {
  get(key) {
    try { return localStorage.getItem(key); } catch (error) { return null; }
  },
  set(key, value) {
    try { localStorage.setItem(key, value); } catch (error) { /* storage blocked */ }
  },
  remove(key) {
    try { localStorage.removeItem(key); } catch (error) { /* storage blocked */ }
  },
};

function normalizeMobileNumber(value) {
  const raw = String(value ?? '').replace(/\D/g, '');
  if (!raw) return '';
  if (raw.length > 10 && raw.startsWith('91')) {
    return raw.slice(2);
  }
  return raw.slice(-10);
}

function buildProgressKey(mobileNumber) {
  const normalized = normalizeMobileNumber(mobileNumber);
  return `${STORAGE_PREFIX}:${normalized}`;
}

function restoreProgress() {
  if (!state.mobile) return false;

  const saved = store.get(buildProgressKey(state.mobile));
  if (!saved) return false;

  try {
    const parsed = JSON.parse(saved);
    if (!parsed || typeof parsed !== 'object') return false;

    state.level = Number(parsed.level) || 1;
    state.score = Number(parsed.score) || 0;
    state.lives = Math.min(Number(parsed.lives) || MAX_LIVES, MAX_LIVES);
    // progress toward this level's target (older saves have none → 0)
    state.eatenInLevel = Math.min(Math.max(0, Number(parsed.eaten) || 0), Math.max(0, getTargetForLevel(state.level) - 1));
    state.collectedPills = new Set();
    return true;
  } catch (error) {
    return false;
  }
}

function saveProgress(override) {
  if (!state.mobile) return false;

  const data = override || { level: state.level, score: state.score, lives: state.lives, eaten: state.eatenInLevel };
  store.set(buildProgressKey(state.mobile), JSON.stringify(data));
  store.set(LAST_MOBILE_KEY, state.mobile);
  return true;
}

function loadBest() {
  state.best = Math.max(0, Number(store.get(BEST_KEY)) || 0);
}

/** Records a new best score if the current score beats it. Returns true when it did. */
function updateBest() {
  if (state.score <= state.best) return false;
  if (state.best > 0) state.newBest = true;
  state.best = state.score;
  store.set(BEST_KEY, String(state.best));
  return true;
}

function maskMobile(number) {
  return number.length >= 6 ? `${number.slice(0, 2)}••••${number.slice(-4)}` : number;
}

function updateAuthUI() {
  const signedIn = Boolean(state.mobile);
  accountLabel.textContent = signedIn ? maskMobile(state.mobile) : 'Sign in';
  accountBtn.setAttribute('aria-label', signedIn ? `Account, signed in as ${maskMobile(state.mobile)}` : 'Sign in to save progress');
  signedInNumber.textContent = signedIn ? maskMobile(state.mobile) : '—';
  authSignedOut.hidden = signedIn;
  authSignedIn.hidden = !signedIn;
  disarmLogout();
}

/* ==========================================================================
   HUD + status
   ========================================================================== */

const hudCache = {};

function setText(el, value) {
  const next = String(value);
  if (hudCache[el.id] === next) return false;
  hudCache[el.id] = next;
  el.textContent = next;
  return true;
}

const HEART_SVG =
  '<svg class="heart" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-7.5-4.6-9.6-9.2C.9 8.4 2.7 4.8 6.2 4.5c2-.2 3.9.9 5.8 3.1 1.9-2.2 3.8-3.3 5.8-3.1 3.5.3 5.3 3.9 3.8 7.3C19.5 16.4 12 21 12 21z"/></svg>';

function buildHearts() {
  livesLabel.innerHTML = HEART_SVG.repeat(MAX_LIVES);
}

function setStatus(text, tone = 'ok') {
  for (const bar of statusBars) {
    bar.dataset.tone = tone;
    bar.querySelector('.status-text').textContent = text;
  }
}

function popEl(el) {
  if (reducedMotion) return;
  el.classList.remove('pop');
  void el.offsetWidth; // restart the animation
  el.classList.add('pop');
}

function updateHud() {
  setText(levelLabel, state.level);
  setText(targetLabel, state.target);
  if (setText(scoreLabel, state.score.toLocaleString('en-US')) && state.score > 0) popEl(scoreLabel);
  setText(bestLabel, state.best.toLocaleString('en-US'));
  if (setText(eatenLabel, state.eatenInLevel) && state.eatenInLevel > 0) popEl(eatenLabel);

  meterFill.style.width = `${Math.min(100, (state.eatenInLevel / state.target) * 100)}%`;
  hardBadge.hidden = !state.isHard;

  const hearts = livesLabel.children;
  for (let i = 0; i < hearts.length; i++) {
    hearts[i].classList.toggle('off', i >= state.lives);
  }
  livesLabel.setAttribute('aria-label', `${state.lives} of ${MAX_LIVES} lives`);
}

/* ==========================================================================
   Overlay (ready / countdown / paused / toast / game over)
   ========================================================================== */

function pillsText(n) {
  return `${n} ${n === 1 ? 'pill' : 'pills'}`;
}

function setOverlay(variant, config = {}) {
  if (!variant) {
    overlayEl.classList.remove('is-open');
    return;
  }

  overlayEl.dataset.variant = variant;
  overlayKicker.textContent = config.kicker ?? '';
  overlayTitle.textContent = config.title ?? '';
  overlayText.textContent = config.text ?? '';
  overlayBtn.textContent = config.button ?? '';
  overlayBtn.hidden = !config.button;
  overlayText.hidden = !config.text;
  overlayEl.classList.add('is-open');
}

function levelTag() {
  return `Level ${state.level}${state.isHard ? ' · Hard' : ''}`;
}

function showReadyOverlay() {
  setOverlay('ready', {
    kicker: levelTag(),
    title: 'Ready?',
    text: state.isHard
      ? `Eat ${pillsText(state.target)}. Rival snakes are hunting the same pills.`
      : `Eat ${pillsText(state.target)} to clear the level. Stay clear of the purple walls.`,
    button: 'Play',
  });
}

function showPausedOverlay() {
  setOverlay('paused', {
    kicker: levelTag(),
    title: 'Paused',
    text: `${state.eatenInLevel} of ${state.target} eaten.`,
    button: 'Resume',
  });
}

function showOverOverlay() {
  const score = state.score.toLocaleString('en-US');
  setOverlay('over', {
    kicker: state.newBest ? 'Game over · New best!' : 'Game over',
    title: `Score ${score}`,
    text: `All ${MAX_LIVES} lives used on level ${state.level}. Everything resets: level 1, score 0, target 0, a fresh short snake and full lives.`,
    button: 'New game',
  });
}

/* ==========================================================================
   Phases
   ========================================================================== */

let dirty = true;
function markDirty() { dirty = true; }

function setPhase(phase) {
  state.phase = phase;
  updatePauseButton();
  markDirty();
}

function updatePauseButton() {
  const { phase } = state;
  const running = phase === PHASE.PLAYING || phase === PHASE.COUNTDOWN;
  const canResume = phase === PHASE.PAUSED || phase === PHASE.READY;

  pauseBtn.dataset.state = running ? 'pause' : 'play';
  pauseBtn.disabled = !(running || canResume);
  pauseBtn.setAttribute(
    'aria-label',
    running ? 'Pause game' : phase === PHASE.READY ? 'Start game' : 'Resume game'
  );
}

function clearTimers() {
  clearInterval(state.moveTimer);
  clearTimeout(state.countdownTimer);
  clearTimeout(state.phaseTimer);
  state.moveTimer = null;
}

function snapshotPositions() {
  state.prevSnake = state.snake.map((seg) => ({ x: seg.x, y: seg.y }));
  for (const enemy of state.enemies) {
    enemy.prev = enemy.body.map((seg) => ({ x: seg.x, y: seg.y }));
  }
}

function startLoop() {
  clearInterval(state.moveTimer);
  state.tickMs = getSpeedForLevel(state.level);
  snapshotPositions(); // nothing to interpolate until the first tick
  state.lastTick = performance.now();
  state.moveTimer = setInterval(gameTick, state.tickMs);
}

function stopLoop() {
  clearInterval(state.moveTimer);
  state.moveTimer = null;
}

function enterReady() {
  clearTimers();
  setPhase(PHASE.READY);
  showReadyOverlay();
}

function beginPlay() {
  setPhase(PHASE.PLAYING);
  // Tab hidden or account dialog open? Don't start the clock behind the user's back.
  if (document.hidden || accountDialog.open) {
    pause();
    return;
  }
  setOverlay(null);
  startLoop();
}

function startCountdown() {
  clearTimers();
  setPhase(PHASE.COUNTDOWN);
  setStatus(state.isHard ? 'Hard level' : 'Get ready', state.isHard ? 'hard' : 'ok');

  let n = 3;
  const step = () => {
    if (state.phase !== PHASE.COUNTDOWN) return;
    if (n === 0) {
      setStatus(state.isHard ? 'Hard level' : 'Go!', state.isHard ? 'hard' : 'ok');
      beginPlay();
      return;
    }
    setOverlay('countdown', { title: String(n) });
    n -= 1;
    state.countdownTimer = setTimeout(step, COUNTDOWN_STEP_MS);
  };
  step();
}

function pause() {
  if (state.phase !== PHASE.PLAYING && state.phase !== PHASE.COUNTDOWN) return;
  clearTimers();
  setPhase(PHASE.PAUSED);
  setStatus('Paused', 'info');
  showPausedOverlay();
}

function primaryAction() {
  switch (state.phase) {
    case PHASE.READY:
    case PHASE.PAUSED:
      startCountdown();
      break;
    case PHASE.OVER:
      startNewGame();
      startCountdown();
      break;
    default:
      break;
  }
}

function togglePause() {
  if (state.phase === PHASE.PLAYING || state.phase === PHASE.COUNTDOWN) {
    pause();
  } else {
    primaryAction();
  }
}

/* ==========================================================================
   Game rules
   ========================================================================== */

function getTargetForLevel(level) {
  return Math.pow(2, level - 1);
}

function isHardLevel(level) {
  return level % 5 === 0;
}

function buildPoisonCells() {
  const cells = new Set();
  for (let x = 0; x < GRID; x++) {
    cells.add(`${x},0`);
    cells.add(`${x},${GRID - 1}`);
  }
  for (let y = 0; y < GRID; y++) {
    cells.add(`0,${y}`);
    cells.add(`${GRID - 1},${y}`);
  }
  return cells;
}

function getSpeedForLevel(level) {
  if (isHardLevel(level)) {
    return Math.max(70, 180 - level * 10);
  }
  return Math.max(100, 190 - level * 8);
}

function toKey(x, y) {
  return `${x},${y}`;
}

/**
 * Builds the player's snake at the start of a level / after losing a life.
 * Short snakes start as a straight line in the middle of the board, heading right.
 * Long ones (the player had already eaten a lot) are laid out as a serpentine so the
 * full length always fits, with the head row left free above so it can still turn.
 */
function buildSpawnSnake(length) {
  const inner = GRID - 2; // playable cells per row / column (1 … GRID-2)
  const cx = Math.floor(GRID / 2);
  const cy = Math.floor(GRID / 2);
  const len = Math.max(START_LENGTH, Math.min(length, 700));
  const body = [];

  if (len <= cx - 1) {
    for (let i = 0; i < len; i++) body.push({ x: cx - i, y: cy });
    return body;
  }

  // Row of the head: low enough that all the coils below it still fit on the board.
  const headRoom = cx; // cells of the head row that lie behind the head (x = cx … 1)
  const rowsBelow = Math.ceil((len - headRoom) / inner);
  const headY = Math.max(3, Math.min(cy, inner - rowsBelow));

  for (let x = cx; x >= 1 && body.length < len; x--) body.push({ x, y: headY });
  for (let y = headY + 1; y <= inner && body.length < len; y++) {
    const leftToRight = (y - headY) % 2 === 1;
    for (let i = 0; i < inner && body.length < len; i++) {
      body.push({ x: leftToRight ? 1 + i : inner - i, y });
    }
  }
  return body;
}

function createEnemy() {
  const enemy = {
    body: [],
    direction: { x: 1, y: 0 },
  };

  while (true) {
    const x = Math.floor(Math.random() * (GRID - 6)) + 3; // 3 … GRID-4, so the whole body stays inside
    const y = Math.floor(Math.random() * (GRID - 4)) + 2;
    const body = [
      { x, y },
      { x: x - 1, y },
      { x: x - 2, y },
    ];
    // never spawn on a wall, on the player's snake, or on the other rival
    const blocked = body.some(
      (c) =>
        state.poisonCells.has(toKey(c.x, c.y)) ||
        state.snake.some((seg) => seg.x === c.x && seg.y === c.y) ||
        state.enemies.some((e) => e.body.some((seg) => seg.x === c.x && seg.y === c.y))
    );
    if (blocked) continue;
    enemy.body = body;
    enemy.direction = { x: 1, y: 0 };
    return enemy;
  }
}

function findFood() {
  while (true) {
    const x = Math.floor(Math.random() * (GRID - 2)) + 1;
    const y = Math.floor(Math.random() * (GRID - 2)) + 1;
    const pos = { x, y };

    if (state.poisonCells.has(toKey(x, y))) {
      continue;
    }
    if (state.snake.some((seg) => seg.x === x && seg.y === y)) {
      continue;
    }
    if (state.enemies.some((enemy) => enemy.body.some((seg) => seg.x === x && seg.y === y))) {
      continue;
    }
    return pos;
  }
}

/**
 * Prepares a level (snake, food, enemies, HUD). Does not start the clock.
 * keepProgress = true (after losing a life): the target and the pills already
 * eaten toward it stay exactly as they were; only the snake/food are re-placed.
 */
function resetLevel(keepProgress = false) {
  stopLoop();
  state.target = getTargetForLevel(state.level);
  if (!keepProgress) {
    state.eatenInLevel = 0;
    state.collectedPills = new Set();
  }
  state.isHard = isHardLevel(state.level);
  state.poisonCells = buildPoisonCells();
  state.direction = { x: 1, y: 0 };
  state.queue = [];
  state.fx = [];

  // The snake never shrinks while a game is running: every pill adds one segment, so
  // its length is always START_LENGTH + pills eaten in this level. After losing a life
  // it comes back at that same length (a new level / new game starts at START_LENGTH).
  state.snake = buildSpawnSnake(START_LENGTH + (keepProgress ? state.eatenInLevel : 0));

  state.enemies = [];
  if (state.isHard) {
    state.enemies.push(createEnemy(), createEnemy());
  }

  state.food = findFood();
  snapshotPositions();
  updateHud();
  setStatus(state.isHard ? 'Hard level' : 'Normal level', state.isHard ? 'hard' : 'ok');
  markDirty();
}

/** Full reset after game over: level 1, score 0, full lives. (Best score is kept.) */
function startNewGame() {
  state.level = 1;
  state.score = 0;
  state.lives = MAX_LIVES;
  state.newBest = false;
  state.eatenInLevel = 0;
  resetLevel();
  saveProgress();
}

function setDirection(dir) {
  if (!dir || state.phase !== PHASE.PLAYING) return;

  const last = state.queue.length ? state.queue[state.queue.length - 1] : state.direction;
  if (dir.x === last.x && dir.y === last.y) return; // already heading that way
  if (dir.x === -last.x && dir.y === -last.y) return; // no 180° turns
  if (state.queue.length >= MAX_QUEUED_TURNS) return;

  state.queue.push(dir);
}

function setDirectionFromVector(x, y) {
  if (Math.abs(x) > Math.abs(y)) {
    setDirection({ x: x > 0 ? 1 : -1, y: 0 });
  } else if (y !== 0) {
    setDirection({ x: 0, y: y > 0 ? 1 : -1 });
  }
}

function advanceEnemy(enemy) {
  if (!enemy.body.length) return;

  const head = enemy.body[0];
  const candidates = [
    { x: 0, y: -1 },
    { x: 0, y: 1 },
    { x: -1, y: 0 },
    { x: 1, y: 0 },
  ];

  let best = null;
  let bestScore = Infinity;

  for (const dir of candidates) {
    const nx = head.x + dir.x;
    const ny = head.y + dir.y;

    if (nx <= 0 || ny <= 0 || nx >= GRID - 1 || ny >= GRID - 1) continue;
    if (state.poisonCells.has(toKey(nx, ny))) continue;
    if (enemy.body.some((seg) => seg.x === nx && seg.y === ny)) continue;
    if (state.snake.some((seg) => seg.x === nx && seg.y === ny)) continue;

    const score = Math.abs(nx - state.food.x) + Math.abs(ny - state.food.y);
    if (score < bestScore) {
      bestScore = score;
      best = dir;
    }
  }

  if (!best) return;

  enemy.direction = best;
  const newHead = { x: head.x + best.x, y: head.y + best.y };
  enemy.body.unshift(newHead);

  if (newHead.x === state.food.x && newHead.y === state.food.y) {
    state.food = findFood();
  } else {
    enemy.body.pop();
  }

  if (state.snake.some((seg) => seg.x === newHead.x && seg.y === newHead.y)) {
    handleDeath();
  }
}

function gameTick() {
  if (state.phase !== PHASE.PLAYING) return;

  snapshotPositions();
  state.lastTick = performance.now();

  if (state.queue.length) {
    state.direction = state.queue.shift();
  }

  const head = state.snake[0];
  const newHead = { x: head.x + state.direction.x, y: head.y + state.direction.y };

  if (
    newHead.x <= 0 || newHead.y <= 0 || newHead.x >= GRID - 1 || newHead.y >= GRID - 1 ||
    state.poisonCells.has(toKey(newHead.x, newHead.y)) ||
    state.snake.some((seg, index) => index < state.snake.length - 1 && seg.x === newHead.x && seg.y === newHead.y)
  ) {
    handleDeath();
    return;
  }

  state.snake.unshift(newHead);

  if (newHead.x === state.food.x && newHead.y === state.food.y) {
    state.eatenInLevel += 1;
    state.score += 1;
    updateBest();
    state.collectedPills.add(toKey(state.food.x, state.food.y));
    state.fx.push({ x: state.food.x, y: state.food.y, t0: performance.now() });
    state.food = findFood();

    if (state.eatenInLevel >= state.target) {
      moveToNextLevel();
      return;
    }
  } else {
    state.snake.pop();
  }

  if (state.isHard) {
    for (const enemy of state.enemies) {
      advanceEnemy(enemy);
      if (state.phase !== PHASE.PLAYING) return;
      if (state.snake.some((seg) => seg.x === enemy.body[0].x && seg.y === enemy.body[0].y)) {
        handleDeath();
        return;
      }
    }
  }

  updateHud();
}

function moveToNextLevel() {
  stopLoop();
  setPhase(PHASE.LEVEL_UP);
  updateHud(); // show the final pill (full meter) before the toast
  state.eatenInLevel = 0; // the new level starts from zero (also what gets saved)
  state.level += 1;
  state.lives = MAX_LIVES;
  saveProgress();
  setStatus('Level cleared!');

  const next = getTargetForLevel(state.level);
  setOverlay('toast', {
    kicker: 'Level cleared',
    title: `Level ${state.level}`,
    text: isHardLevel(state.level)
      ? 'Hard level — rival snakes ahead.'
      : `Next up: eat ${pillsText(next)}.`,
  });

  state.phaseTimer = setTimeout(() => {
    if (state.phase !== PHASE.LEVEL_UP) return;
    resetLevel();
    beginPlay();
  }, LEVEL_PAUSE_MS);
}

function handleDeath() {
  if (state.phase !== PHASE.PLAYING) return;

  stopLoop();
  setPhase(PHASE.DYING);
  state.lives -= 1;
  shakeBoard();

  if (state.lives <= 0) {
    // Game over: the whole game resets. Save the fresh start right now, so a page
    // reload on this screen can't bring the finished game back.
    updateBest();
    saveProgress({ level: 1, score: 0, lives: MAX_LIVES, eaten: 0 });
    updateHud(); // shows the final score + 0 lives until "New game"
    setPhase(PHASE.OVER);
    setStatus(`Game over — all ${MAX_LIVES} lives used`, 'warn');
    showOverOverlay();
    return;
  }

  // A life was lost: the level restarts, but the score is kept.
  saveProgress();
  updateHud();
  const left = `${state.lives} ${state.lives === 1 ? 'life' : 'lives'} left`;
  setStatus(`Snake terminated — ${left}`, 'warn');
  setOverlay('toast', {
    kicker: 'Snake terminated',
    title: left,
    text: `Score ${state.score.toLocaleString('en-US')}, target ${state.eatenInLevel}/${state.target} and snake length kept`,
  });

  state.phaseTimer = setTimeout(() => {
    if (state.phase !== PHASE.DYING) return;
    resetLevel(true); // a life lost: same target, same progress
    beginPlay();
  }, DEATH_PAUSE_MS);
}

function shakeBoard() {
  if (reducedMotion) return;
  boardEl.classList.remove('shake');
  void boardEl.offsetWidth;
  boardEl.classList.add('shake');
}
boardEl.addEventListener('animationend', () => boardEl.classList.remove('shake'));

/* ==========================================================================
   Rendering (canvas, HiDPI, follows the responsive board size)
   ========================================================================== */

const COLORS = {
  field: '#2a3b22', // mossy forest floor: light enough for the black snake to stand out
  fieldAlt: '#2f4326',
  wallFrom: '#3b1580',
  wallTo: '#8456f5',
  wallTile: 'rgba(255, 255, 255, 0.085)',
  wallEdge: 'rgba(205, 192, 255, 0.7)',
  wallGlow: 'rgba(167, 139, 250, 0.95)',
  food: '#ff4d7e',
  pill: 'rgba(251, 191, 36, 0.4)',
};

const bgCanvas = document.createElement('canvas');
let cell = 20; // canvas pixels per grid cell (always a whole number)

function roundRectPath(g, x, y, w, h, r) {
  if (typeof g.roundRect === 'function') {
    g.roundRect(x, y, w, h, r);
    return;
  }
  const rr = Math.min(r, w / 2, h / 2);
  g.moveTo(x + rr, y);
  g.arcTo(x + w, y, x + w, y + h, rr);
  g.arcTo(x + w, y + h, x, y + h, rr);
  g.arcTo(x, y + h, x, y, rr);
  g.arcTo(x, y, x + w, y, rr);
  g.closePath();
}

/** Small seeded random generator, so the ground texture looks the same after every resize. */
function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Static layer: mossy ground + poison wall frame. Rebuilt only on resize. */
function renderBackground() {
  const size = canvas.width;
  bgCanvas.width = size;
  bgCanvas.height = size;
  const g = bgCanvas.getContext('2d');

  g.fillStyle = COLORS.field;
  g.fillRect(0, 0, size, size);
  g.fillStyle = COLORS.fieldAlt;
  for (let x = 1; x < GRID - 1; x++) {
    for (let y = 1; y < GRID - 1; y++) {
      if ((x + y) % 2) g.fillRect(x * cell, y * cell, cell, cell);
    }
  }

  // Ground texture: soft moss and soil patches, then pebbles, leaf litter and moss specks
  const rnd = seededRandom(7311);
  for (let i = 0; i < GRID * GRID * 2; i++) {
    const x = cell + rnd() * (size - cell * 2);
    const y = cell + rnd() * (size - cell * 2);
    const r = cell * (0.35 + rnd() * 1.1);
    const patch = g.createRadialGradient(x, y, 0, x, y, r);
    const tone = rnd();
    patch.addColorStop(0, tone < 0.62 ? 'rgba(104, 156, 66, 0.20)' : tone < 0.85 ? 'rgba(92, 70, 42, 0.20)' : 'rgba(14, 24, 12, 0.22)');
    patch.addColorStop(1, 'rgba(0, 0, 0, 0)');
    g.fillStyle = patch;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }
  for (let i = 0; i < GRID * GRID * 1.2; i++) {
    const x = cell + rnd() * (size - cell * 2);
    const y = cell + rnd() * (size - cell * 2);
    const k = rnd();
    g.fillStyle = k < 0.35 ? 'rgba(150, 146, 130, 0.22)' : k < 0.7 ? 'rgba(140, 104, 58, 0.2)' : 'rgba(150, 200, 90, 0.2)';
    g.beginPath();
    g.ellipse(x, y, cell * (0.03 + rnd() * 0.07), cell * (0.02 + rnd() * 0.05), rnd() * Math.PI, 0, Math.PI * 2);
    g.fill();
  }

  // Soft vignette
  const vg = g.createRadialGradient(size / 2, size / 2, size * 0.25, size / 2, size / 2, size * 0.72);
  vg.addColorStop(0, 'rgba(0,0,0,0)');
  vg.addColorStop(1, 'rgba(0,0,0,0.38)');
  g.fillStyle = vg;
  g.fillRect(0, 0, size, size);

  // Wall frame = outer rounded rect minus inner rounded rect
  const frame = new Path2D();
  const outer = new Path2D();
  const inner = new Path2D();
  roundRectPath(outer, 0, 0, size, size, cell * 0.96);
  roundRectPath(inner, cell, cell, size - cell * 2, size - cell * 2, cell * 0.4);
  frame.addPath(outer);
  frame.addPath(inner);

  const grad = g.createLinearGradient(0, 0, size, size);
  grad.addColorStop(0, COLORS.wallFrom);
  grad.addColorStop(1, COLORS.wallTo);
  g.fillStyle = grad;
  g.fill(frame, 'evenodd');

  // Individual wall tiles, so it still reads as "cells"
  g.save();
  g.clip(frame, 'evenodd');
  g.fillStyle = COLORS.wallTile;
  const pad = cell * 0.11;
  g.beginPath();
  for (let i = 0; i < GRID; i++) {
    for (const [x, y] of [[i, 0], [i, GRID - 1], [0, i], [GRID - 1, i]]) {
      roundRectPath(g, x * cell + pad, y * cell + pad, cell - pad * 2, cell - pad * 2, cell * 0.2);
    }
  }
  g.fill();
  g.restore();

  // Glowing inner edge
  g.save();
  g.strokeStyle = COLORS.wallEdge;
  g.lineWidth = Math.max(1.5, cell * 0.07);
  g.shadowColor = COLORS.wallGlow;
  g.shadowBlur = cell * 0.7;
  g.beginPath();
  roundRectPath(g, cell, cell, size - cell * 2, size - cell * 2, cell * 0.4);
  g.stroke();
  g.restore();
}

/** Sizes the canvas to the board in real device pixels (up to 4096 px, i.e. 4K). */
function resizeCanvas() {
  const cssSize = boardEl.clientWidth;
  if (!cssSize) return;

  const dpr = Math.min(window.devicePixelRatio || 1, 4);
  const wanted = Math.min(MAX_CANVAS_PX, Math.round(cssSize * dpr));
  // Whole pixels per cell → razor-sharp cell edges, no seams between tiles
  const px = Math.max(GRID * 10, Math.floor(wanted / GRID) * GRID);
  if (canvas.width !== px || canvas.height !== px) {
    canvas.width = px;
    canvas.height = px;
  }
  cell = canvas.width / GRID;
  renderBackground();
  markDirty();
}

/* ---------- Smooth motion ----------
   The game logic still ticks at the level's speed, but what is drawn is
   interpolated between the previous and the current tick, every display frame. */

function motionT(now) {
  if (state.phase !== PHASE.PLAYING || reducedMotion) return 1;
  return Math.min(1, Math.max(0, (now - state.lastTick) / state.tickMs));
}

/** Cell-centre points (in grid units) for a snake, blended between two ticks. */
function blendBody(cur, prev, t) {
  const out = new Array(cur.length);
  const last = prev.length - 1;
  for (let i = 0; i < cur.length; i++) {
    const c = cur[i];
    const p = prev[i] || prev[last] || c; // a freshly grown tail unrolls from the old tail
    out[i] = { x: p.x + (c.x - p.x) * t + 0.5, y: p.y + (c.y - p.y) * t + 0.5 };
  }
  return out;
}

/* ---------- Realistic snake ----------
   A smooth tube that follows the snake's cells (corners rounded with Chaikin cutting),
   drawn in layers, modelled on a blue-striped coral snake:
     ground shadow → light side stripe → glossy black body → orange tail tip
     → diamond scale mesh → sheen → sculpted head (eyes, nostrils, flicking tongue). */

const SNAKE_LOOKS = {
  coral: {
    body: '#090c13', stripe: '#6ab8ee', outline: 'rgba(6, 26, 52, 0.8)', seam: 'rgba(2, 5, 10, 0.8)',
    mesh: '132,180,226', sheen: '176,208,255', tail: '255,96,28', tailMesh: '112,20,4',
    headA: '#ff8a3c', headB: '#df380c', headEdge: 'rgba(104, 20, 4, 0.85)', tongue: '#e0122c',
  },
  rival: {
    body: '#15110a', stripe: '#e4b13a', outline: 'rgba(60, 38, 4, 0.8)', seam: 'rgba(8, 5, 0, 0.8)',
    mesh: '220,176,76', sheen: '255,232,160', tail: '255,190,60', tailMesh: '120,70,0',
    headA: '#ffe27a', headB: '#d28a10', headEdge: 'rgba(92, 54, 0, 0.85)', tongue: '#c2182b',
  },
  dead: {
    body: '#15161b', stripe: '#7b8794', outline: 'rgba(20, 24, 30, 0.8)', seam: 'rgba(0, 0, 0, 0.8)',
    mesh: '120,128,140', sheen: '200,210,225', tail: '150,100,92', tailMesh: '60,30,26',
    headA: '#b9857a', headB: '#7c4a44', headEdge: 'rgba(40, 14, 12, 0.85)', tongue: '#7a2a32',
  },
};

const BODY_F = 0.82; // dark body width as a fraction of the full tube (the rest is the light side stripe)

function smoothstep(x) {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
}

/** Chaikin corner cutting: turns a polyline of cell centres into a smooth curve. */
function smoothPath(pts, iterations) {
  let p = pts;
  for (let k = 0; k < iterations && p.length > 2; k++) {
    const q = [p[0]];
    for (let i = 0; i < p.length - 1; i++) {
      const a = p[i];
      const b = p[i + 1];
      q.push({ x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25 });
      q.push({ x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75 });
    }
    q.push(p[p.length - 1]);
    p = q;
  }
  return p;
}

/** Re-samples a polyline at an even arc-length spacing. Each sample gets `s` = distance from the head. */
function resample(path, step) {
  const out = [{ x: path[0].x, y: path[0].y, s: 0 }];
  let travelled = 0;
  let next = step;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len === 0) continue;
    while (travelled + len >= next) {
      const t = (next - travelled) / len;
      out.push({ x: a.x + dx * t, y: a.y + dy * t, s: next });
      next += step;
    }
    travelled += len;
  }
  const end = path[path.length - 1];
  if (out[out.length - 1].s < travelled - 1e-6) out.push({ x: end.x, y: end.y, s: travelled });
  return { samples: out, total: travelled };
}

/** Closed outline of the body between samples i0…i1 at `f` × the local half-width. Works on a context or a Path2D. */
function tubePath(g, S, i0, i1, f) {
  const a = S[i0];
  g.moveTo(a.x + a.nx * a.h * f, a.y + a.ny * a.h * f);
  for (let i = i0 + 1; i <= i1; i++) g.lineTo(S[i].x + S[i].nx * S[i].h * f, S[i].y + S[i].ny * S[i].h * f);
  for (let i = i1; i >= i0; i--) g.lineTo(S[i].x - S[i].nx * S[i].h * f, S[i].y - S[i].ny * S[i].h * f);
  g.closePath();
}

/** Head outline in head-local units (1 = one cell, +x = forward). Rounded at the back so it blends into the neck. */
function headPath(g) {
  g.moveTo(0.7, 0);
  g.bezierCurveTo(0.68, -0.2, 0.42, -0.37, 0.1, -0.38);
  g.bezierCurveTo(-0.2, -0.39, -0.46, -0.24, -0.5, 0);
  g.bezierCurveTo(-0.46, 0.24, -0.2, 0.39, 0.1, 0.38);
  g.bezierCurveTo(0.42, 0.37, 0.68, 0.2, 0.7, 0);
  g.closePath();
}

/** Forked tongue, in head-local units. It flicks in and out. */
function drawTongueLocal(now, color) {
  const flick = (Math.sin(now / 210) + Math.sin(now / 97)) / 2;
  if (flick < 0.35) return;
  const bx = 0.62;
  const tx = bx + 0.28 + 0.2 * flick;
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(0.05, 1.4 / cell);
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(bx, 0);
  ctx.lineTo(tx, 0);
  ctx.moveTo(tx, 0);
  ctx.lineTo(tx + 0.11, 0.09);
  ctx.moveTo(tx, 0);
  ctx.lineTo(tx + 0.11, -0.09);
  ctx.stroke();
}

function drawSnakeHead(S, c, L, { dead, tongue, now }) {
  const lookBack = S[Math.min(S.length - 1, Math.max(2, Math.round((0.7 * c) / (c * 0.11))))];
  const ang = Math.atan2(S[0].y - lookBack.y, S[0].x - lookBack.x);

  ctx.save();
  ctx.translate(S[0].x, S[0].y);
  ctx.rotate(ang);
  ctx.scale(c, c);
  ctx.lineJoin = 'round';

  if (tongue && !dead) drawTongueLocal(now, L.tongue);

  // head: soft drop shadow, then a lit orange gradient
  const hg = ctx.createRadialGradient(0.16, -0.13, 0.02, 0.05, 0, 0.66);
  hg.addColorStop(0, L.headA);
  hg.addColorStop(1, L.headB);
  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.55)';
  ctx.shadowBlur = c * 0.25;
  ctx.shadowOffsetX = c * 0.05;
  ctx.shadowOffsetY = c * 0.1;
  ctx.fillStyle = hg;
  ctx.beginPath();
  headPath(ctx);
  ctx.fill();
  ctx.restore();

  ctx.strokeStyle = L.headEdge;
  ctx.lineWidth = 0.028;
  ctx.beginPath();
  headPath(ctx);
  ctx.stroke();

  // specular highlight
  ctx.fillStyle = 'rgba(255, 244, 228, 0.3)';
  ctx.beginPath();
  ctx.ellipse(0.26, -0.13, 0.22, 0.06, -0.2, 0, Math.PI * 2);
  ctx.fill();

  // mouth line and head plates, as fine dark lines
  ctx.strokeStyle = 'rgba(96, 18, 4, 0.55)';
  ctx.lineWidth = 0.018;
  ctx.lineCap = 'round';
  ctx.beginPath();
  for (const s of [-1, 1]) {
    ctx.moveTo(0.66, s * 0.05);
    ctx.bezierCurveTo(0.46, s * 0.2, 0.2, s * 0.3, -0.04, s * 0.3);
  }
  ctx.moveTo(0.5, 0); ctx.lineTo(0.0, 0);
  for (const s of [-1, 1]) {
    ctx.moveTo(0.4, s * 0.1); ctx.bezierCurveTo(0.26, s * 0.1, 0.12, s * 0.17, 0.0, s * 0.2);
  }
  ctx.stroke();

  // nostrils
  ctx.fillStyle = 'rgba(60, 12, 2, 0.75)';
  ctx.beginPath();
  for (const s of [-1, 1]) {
    ctx.moveTo(0.57 + 0.016, s * 0.06);
    ctx.arc(0.57, s * 0.06, 0.016, 0, Math.PI * 2);
  }
  ctx.fill();

  // eyes (small and black, like a coral snake's)
  for (const s of [-1, 1]) {
    const ex = 0.3;
    const ey = s * 0.2;
    if (dead) {
      ctx.strokeStyle = '#1b0505';
      ctx.lineWidth = 0.035;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(ex - 0.055, ey - 0.055); ctx.lineTo(ex + 0.055, ey + 0.055);
      ctx.moveTo(ex + 0.055, ey - 0.055); ctx.lineTo(ex - 0.055, ey + 0.055);
      ctx.stroke();
      continue;
    }
    ctx.fillStyle = '#04060a';
    ctx.beginPath();
    ctx.arc(ex, ey, 0.05, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.beginPath();
    ctx.arc(ex - 0.016, ey - 0.02, 0.015, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}

/**
 * Draws one snake. `gridPts` = cell centres (grid units), head first.
 * `look` = 'coral' (player) or 'rival'; a dead snake is always drawn grey.
 */
function drawSnake(gridPts, look, { dead = false, tongue = false, now = 0 } = {}) {
  const n = gridPts.length;
  if (n < 2) return;
  const c = cell;
  const L = SNAKE_LOOKS[dead ? 'dead' : look];

  // 1) centre line in canvas pixels, extended a little past the tail, then smoothed + resampled
  const pts = gridPts.map((p) => ({ x: p.x * c, y: p.y * c }));
  const a = pts[n - 2];
  const b = pts[n - 1];
  pts.push({ x: b.x + (b.x - a.x) * 0.45, y: b.y + (b.y - a.y) * 0.45 });

  const step = c * 0.11;
  const { samples: S, total } = resample(smoothPath(pts, 3), step);
  const m = S.length;
  if (m < 4) return;

  // 2) per-sample normal + half-width (slim neck, fuller body, long tapering tail)
  const tailLen = Math.min(total * 0.28, 2.8 * c);
  for (let i = 0; i < m; i++) {
    const p0 = S[Math.max(0, i - 1)];
    const p1 = S[Math.min(m - 1, i + 1)];
    const tl = Math.hypot(p1.x - p0.x, p1.y - p0.y) || 1;
    const p = S[i];
    p.nx = -(p1.y - p0.y) / tl;
    p.ny = (p1.x - p0.x) / tl;
    const taper = total - p.s >= tailLen ? 1 : Math.pow(Math.max((total - p.s) / tailLen, 0), 0.7);
    p.h = c * 0.4 * (0.82 + 0.18 * smoothstep(p.s / (2.4 * c))) * Math.max(0.16, taper);
  }

  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  // 3) soft ground shadow (two stacked, offset, translucent tubes: much cheaper than shadowBlur),
  //    then the light side stripe = the full-width tube
  ctx.save();
  ctx.translate(c * 0.05, c * 0.1);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.16)';
  ctx.beginPath();
  tubePath(ctx, S, 0, m - 1, 1.22);
  ctx.fill();
  ctx.fillStyle = 'rgba(0, 0, 0, 0.26)';
  ctx.beginPath();
  tubePath(ctx, S, 0, m - 1, 1.07);
  ctx.fill();
  ctx.restore();
  ctx.fillStyle = L.stripe;
  ctx.beginPath();
  tubePath(ctx, S, 0, m - 1, 1);
  ctx.fill();
  ctx.strokeStyle = L.outline;
  ctx.lineWidth = Math.max(1, c * 0.025);
  ctx.beginPath();
  tubePath(ctx, S, 0, m - 1, 1);
  ctx.stroke();

  // 4) glossy dark body on top, leaving the stripe visible along both flanks
  ctx.fillStyle = L.body;
  ctx.beginPath();
  tubePath(ctx, S, 0, m - 1, BODY_F);
  ctx.fill();

  // 5) orange tail tip, fading in over the last stretch of the body
  let iTail = m - 1;
  while (iTail > 0 && S[iTail - 1].s >= total - tailLen) iTail--;
  if (m - 1 - iTail > 2) {
    const g0 = S[iTail];
    const g1 = S[m - 1];
    const tg = ctx.createLinearGradient(g0.x, g0.y, g1.x, g1.y);
    tg.addColorStop(0, `rgba(${L.tail}, 0)`);
    tg.addColorStop(0.22, `rgba(${L.tail}, 0.95)`);
    tg.addColorStop(1, `rgba(${L.tail}, 1)`);
    ctx.fillStyle = tg;
    ctx.beginPath();
    tubePath(ctx, S, iTail, m - 1, 1);
    ctx.fill();
  }

  // 6) diamond scale mesh: rows of rhombi, every other row shifted by half a scale
  let rowEvery = n > 60 ? 2 : 1; // long snakes get bigger scales (fewer shapes per frame)
  rowEvery = Math.max(rowEvery, Math.ceil(4 / (step * 0.85))); // never finer than ~4 px
  const rowStep = step * rowEvery;
  const pitch = rowStep / 0.85;
  const meshBody = new Path2D();
  const meshTail = new Path2D();
  for (let i = 0, r = 0; i < m; i += rowEvery, r++) {
    const p = S[i];
    const half = p.h * BODY_F;
    if (half < pitch * 0.3) continue;
    const path = p.s > total - tailLen * 0.9 ? meshTail : meshBody;
    const tx = p.ny; // tangent = normal rotated back
    const ty = -p.nx;
    const off0 = r & 1 ? pitch / 2 : 0;
    const kmax = Math.ceil(half / pitch) + 1;
    for (let k = -kmax; k <= kmax; k++) {
      const o = k * pitch + off0;
      if (Math.abs(o) - pitch * 0.5 > half) continue;
      const cx = p.x + p.nx * o;
      const cy = p.y + p.ny * o;
      // only the two edges on one side of each diamond: its neighbour draws the other two
      path.moveTo(cx + tx * rowStep, cy + ty * rowStep);
      path.lineTo(cx + p.nx * pitch * 0.5, cy + p.ny * pitch * 0.5);
      path.lineTo(cx - tx * rowStep, cy - ty * rowStep);
    }
  }

  ctx.save();
  ctx.beginPath();
  tubePath(ctx, S, 0, m - 1, BODY_F);
  ctx.clip();
  // darker flanks make the body read as a round tube
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.4)';
  ctx.lineWidth = c * 0.16;
  ctx.beginPath();
  tubePath(ctx, S, 0, m - 1, BODY_F);
  ctx.stroke();

  const meshAlpha = 0.3 + 0.24 * Math.min(1, Math.max(0, (pitch - 4) / 8));
  ctx.lineWidth = Math.max(0.8, c * 0.012);
  ctx.strokeStyle = `rgba(${L.mesh}, ${meshAlpha.toFixed(2)})`;
  ctx.stroke(meshBody);
  ctx.strokeStyle = `rgba(${L.tailMesh}, ${(meshAlpha + 0.2).toFixed(2)})`;
  ctx.stroke(meshTail);

  // 7) sheen: a light always falling from the upper left
  ctx.translate(-c * 0.05, -c * 0.08);
  ctx.fillStyle = `rgba(${L.sheen}, 0.13)`;
  ctx.beginPath();
  tubePath(ctx, S, 0, m - 1, 0.32);
  ctx.fill();
  ctx.fillStyle = `rgba(${L.sheen}, 0.17)`;
  ctx.beginPath();
  tubePath(ctx, S, 0, m - 1, 0.12);
  ctx.fill();
  ctx.restore();

  // 8) crisp seam between body and stripe
  ctx.strokeStyle = L.seam;
  ctx.lineWidth = Math.max(1, c * 0.03);
  ctx.beginPath();
  tubePath(ctx, S, 0, m - 1, BODY_F);
  ctx.stroke();

  // 9) head last, so it sits on top of the neck
  drawSnakeHead(S, c, L, { dead, tongue, now });
}

function drawPills() {
  ctx.fillStyle = COLORS.pill;
  ctx.beginPath();
  state.collectedPills.forEach((key) => {
    const [x, y] = key.split(',').map(Number);
    ctx.moveTo((x + 0.5) * cell + cell * 0.1, (y + 0.5) * cell);
    ctx.arc((x + 0.5) * cell, (y + 0.5) * cell, cell * 0.1, 0, Math.PI * 2);
  });
  ctx.fill();
}

function drawFood(now) {
  const pulse = reducedMotion ? 0.5 : (Math.sin(now / 240) + 1) / 2;
  const cx = (state.food.x + 0.5) * cell;
  const cy = (state.food.y + 0.5) * cell;
  const r = cell * (0.27 + 0.035 * pulse);

  // expanding halo
  if (!reducedMotion) {
    const ph = (now % 1400) / 1400;
    ctx.strokeStyle = `rgba(255, 77, 126, ${(0.35 * (1 - ph)).toFixed(3)})`;
    ctx.lineWidth = Math.max(1, cell * 0.04);
    ctx.beginPath();
    ctx.arc(cx, cy, r + cell * 0.5 * ph, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.save();
  ctx.shadowColor = 'rgba(255, 77, 126, 0.95)';
  ctx.shadowBlur = cell * (0.55 + 0.45 * pulse);
  const grad = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.35, r * 0.1, cx, cy, r);
  grad.addColorStop(0, '#ffc2d4');
  grad.addColorStop(1, COLORS.food);
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.beginPath();
  ctx.arc(cx - r * 0.35, cy - r * 0.4, r * 0.18, 0, Math.PI * 2);
  ctx.fill();
}

const FX_MS = 520;

function drawFx(now) {
  if (!state.fx.length) return;

  state.fx = state.fx.filter((fx) => now - fx.t0 < FX_MS);
  for (const fx of state.fx) {
    const p = (now - fx.t0) / FX_MS;
    const cx = (fx.x + 0.5) * cell;
    const cy = (fx.y + 0.5) * cell;
    const fade = (1 - p).toFixed(3);

    ctx.strokeStyle = `rgba(53, 242, 162, ${fade})`;
    ctx.lineWidth = Math.max(1.5, cell * 0.09 * (1 - p));
    ctx.beginPath();
    ctx.arc(cx, cy, cell * (0.3 + 1.05 * p), 0, Math.PI * 2);
    ctx.stroke();

    // burst of sparks
    ctx.fillStyle = `rgba(255, 140, 180, ${fade})`;
    ctx.beginPath();
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2 + 0.4;
      const d = cell * (0.25 + 0.9 * p);
      const rr = cell * 0.07 * (1 - p);
      ctx.moveTo(cx + Math.cos(a) * d + rr, cy + Math.sin(a) * d);
      ctx.arc(cx + Math.cos(a) * d, cy + Math.sin(a) * d, rr, 0, Math.PI * 2);
    }
    ctx.fill();
  }
}

function render(now) {
  const t = motionT(now);
  const dead = state.phase === PHASE.DYING || state.phase === PHASE.OVER;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bgCanvas, 0, 0);
  drawPills();
  drawFood(now);

  if (state.isHard) {
    for (const enemy of state.enemies) {
      drawSnake(blendBody(enemy.body, enemy.prev || enemy.body, t), 'rival', { tongue: true, now });
    }
  }

  drawSnake(blendBody(state.snake, state.prevSnake, t), 'coral', { dead, tongue: true, now });

  drawFx(now);
}

function frame(now) {
  requestAnimationFrame(frame);

  const animating =
    state.phase === PHASE.PLAYING ||
    state.phase === PHASE.COUNTDOWN ||
    state.phase === PHASE.DYING ||
    state.phase === PHASE.LEVEL_UP ||
    state.phase === PHASE.READY ||
    state.phase === PHASE.PAUSED ||
    state.fx.length > 0;

  if (!animating && !dirty) return;
  dirty = false;
  render(now);
}

if (typeof ResizeObserver === 'function') {
  new ResizeObserver(resizeCanvas).observe(boardEl);
}
window.addEventListener('resize', resizeCanvas);

/* ==========================================================================
   Input: keyboard + swipe (no on-screen controls)
   ========================================================================== */

const KEY_DIRS = {
  arrowup: { x: 0, y: -1 },
  w: { x: 0, y: -1 },
  arrowdown: { x: 0, y: 1 },
  s: { x: 0, y: 1 },
  arrowleft: { x: -1, y: 0 },
  a: { x: -1, y: 0 },
  arrowright: { x: 1, y: 0 },
  d: { x: 1, y: 0 },
};

function handleKey(event) {
  if (document.body.classList.contains('intro-active')) return; // intro still playing
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (accountDialog.open) return;

  const tag = event.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || event.target.isContentEditable) return;

  const key = event.key.toLowerCase();

  if (KEY_DIRS[key]) {
    event.preventDefault();
    setDirection(KEY_DIRS[key]);
    return;
  }

  // Let a focused button handle its own Space / Enter
  if (tag === 'BUTTON' && (key === ' ' || key === 'enter')) return;

  if (key === ' ' || key === 'spacebar') {
    event.preventDefault();
    togglePause();
  } else if (key === 'p' || key === 'escape') {
    togglePause();
  } else if (key === 'enter') {
    event.preventDefault();
    primaryAction();
  }
}

document.addEventListener('keydown', handleKey);

/* Swipe: drag anywhere on the screen to steer. Turns register as soon as the
   finger has travelled far enough, so you can chain turns without lifting. */

const swipe = { id: null, x: 0, y: 0 };

function swipeThreshold() {
  return Math.min(36, Math.max(16, boardEl.clientWidth * 0.05));
}

document.addEventListener('pointerdown', (event) => {
  if (event.pointerType === 'mouse' || !event.isPrimary) return;
  if (event.target.closest('button, input, a, label, dialog')) return;
  swipe.id = event.pointerId;
  swipe.x = event.clientX;
  swipe.y = event.clientY;
});

document.addEventListener('pointermove', (event) => {
  if (event.pointerId !== swipe.id) return;

  const dx = event.clientX - swipe.x;
  const dy = event.clientY - swipe.y;
  if (Math.max(Math.abs(dx), Math.abs(dy)) < swipeThreshold()) return;

  setDirectionFromVector(dx, dy);
  swipe.x = event.clientX;
  swipe.y = event.clientY;
});

function endSwipe(event) {
  if (event.pointerId === swipe.id) swipe.id = null;
}
document.addEventListener('pointerup', endSwipe);
document.addEventListener('pointercancel', endSwipe);

// Never let the game keep running while the page is hidden
document.addEventListener('visibilitychange', () => {
  if (document.hidden) pause();
});

/* ---------- Buttons ---------- */

overlayBtn.addEventListener('click', () => {
  overlayBtn.blur();
  primaryAction();
});

pauseBtn.addEventListener('click', () => {
  pauseBtn.blur();
  togglePause();
});

/* ==========================================================================
   Account dialog
   ========================================================================== */

let logoutArmed = false;
let logoutTimer = null;

function disarmLogout() {
  logoutArmed = false;
  clearTimeout(logoutTimer);
  logoutBtn.classList.remove('is-armed');
  logoutBtn.textContent = 'Logout';
}

function openAccount() {
  pause();
  authError.hidden = true;
  updateAuthUI();
  if (typeof accountDialog.showModal === 'function') {
    accountDialog.showModal();
  } else {
    accountDialog.setAttribute('open', '');
  }
  if (!state.mobile) mobileInput.focus();
}

function closeAccount() {
  disarmLogout();
  if (typeof accountDialog.close === 'function') accountDialog.close();
  else accountDialog.removeAttribute('open');
}

accountBtn.addEventListener('click', openAccount);
closeAccountBtn.addEventListener('click', closeAccount);
accountDialog.addEventListener('close', disarmLogout);

// Click on the dimmed backdrop closes the dialog
accountDialog.addEventListener('click', (event) => {
  if (event.target === accountDialog) closeAccount();
});

mobileInput.addEventListener('input', () => {
  mobileInput.value = mobileInput.value.replace(/\D/g, '').slice(0, 10);
  authError.hidden = true;
});

// Pasting "+91 98765 43210" should give the 10-digit number
mobileInput.addEventListener('paste', (event) => {
  const text = (event.clipboardData || window.clipboardData)?.getData('text');
  if (!text) return;
  event.preventDefault();
  mobileInput.value = normalizeMobileNumber(text);
  authError.hidden = true;
});

authForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if (state.mobile) return;

  const number = normalizeMobileNumber(mobileInput.value);
  if (number.length < 10) {
    authError.textContent = 'Enter your 10-digit mobile number.';
    authError.hidden = false;
    mobileInput.focus();
    return;
  }

  state.mobile = number;
  store.set(LAST_MOBILE_KEY, number);

  if (restoreProgress()) {
    resetLevel(true);
    enterReady();
    setStatus('Saved level loaded', 'info');
  } else {
    saveProgress();
    setStatus('Progress saved', 'info');
  }

  mobileInput.value = '';
  updateAuthUI();
  closeAccount();
});

logoutBtn.addEventListener('click', () => {
  // Logging out clears this number's saved progress, so ask for a second tap.
  if (!logoutArmed) {
    logoutArmed = true;
    logoutBtn.classList.add('is-armed');
    logoutBtn.textContent = 'Tap again to clear progress & logout';
    logoutTimer = setTimeout(disarmLogout, 4000);
    return;
  }

  if (state.mobile) store.remove(buildProgressKey(state.mobile));
  store.remove(LAST_MOBILE_KEY);
  state.mobile = '';
  mobileInput.value = '';
  updateAuthUI();
  setStatus('Logged out', 'info');
  closeAccount();
});

// Typing a number: freeze the game behind the dialog (handled by openAccount → pause)

/* ==========================================================================
   Boot
   ========================================================================== */

buildHearts();
loadBest();

state.mobile = normalizeMobileNumber(store.get(LAST_MOBILE_KEY));
const restoredOnLoad = restoreProgress();
updateAuthUI();

resetLevel(true);
resizeCanvas();
enterReady();
if (restoredOnLoad) setStatus('Saved level loaded', 'info');
else setStatus('Ready');

requestAnimationFrame(frame);
