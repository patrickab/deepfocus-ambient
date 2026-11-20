# deepfocus-ambient

Calm animated scenes to work in front of. A scene fills a canvas behind an app and stays quiet enough to disappear while you focus.

Scenes:

- `night-ocean`: a dark sea in slow motion under a hazy, starry sky, a moon hidden in the haze, film grain on top

## Use

The package is TypeScript source without a build step: mount it as a git submodule and point a path alias at `src/index.ts`.

```ts
import { anchorScene, readSceneAnchor, startNightOcean } from "deepfocus-ambient"

const stop = startNightOcean(canvas, {
  videoUrl: "/ambient/night-ocean.webm", // optional
  frame: () => ({ horizon: 0.4, moon: [0.5, 0.48], paper: [0.04, 0.04, 0.035], light: [0.94, 0.93, 0.9], still: false }),
})
```

- `frame` is read each frame: where the horizon and the moon sit, the page color and the light color, and `still` for reduced motion
- `anchorScene` lets a piece of UI (an input box) say where the scene belongs, `readSceneAnchor` gives the app that place to pass on in `frame`
- With `videoUrl` the sea is played from a baked video and only stars and grain are computed, which costs a fraction of the GPU. Without it, or when it fails to load, the sea is computed live

## Preview

```sh
npm install
npm run preview        # http://127.0.0.1:8765/preview/
```

`?video=/out/night-ocean.webm` plays a baked video, `?bare` hides the stand-in input box.

## Bake a video

The sea repeats exactly every 60 seconds (`src/night-ocean/loop.ts`), so one loop is baked into a video that plays seamlessly.

```sh
cp .env.example .env   # SSH_GPU_HOST=user@host, optional
npm run render                      # out/night-ocean.webm
npm run render -- --frames 60       # the first two seconds, for a look
npm run render -- --release v0.1.0  # also upload it to that GitHub release
```

- With `SSH_GPU_HOST` the frames are drawn by a headless Chromium on that machine, through an SSH tunnel. Without it, or when the machine does not answer, they are drawn here
- The frames are encoded here with `ffmpeg` (AV1)
- The drawing machine needs a Chromium: Playwright's (`npx playwright install chromium`), one on `PATH`, or `CHROMIUM=<path>` in its environment
- Here: `ffmpeg` with `libsvtav1`, and `gh` for `--release`
- The video holds the scene's light alone, in grayscale. Colors, stars and grain are added at playback, so one video serves every theme

An app fetches the video of a release with `gh release download <tag> --repo <owner>/deepfocus-ambient --pattern night-ocean.webm`.

## Credits

The wave field follows afl_ext's "Very fast procedural ocean" (MIT License, 2017-2024).
