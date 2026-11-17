/* ==========================================================================
   Intro sequence — fully automatic:
     1. black space, silver "MKLOFT" fades in and out                    (~3 s)
     2. cinematic loading screen built on the snake key art: focus-pull
        reveal, slow camera push, glitch cuts, light sweeps, floating
        shards, eyes that glow brighter as the bar fills, and a flare at
        100 %                                                           (~4–5 s)
     3. the HUD drifts toward you and everything fades into the game

   The scene is a pure function of time (see drawScene), so the same code
   runs live in the game and can be stepped frame by frame to render a video:
   open index.html?export=1 and call window.__intro.seek(milliseconds).
   ========================================================================== */
(function () {
  const intro = document.getElementById('intro');
  if (!intro) return;

  const params = new URLSearchParams(window.location.search);
  const EXPORT = params.has('export');
  const ART_SRC = params.get('art') || 'assets/intro-art.jpg';

  const canvas = document.getElementById('introCanvas');
  const g = canvas.getContext('2d');
  const pctEl = document.getElementById('loadPct');
  const trackEl = document.getElementById('loadTrack');
  const statusEl = document.getElementById('loadStatus');
  const tipEl = document.getElementById('loadTip');
  const tipNoEl = document.getElementById('loadTipNo');
  const barEl = document.getElementById('loadBarWrap');

  const reduced = !EXPORT && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const MK_MS = reduced ? 1600 : 3200; // splash (the CSS text animation lasts 3 s)
  const LOAD_MS = reduced ? 1800 : 4600; // minimum length of the loading screen
  const HOLD_MS = 450; // stay on 100 % for a moment (the flare plays here)
  const OUT_MS = 900; // fade into the game

  const STATUS = [
    [0, 'Waking the snake…'],
    [25, 'Planting pills…'],
    [50, 'Raising the purple walls…'],
    [75, 'Sharpening every pixel…'],
    [100, 'Ready!'],
  ];

  const TIPS = [
    'Lose a life, keep your score, target and snake length.',
    'Every 5th level brings rival snakes.',
    'Swipe anywhere to steer — or use the arrow keys.',
    'Clearing a level refills all your lives.',
    'The purple walls cost a life. Stay clear.',
  ];

  /* ---------- Helpers ---------- */

  const TAU = Math.PI * 2;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const smooth = (a, b, x) => {
    const k = clamp((x - a) / (b - a), 0, 1);
    return k * k * (3 - 2 * k);
  };
  const easeOutCubic = (k) => 1 - Math.pow(1 - k, 3);
  const hash = (n) => {
    const s = Math.sin(n * 127.1) * 43758.5453;
    return s - Math.floor(s);
  };
  const rng = (seed) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  /* ---------- The key art ---------- */

  // where things are in the artwork, as fractions of its width / height
  const FOCAL = { x: 0.487, y: 0.47 }; // the snake's head
  const EYES = [{ x: 0.455, y: 0.473 }, { x: 0.519, y: 0.471 }];
  const TONGUE = { x: 0.487, y: 0.6 };

  const art = new Image();
  art.decoding = 'async';
  art.src = ART_SRC;
  let artOK = false;
  let IW = 4; // artwork size (placeholder 4:3 until it has loaded)
  let IH = 3;
  const CS = 0.5; // colour-channel layers are kept at half size to save memory
  const blurLayer = document.createElement('canvas');
  const chan = [document.createElement('canvas'), document.createElement('canvas'), document.createElement('canvas')];

  function buildLayers() {
    IW = art.naturalWidth;
    IH = art.naturalHeight;

    // soft stand-in for the focus pull: shrink to 1/16, grow back to 1/4 so it scales up smoothly
    const small = document.createElement('canvas');
    small.width = Math.max(8, IW >> 4);
    small.height = Math.max(6, IH >> 4);
    const sg = small.getContext('2d');
    sg.imageSmoothingQuality = 'high';
    sg.drawImage(art, 0, 0, small.width, small.height);
    blurLayer.width = Math.max(16, IW >> 2);
    blurLayer.height = Math.max(12, IH >> 2);
    const bg = blurLayer.getContext('2d');
    bg.imageSmoothingQuality = 'high';
    bg.drawImage(small, 0, 0, blurLayer.width, blurLayer.height);

    // red / green / blue copies for the glitch's colour split (multiply keeps just one channel, no pixel reads)
    ['#ff0000', '#00ff00', '#0000ff'].forEach((col, i) => {
      const cv = chan[i];
      cv.width = Math.round(IW * CS);
      cv.height = Math.round(IH * CS);
      const x = cv.getContext('2d');
      x.drawImage(art, 0, 0, cv.width, cv.height);
      x.globalCompositeOperation = 'multiply';
      x.fillStyle = col;
      x.fillRect(0, 0, cv.width, cv.height);
    });
    artOK = true;
  }

  const artPromise = (art.decode ? art.decode() : new Promise((res, rej) => { art.onload = res; art.onerror = rej; }))
    .then(buildLayers)
    .catch(() => { /* no art? the scene falls back to a plain gradient */ });

  /* ---------- Real asset readiness (fonts + logo + art), so 100 % means something ---------- */

  const logo = intro.querySelector('.load-logo');
  const ready = Promise.all([
    document.fonts && document.fonts.ready ? document.fonts.ready.catch(() => {}) : Promise.resolve(),
    logo && logo.decode ? logo.decode().catch(() => {}) : Promise.resolve(),
    artPromise,
    document.readyState === 'complete'
      ? Promise.resolve()
      : new Promise((res) => window.addEventListener('load', res, { once: true })),
  ]);
  let assetsReady = false;
  ready.then(() => { assetsReady = true; });
  setTimeout(() => { assetsReady = true; }, 8000); // never hang on a slow asset

  /* ---------- Canvas sizing ---------- */

  let W = 0;
  let H = 0;
  let vmin = 0;
  let dpr = 1;
  let lite = false;
  let stars = [];
  const post = document.createElement('canvas'); // vignette + scrims, painted once per size

  function resize() {
    W = window.innerWidth;
    H = window.innerHeight;
    vmin = Math.min(W, H);
    dpr = Math.min(window.devicePixelRatio || 1, lite ? 1 : 2);
    const MAX_PIXELS = 8.6e6; // enough for a full 4K canvas
    if (W * H * dpr * dpr > MAX_PIXELS) dpr = Math.max(1, Math.sqrt(MAX_PIXELS / (W * H)));
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);

    const count = Math.round((W * H) / 5200);
    const r = rng(7);
    stars = Array.from({ length: count }, () => ({
      x: r() * W,
      y: r() * H,
      r: (0.35 + r() * 1.15) * (W > 1800 ? 1.5 : 1),
      tw: 0.6 + r() * 1.8,
      ph: r() * 6.28,
      a: 0.35 + r() * 0.65,
      drift: 2 + r() * 7,
      tint: r() < 0.18 ? 'rgba(170,200,255,' : r() < 0.12 ? 'rgba(255,200,230,' : 'rgba(255,255,255,',
    }));

    buildPost();
  }

  /** Dark vignette plus soft scrims behind the HUD at the top and bottom. */
  function buildPost() {
    post.width = canvas.width;
    post.height = canvas.height;
    const p = post.getContext('2d');
    p.setTransform(dpr, 0, 0, dpr, 0, 0);

    const v = p.createRadialGradient(W / 2, H * 0.45, vmin * 0.35, W / 2, H * 0.45, Math.hypot(W, H) * 0.62);
    v.addColorStop(0, 'rgba(8,0,24,0)');
    v.addColorStop(1, 'rgba(8,0,24,0.7)');
    p.fillStyle = v;
    p.fillRect(0, 0, W, H);

    const portrait = H > W;
    const s = p.createLinearGradient(0, H * (portrait ? 0.45 : 0.5), 0, H);
    s.addColorStop(0, 'rgba(10,2,34,0)');
    s.addColorStop(0.6, 'rgba(10,2,34,0.6)');
    s.addColorStop(1, 'rgba(8,1,26,0.9)');
    p.fillStyle = s;
    p.fillRect(0, 0, W, H);

    const t = p.createLinearGradient(0, 0, 0, H * 0.2);
    t.addColorStop(0, 'rgba(10,2,34,0.5)');
    t.addColorStop(1, 'rgba(10,2,34,0)');
    p.fillStyle = t;
    p.fillRect(0, 0, W, H * 0.2);
  }

  /* ---------- Floating shards (like the debris in the artwork) ---------- */

  const shardRand = rng(2024);
  const darkShards = Array.from({ length: 64 }, () => ({
    u: shardRand(), v: shardRand(), d: 0.25 + shardRand() * 0.75,
    r0: shardRand() * TAU, rs: (shardRand() - 0.5) * 1.6, ph: shardRand() * TAU, sw: 0.3 + shardRand() * 0.6,
  }));
  const sparks = Array.from({ length: 100 }, () => ({
    u: shardRand(), v: shardRand(), d: 0.2 + shardRand() * 0.8,
    r0: shardRand() * TAU, rs: (shardRand() - 0.5) * 2.4, ph: shardRand() * TAU, sw: 0.4 + shardRand() * 0.8,
    tw: 1.2 + shardRand() * 2.5, pink: shardRand() < 0.35,
  }));

  function rhombus(size, flip) {
    g.beginPath();
    g.moveTo(0, -size);
    g.lineTo(size * 0.55 * flip, 0);
    g.lineTo(0, size);
    g.lineTo(-size * 0.55 * flip, 0);
    g.closePath();
  }

  function drawShards(t, a) {
    if (a <= 0.01) return;
    const mg = vmin * 0.08;
    const bw = W + 2 * mg;
    const bh = H + 2 * mg;
    const step = lite ? 2 : 1;

    // dark tumbling debris
    for (let i = 0; i < darkShards.length; i += step) {
      const p = darkShards[i];
      const x = ((((p.u * bw - t * vmin * 0.014 * p.d + Math.sin(t * p.sw + p.ph) * vmin * 0.02 * p.d) % bw) + bw) % bw) - mg;
      const y = (((p.v * bh + t * vmin * 0.05 * p.d) % bh) + bh) % bh - mg;
      const size = vmin * (0.011 + 0.034 * p.d * p.d);
      const rot = p.r0 + t * p.rs;
      g.save();
      g.translate(x, y);
      g.rotate(rot * 0.35);
      g.fillStyle = `rgba(28,4,56,${((0.22 + 0.4 * p.d) * a).toFixed(3)})`;
      rhombus(size, 0.3 + 0.7 * Math.abs(Math.cos(rot * 0.9 + p.ph)));
      g.fill();
      g.restore();
    }

    // bright sparkles
    g.save();
    g.globalCompositeOperation = 'lighter';
    for (let i = 0; i < sparks.length; i += step) {
      const p = sparks[i];
      const tw = Math.max(0, Math.sin(t * p.tw + p.ph));
      if (tw < 0.05) continue;
      const x = ((((p.u * bw + t * vmin * 0.008 * p.d + Math.sin(t * p.sw + p.ph) * vmin * 0.025) % bw) + bw) % bw) - mg;
      const y = (((p.v * bh + t * vmin * 0.034 * p.d) % bh) + bh) % bh - mg;
      const size = vmin * (0.0035 + 0.007 * p.d);
      g.save();
      g.translate(x, y);
      g.rotate(p.r0 + t * p.rs * 0.4);
      g.fillStyle = (p.pink ? 'rgba(255,120,220,' : 'rgba(120,255,240,') + (tw * 0.75 * a).toFixed(3) + ')';
      rhombus(size, 0.45 + 0.55 * Math.abs(Math.cos(p.r0 + t * p.rs)));
      g.fill();
      g.restore();
    }
    g.restore();
  }

  /* ---------- Camera, glitch and the rest of the scene ---------- */

  function camera(t, fl) {
    const cover = Math.max(W / IW, H / IH);
    const settle = easeOutCubic(clamp(t / 2.8, 0, 1));
    let zoom = 1.3 - 0.22 * settle + 0.012 * Math.max(0, t - 2.8); // 1.30 → 1.08, then a slow creep
    if (fl >= 0) zoom *= 1 + 0.09 * Math.min(1, fl * 12) * Math.exp(-fl * 2.6); // punch at the flare
    const s = cover * zoom;
    const dw = IW * s;
    const dh = IH * s;

    const gl = glitchAt(t, fl);
    const frameN = Math.floor(t * 30);
    const shakeX = gl > 0 ? (hash(frameN * 3.1) - 0.5) * gl * W * 0.012 : 0;
    const shakeY = gl > 0 ? (hash(frameN * 5.7) - 0.5) * gl * H * 0.012 : 0;
    const dx = Math.sin(t * 0.37) * W * 0.012 + shakeX;
    const dy = Math.cos(t * 0.29) * H * 0.008 + shakeY;

    // keep the head a little above centre so the HUD has room underneath
    const tx = W * 0.5 + dx;
    const ty = H * (H > W ? 0.4 : 0.42) + dy;
    const ox = clamp(tx - FOCAL.x * dw, W - dw, 0);
    const oy = clamp(ty - FOCAL.y * dh, H - dh, 0);
    return { s, dw, dh, ox, oy };
  }

  const bump = (t, a, b, strength) => (t > a && t < b ? Math.sin((Math.PI * (t - a)) / (b - a)) * strength : 0);

  /** 0..1 intensity of the glitch cut at a given moment. */
  function glitchAt(t, fl) {
    if (reduced) return 0;
    let v = bump(t, 0.6, 0.9, 0.9) + bump(t, 2.3, 2.42, 0.45) + bump(t, 3.9, 4.02, 0.4);
    if (fl >= 0) v += bump(fl, 0, 0.4, 1);
    return Math.min(1, v);
  }

  const toScreen = (cam, nx, ny) => [cam.ox + nx * cam.dw, cam.oy + ny * cam.dh];

  function glow(x, y, r, rgb, a) {
    if (a <= 0.004) return;
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, `rgba(${rgb},${a.toFixed(3)})`);
    gr.addColorStop(1, `rgba(${rgb},0)`);
    g.fillStyle = gr;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }

  /** Horizontal strips of the picture, split into red / green / blue and thrown sideways. */
  function drawSplit(cam, gl, t, alpha) {
    const strips = 9;
    const sh = IH / strips;
    const split = gl * W * 0.012;
    const frameN = Math.floor(t * 24);
    g.save();
    g.fillStyle = `rgba(5,1,12,${alpha.toFixed(3)})`;
    g.fillRect(0, 0, W, H);
    g.globalCompositeOperation = 'lighter';
    g.globalAlpha = alpha;
    for (let c = 0; c < 3; c++) {
      for (let j = 0; j < strips; j++) {
        const r = hash(frameN * 13 + j * 7.1);
        const slice = (r - 0.5) * gl * W * 0.05 * (r > 0.62 ? 1 : 0.15);
        g.drawImage(
          chan[c],
          0, j * sh * CS, IW * CS, sh * CS,
          cam.ox + slice + (c - 1) * split, cam.oy + j * sh * cam.s, cam.dw, sh * cam.s + 0.6
        );
      }
    }
    g.restore();
  }

  function drawSweep(t) {
    const period = 3.4;
    const k = (t - 1.2) / period;
    if (k < 0) return;
    const ph = (k % 1) * period / 1.15; // the band takes 1.15 s to cross, then rests
    if (ph > 1) return;
    const x = -0.3 * W + ph * 1.6 * W;
    const bw = W * 0.2;
    g.save();
    g.globalCompositeOperation = 'lighter';
    g.translate(x, H / 2);
    g.rotate(0.35);
    const gr = g.createLinearGradient(-bw, 0, bw, 0);
    gr.addColorStop(0, 'rgba(255,190,255,0)');
    gr.addColorStop(0.5, 'rgba(255,225,255,0.17)');
    gr.addColorStop(1, 'rgba(255,190,255,0)');
    g.fillStyle = gr;
    g.fillRect(-bw, -H, bw * 2, H * 2);
    g.restore();
  }

  function drawFlare(cam, fl) {
    const [cx, cy] = toScreen(cam, FOCAL.x, FOCAL.y);
    const reach = Math.hypot(W, H);
    g.save();
    g.globalCompositeOperation = 'lighter';

    glow(cx, cy, vmin * (0.14 + fl * 0.55), '255,235,255', 0.9 * Math.exp(-fl * 3));
    glow(cx, cy, vmin * (0.3 + fl * 0.8), '255,90,220', 0.45 * Math.exp(-fl * 2.4));

    for (let i = 0; i < 2; i++) {
      const f = fl - i * 0.12;
      if (f <= 0) continue;
      g.strokeStyle = `rgba(${i ? '255,150,240' : '170,255,245'},${(0.75 * Math.exp(-f * 2.2)).toFixed(3)})`;
      g.lineWidth = vmin * 0.022 * Math.exp(-f * 2.4) + 2;
      g.beginPath();
      g.arc(cx, cy, f * reach * 0.7, 0, TAU);
      g.stroke();
    }

    g.fillStyle = `rgba(255,255,255,${(0.5 * Math.exp(-fl * 10)).toFixed(3)})`;
    g.fillRect(0, 0, W, H);
    g.restore();
  }

  /**
   * One frame of the loading scene.
   *   t    seconds since the loading screen began
   *   fl   seconds since the flare started (-1 before it)
   *   prog loading progress 0..1 (the snake's eyes burn brighter as it rises)
   */
  function drawScene(t, fl, prog) {
    const b = smooth(0, 0.9, t); // fade up from black
    const cam = camera(t, fl);
    const gl = glitchAt(t, fl);

    if (artOK) {
      const focus = smooth(0.1, 1.5, t); // blurred → sharp
      g.globalAlpha = b;
      g.drawImage(blurLayer, cam.ox, cam.oy, cam.dw, cam.dh);
      g.globalAlpha = b * focus;
      g.drawImage(art, cam.ox, cam.oy, cam.dw, cam.dh);
      g.globalAlpha = 1;
      if (gl > 0.03) drawSplit(cam, gl, t, b);
    } else {
      const fb = g.createLinearGradient(0, 0, W * 0.4, H);
      fb.addColorStop(0, '#ff1fd0');
      fb.addColorStop(1, '#4a1aa8');
      g.globalAlpha = b;
      g.fillStyle = fb;
      g.fillRect(0, 0, W, H);
      g.globalAlpha = 1;
    }

    g.save();
    g.globalCompositeOperation = 'lighter';

    // the eyes burn brighter as loading progresses
    const pulse = 0.72 + 0.28 * Math.sin(t * 3.2);
    const eyeA = (0.3 + 0.55 * prog) * pulse * b;
    for (const e of EYES) {
      const [x, y] = toScreen(cam, e.x, e.y);
      glow(x, y, cam.dw * 0.05, '255,205,60', eyeA * 0.55);
      glow(x, y, cam.dw * 0.017, '255,240,170', eyeA);
    }

    // the tongue flickers
    const flick = Math.max(0, Math.sin(t * 2.1) * Math.sin(t * 5.3));
    const [tx, ty] = toScreen(cam, TONGUE.x, TONGUE.y);
    glow(tx, ty, cam.dw * 0.045, '255,90,40', 0.35 * flick * b);

    g.restore();

    if (!reduced) drawSweep(t);
    drawShards(t, smooth(0.5, 1.6, t));

    // vignette + HUD scrims
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = b;
    g.drawImage(post, 0, 0);
    g.restore();

    if (fl >= 0) drawFlare(cam, fl);
  }

  /* ---------- Splash stars ---------- */

  function drawStars(t, alpha) {
    if (alpha <= 0) return;
    for (const s of stars) {
      const tw = 0.55 + 0.45 * Math.sin(t * s.tw + s.ph);
      const x = (s.x + t * s.drift) % W;
      g.fillStyle = `${s.tint}${(s.a * tw * alpha).toFixed(3)})`;
      g.beginPath();
      g.arc(x, s.y, s.r, 0, TAU);
      g.fill();
    }
  }

  /* ---------- Timeline ---------- */

  const t0 = EXPORT ? 0 : performance.now();
  let last = t0;
  let stage = 'mk';
  let loadStart = 0;
  let outStart = 0;
  let stageAt = 0; // when the current stage began (used to drive CSS animations when exporting)
  let doneAt = 0;
  let tipIndex = 0;
  let tipTimer = 0;
  let shown = 0; // displayed progress 0..1
  let raf = 0;

  // Adaptive quality: if the loading screen can't hold ~40 fps (weak phone, no GPU), it renders at 1×
  // pixel density with half the shards and drops the soft glows — see `[data-quality="lite"]` in style.css.
  let perfStart = 0;
  let perfFrames = 0;
  let perfDone = EXPORT;

  function checkPerformance(now, sinceLoad) {
    if (perfDone || sinceLoad < 900) return; // let the entrance animation and image decode settle first
    if (!perfStart) { perfStart = now; perfFrames = 0; return; }
    perfFrames++;
    const span = now - perfStart;
    if (span < 900) return;
    perfDone = true;
    if (perfFrames / (span / 1000) < 40) {
      lite = true;
      intro.dataset.quality = 'lite';
      resize();
    }
  }

  function setStage(next, now) {
    stage = next;
    stageAt = now;
    intro.dataset.stage = next;
  }

  /** Time-based progress with a few natural "slow" moments; never ahead of the real assets. */
  function targetProgress(elapsed) {
    const x = Math.min(1, elapsed / LOAD_MS);
    let p = x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
    p += 0.035 * Math.sin(x * Math.PI * 4) * (1 - x);
    p = Math.max(0, Math.min(1, p));
    return assetsReady ? p : Math.min(p, 0.9);
  }

  function setProgress(p) {
    const pct = Math.round(p * 100);
    trackEl.style.setProperty('--p', p.toFixed(4));
    if (pctEl.textContent !== String(pct)) {
      pctEl.textContent = pct;
      barEl.setAttribute('aria-valuenow', String(pct));
      let label = STATUS[0][1];
      for (const [from, text] of STATUS) if (pct >= from) label = text;
      statusEl.textContent = label;
    }
  }

  function showTip(i) {
    const apply = () => {
      tipEl.textContent = TIPS[i];
      tipNoEl.textContent = String(i + 1).padStart(2, '0');
      tipEl.style.opacity = '1';
      tipEl.style.transform = 'none';
    };
    if (EXPORT) { apply(); return; }
    tipEl.style.opacity = '0';
    tipEl.style.transform = 'translateY(0.3em)';
    setTimeout(apply, 350);
  }

  function finish() {
    cancelAnimationFrame(raf);
    window.removeEventListener('resize', resize);
    intro.remove();
    document.body.classList.remove('intro-active');
    window.dispatchEvent(new Event('resize')); // let the game re-measure its board
  }

  /** Export only: pin every CSS animation / transition to the virtual clock. */
  function syncAnimations(now) {
    for (const a of document.getAnimations()) {
      const target = a.effect && a.effect.target;
      const inSplash = target && target.closest && target.closest('.intro-mk');
      const base = inSplash ? 0 : a instanceof CSSTransition ? stageAt : loadStart;
      a.pause();
      a.currentTime = Math.max(0, now - base);
    }
  }

  function frame(now) {
    if (!EXPORT) raf = requestAnimationFrame(frame);
    const dt = EXPORT ? 1 / 30 : Math.min(0.05, (now - last) / 1000);
    last = now;
    const t = (now - t0) / 1000;

    if (stage === 'mk' && now - t0 >= MK_MS) {
      const at = EXPORT ? t0 + MK_MS : now; // exact moments when rendering video, so frames never depend on step size
      setStage('load', at);
      loadStart = at;
      tipTimer = at;
    }

    let sceneT = -1;
    let fl = -1;
    if (stage === 'load' || stage === 'out') {
      const el = now - loadStart;
      sceneT = reduced ? 3.2 : el / 1000;

      if (stage === 'load') {
        if (!reduced) checkPerformance(now, el);

        const target = targetProgress(el);
        shown = EXPORT ? target : Math.max(shown, Math.min(target, shown + dt * 0.9)); // smooth, monotonic
        if (target >= 1 && shown >= 0.999) {
          shown = 1;
          if (!doneAt) doneAt = EXPORT ? loadStart + LOAD_MS : now;
        }
        setProgress(shown);

        if (!reduced && now - tipTimer > 1500) {
          tipTimer = now;
          tipIndex = (tipIndex + 1) % TIPS.length;
          showTip(tipIndex);
        }

        if (doneAt && now - doneAt >= HOLD_MS) {
          const at = EXPORT ? doneAt + HOLD_MS : now;
          setStage('out', at);
          outStart = at;
          if (!EXPORT) setTimeout(finish, OUT_MS + 80);
        }
      }
      if (doneAt && !reduced) fl = (now - doneAt) / 1000;
    }

    // draw
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, canvas.width, canvas.height);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);

    // splash night sky, fading out as the loading scene fades in
    const sceneA = sceneT < 0 ? 0 : smooth(0, 0.9, sceneT);
    drawStars(t, (stage === 'mk' ? Math.min(1, t / 1.2) : 1 - sceneA) * 0.75);

    if (sceneT >= 0) drawScene(sceneT, fl, shown);
    if (EXPORT) syncAnimations(now);
  }

  resize();
  window.addEventListener('resize', resize);

  if (EXPORT) {
    // video export: no real-time loop; the caller steps the clock
    window.__intro = {
      ready: ready.then(() => { assetsReady = true; }),
      seek: (ms) => frame(ms),
      timing: { MK_MS, LOAD_MS, HOLD_MS, OUT_MS },
    };
  } else {
    raf = requestAnimationFrame(frame);
  }
})();
