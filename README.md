# ¹²ßñàké

A snake game with a realistic, scaled blue-striped coral snake, level progression, a life system, poison borders, rival snakes on hard levels, and a 4K-ready UI.

## Intro

On every launch the game plays an automatic intro: a black space screen with a silver **MKLOFT** that fades in and out (3 s) → a cinematic loading screen built on the neon snake key art (`assets/intro-art.jpg`) → the main game.

The loading screen (≈ 4–5 s) is painted live on a canvas, so it stays sharp on any screen:

* a focus-pull reveal and a slow camera push toward the snake's head,
* quick glitch cuts (RGB colour split + sliced strips), a light sweep, and tumbling dark and glowing shards like the debris in the artwork,
* the snake's eyes burn brighter as loading progresses, and its tongue flickers,
* at 100 % a white-hot flare and shockwave rings fire, then everything fades into the game,
* a HUD along the bottom: logo with a spinning gradient rim, the title with a colour-split reveal, a rotating tip pill, and a segmented progress bar with a glowing head and a big 0–100 % counter.

The progress bar waits for the fonts, logo and artwork to really load. It adapts to the device: if the loading screen can't hold about 40 fps it switches to a lighter version (1× pixel density, fewer shards, no soft glows). `prefers-reduced-motion` gets a still version. The HUD switches between landscape and portrait layouts.

**Changing the artwork:** replace `assets/intro-art.jpg` with any 4:3 picture (a larger, sharper original gives a sharper loading screen). If the head is not in the middle, adjust `FOCAL`, `EYES` and `TONGUE` at the top of the art section in `intro.js` (they are fractions of the picture's width / height).

**Rendering the intro as a video:** the scene is a pure function of time. Serve the folder, open `index.html?export=1` in a 3840×2160 browser window and call `window.__intro.seek(milliseconds)` for each frame (screenshot each one, then encode with ffmpeg). Add `&art=path/to/bigger-image.png` to use a different image for the render.

Code: `intro.js` (+ the "Stage 2: cinematic loading screen" section at the end of `style.css`). Easy tweaks are the constants at the top of `intro.js` (`MK_MS`, `LOAD_MS`, status lines, tips).

## Rules

* Eat the pills to reach the level target (it doubles every level).
* **Lose a life** → the snake respawns, but your **score, your progress toward the level target and the snake's length are kept** (e.g. 5/16 stays 5/16, and the snake stays 8 segments long). The snake never shrinks.
* **Lose all 5 lives** → game over. The whole game resets: level 1, score 0, target progress 0, a fresh 3-segment snake, full lives. (Your best score is remembered.)
* Clearing a level refills your lives.
* Every 5th level is a hard level with rival snakes.

## Run locally

Open the `index.html` file in a browser, or serve the folder with a simple local web server.

Example:

```bash
python -m http.server 8000
```

Then open:

```text
http://localhost:8000
```

## Deploy to GitHub Pages

1. Push this folder to a GitHub repository.
2. Go to the repository settings.
3. Open **Pages**.
4. Set **Source** to **Deploy from a branch**.
5. Select the branch, usually `main`.
6. Choose the folder `/root`.
7. Save.
8. GitHub will give you a live URL like:

```text
https://your-username.github.io/your-repository-name/
```

## Controls

There are no on-screen buttons or joysticks — the whole screen is the play surface.

| Device | Steer | Pause |
| --- | --- | --- |
| PC / laptop | Arrow keys or `W` `A` `S` `D` | `Space`, `P` or `Esc` |
| Phone / tablet | Swipe anywhere on the screen (you can chain turns without lifting your finger) | Pause button |

The game starts on a **Play** screen, counts down 3-2-1 after you press Play or Resume, and pauses automatically when you switch tabs or open the account dialog.

## Responsive layout

* **Portrait** (phones, tablets held upright): top bar → stats → board.
* **Landscape** (laptops, desktops, tablets and phones on their side): board on the left, stats / status / help panel on the right.
* The board is always the largest square that fits.
* **4K:** all sizes are in `rem` and the root size follows the screen (16 px up to 1080p, 32 px at 2160p), so type, buttons and cards scale with the display. The canvas renders in real device pixels up to 4096 px, with whole pixels per grid cell, and the snake is interpolated every display frame for smooth motion at 60 Hz and above.

## Files

* `index.html`, `style.css`, `game.js` — the game (no build step, no external requests; open `index.html` directly).
* `intro.js` — the MKLOFT splash and the loading screen.
* `assets/` — logo (`logo-original.jpg` is the source image), favicons and app icons. `manifest.webmanifest` makes it installable.
* `fonts/` — Space Grotesk (SIL Open Font License), bundled so the game works offline.
* `progressStorage.js`, `save-progress.test.js`, `masai.py` — untouched helpers from the original project.
