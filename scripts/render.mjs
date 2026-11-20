#!/usr/bin/env node
// Bake a scene's loop into a video: frames are drawn by a headless Chromium, on the GPU machine when there is one, and encoded here.
//
//   npm run render -- [--height 1440] [--frames N] [--crf 30] [--preview-only] [--release <tag>]
//
// - With SSH_GPU_HOST (environment or .env) the frames are drawn on that machine. Without it, or when it does not answer, here
// - Either machine needs a Chromium: Playwright's, one on PATH, or CHROMIUM=<path> in its environment
// - Writes out/night-ocean.webm (AV1). --frames bakes only the first N frames, for a look
// - Writes out/night-ocean-preview.webp too, a few seconds of the finished picture for the README. --preview-only skips the video
// - --release uploads both to that GitHub release of this repository, creating it if needed (gh)
import { spawn, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { build } from "esbuild"
import { chromium } from "playwright-core"

const SCENE = "night-ocean"
const PORT = 9377
const { values: options } = parseArgs({ options: { height: { type: "string", default: "1440" }, frames: { type: "string" }, "preview-only": { type: "boolean" }, crf: { type: "string", default: "30" }, release: { type: "string" } } })

function gpuHost() {
  if (process.env.SSH_GPU_HOST !== undefined) return process.env.SSH_GPU_HOST
  const line = existsSync(".env") && readFileSync(".env", "utf8").split("\n").find((entry) => entry.startsWith("SSH_GPU_HOST="))
  return line ? line.slice("SSH_GPU_HOST=".length).trim() : ""
}

const REMOTE_CHROMIUM = '${CHROMIUM:-$(ls -d ~/.cache/ms-playwright/chromium-*/chrome-linux*/chrome | tail -1)}'

function localChromium() {
  if (process.env.CHROMIUM) return process.env.CHROMIUM
  const found = spawnSync("sh", ["-c", "ls -d ~/.cache/ms-playwright/chromium-*/chrome-linux*/chrome 2>/dev/null | tail -1; command -v chromium google-chrome-stable google-chrome chromium-browser"], { encoding: "utf8" })
  const path = found.stdout.split("\n").find(Boolean)
  if (!path) throw new Error("No Chromium here: install one or set CHROMIUM=<path>")
  return path
}

const browserFlags = (gpuFlags) => `--headless=new --remote-debugging-port=${PORT} --no-first-run --ignore-gpu-blocklist ${gpuFlags} about:blank`

/** A headless Chromium answering on PORT, started by `start`, or null when none answers within `seconds`. */
async function openBrowser(start, seconds) {
  const process_ = start()
  for (let attempt = 0; attempt < seconds * 2; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`).catch(() => null)
    if (browser) return { browser, process: process_ }
    if (process_.exitCode !== null) break
  }
  process_.kill()
  return null
}

// Over SSH the browser lives as long as the session: its terminal closing takes it down
const overSsh = (host) => () => spawn("ssh", ["-tt", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ExitOnForwardFailure=yes", "-L", `${PORT}:127.0.0.1:${PORT}`, host,
  `exec "${REMOTE_CHROMIUM}" --user-data-dir=$(mktemp -d) ${browserFlags("--use-angle=vulkan --enable-features=Vulkan")}`], { stdio: "ignore" })
const here = () => spawn(localChromium(), [`--user-data-dir=${mkdtempSync(join(tmpdir(), "deepfocus-ambient-"))}`, ...browserFlags("--use-gl=angle --use-angle=gl-egl").split(" ").filter(Boolean)], { stdio: "ignore" })

const height = Number(options.height)
const width = Math.round((height * 16) / 9 / 2) * 2
const output = `out/${SCENE}.webm`
const preview = `out/${SCENE}-preview.webp`
const PREVIEW_SECONDS = 8
mkdirSync("out", { recursive: true })

const bundle = await build({ entryPoints: [`src/${SCENE}/bake-page.ts`], bundle: true, write: false, format: "iife" })

let rendering
let encoder
const cleanUp = () => {
  rendering?.process.kill()
  encoder?.kill()
}
process.on("SIGINT", () => {
  cleanUp()
  process.exit(130)
})

try {
  const host = gpuHost()
  if (host) {
    rendering = await openBrowser(overSsh(host), 30)
    if (!rendering) console.warn(`No Chromium answered on ${host}, rendering here`)
  }
  rendering ??= await openBrowser(here, 30)
  if (!rendering) throw new Error("No Chromium started here either")
  const { browser } = rendering
  const page = await browser.contexts()[0].newPage()
  await page.addScriptTag({ content: bundle.outputFiles[0].text })

  /** Pipe frames `indexes` of a bake at `size` through ffmpeg into `file`. */
  const encode = async (file, size, preview, pick, codec) => {
    const bake = await page.evaluate(([w, h, p]) => globalThis.bake(w, h, p), [...size, preview])
    const indexes = pick(bake)
    console.log(`${file}: ${indexes.length} frames of ${size.join("x")} on ${bake.gpu}`)
    if (/swiftshader|llvmpipe/i.test(bake.gpu)) console.warn("No GPU in the rendering browser, this will be slow")
    const rate = String((bake.fps * indexes.length) / (indexes.at(-1) - indexes[0] + indexes[1] - indexes[0]))
    encoder = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "image2pipe", "-framerate", rate, "-c:v", "png", "-i", "-", ...codec(bake), "-an", file],
      { stdio: ["pipe", "inherit", "inherit"], env: { ...process.env, SVT_LOG: "1" } })
    const encoded = new Promise((resolve, reject) => encoder.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with ${code}`)))))
    const started = Date.now()
    for (const [done, index] of indexes.entries()) {
      const dataUrl = await page.evaluate((i) => globalThis.frame(i), index)
      const png = Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64")
      if (!encoder.stdin.write(png)) await new Promise((resolve) => encoder.stdin.once("drain", resolve))
      if ((done + 1) % 30 === 0 || done + 1 === indexes.length) process.stdout.write(`\r${done + 1}/${indexes.length} frames, ${((Date.now() - started) / 1000).toFixed(0)}s`)
    }
    encoder.stdin.end()
    await encoded
    console.log(`\n${file}: ${(statSync(file).size / 1e6).toFixed(1)} MB`)
  }
  const range = (count, step = 1) => Array.from({ length: Math.ceil(count / step) }, (_, i) => i * step)

  // The scene's light alone is smooth and dark: AV1 keeps it small, the film grain is added at playback
  if (!options["preview-only"]) {
    await encode(output, [width, height], false, (bake) => range(Math.min(bake.frames, Number(options.frames ?? bake.frames))),
      (bake) => ["-c:v", "libsvtav1", "-preset", "5", "-crf", options.crf, "-g", String(bake.fps * 10), "-pix_fmt", "yuv420p"])
  }
  // The finished picture, a few seconds of it, for the README
  await encode(preview, [960, 540], true, (bake) => range(bake.fps * PREVIEW_SECONDS, 2), () => ["-c:v", "libwebp_anim", "-loop", "0", "-q:v", "75", "-compression_level", "6"])
  await browser.close().catch(() => {})
} finally {
  cleanUp()
}

if (options.release) {
  const exists = spawnSync("gh", ["release", "view", options.release], { stdio: "ignore" }).status === 0
  const files = options["preview-only"] ? [preview] : [output, preview]
  const upload = exists ? ["release", "upload", options.release, ...files, "--clobber"] : ["release", "create", options.release, ...files, "--title", options.release, "--notes", `Baked ${SCENE} loop.`]
  if (spawnSync("gh", upload, { stdio: "inherit" }).status !== 0) process.exit(1)
}
process.exit(0)
