#!/usr/bin/env node
// Bake a scene's loop into a video: frames are drawn by a headless Chromium, on the GPU machine when there is one, and encoded here.
//
//   npm run render -- [--height 1440] [--frames N] [--crf 30] [--release <tag>]
//
// - With SSH_GPU_HOST (environment or .env) the frames are drawn on that machine. Without it, or when it does not answer, here
// - Either machine needs a Chromium: Playwright's, one on PATH, or CHROMIUM=<path> in its environment
// - Writes out/night-ocean.webm (AV1). --frames bakes only the first N frames, for a look
// - --release uploads the video to that GitHub release of this repository, creating it if needed (gh)
import { spawn, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { build } from "esbuild"
import { chromium } from "playwright-core"

const SCENE = "night-ocean"
const PORT = 9377
const { values: options } = parseArgs({ options: { height: { type: "string", default: "1440" }, frames: { type: "string" }, crf: { type: "string", default: "30" }, release: { type: "string" } } })

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
  const bake = await page.evaluate(([w, h]) => globalThis.bake(w, h), [width, height])
  const frames = Math.min(bake.frames, Number(options.frames ?? bake.frames))
  console.log(`${SCENE}: ${frames} frames of ${width}x${height} on ${bake.gpu}`)
  if (/swiftshader|llvmpipe/i.test(bake.gpu)) console.warn("No GPU in the rendering browser, this will be slow")

  // The scene's light alone is smooth and dark: AV1 keeps it small, the film grain is added at playback
  encoder = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "image2pipe", "-framerate", String(bake.fps), "-c:v", "png", "-i", "-",
    "-c:v", "libsvtav1", "-preset", "5", "-crf", options.crf, "-g", String(bake.fps * 10), "-pix_fmt", "yuv420p", "-an", output], { stdio: ["pipe", "inherit", "inherit"], env: { ...process.env, SVT_LOG: "1" } })
  const encoded = new Promise((resolve, reject) => encoder.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with ${code}`)))))
  const started = Date.now()
  for (let index = 0; index < frames; index++) {
    const dataUrl = await page.evaluate((i) => globalThis.frame(i), index)
    const png = Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64")
    if (!encoder.stdin.write(png)) await new Promise((resolve) => encoder.stdin.once("drain", resolve))
    if ((index + 1) % 30 === 0 || index + 1 === frames) process.stdout.write(`\r${index + 1}/${frames} frames, ${((Date.now() - started) / 1000).toFixed(0)}s`)
  }
  encoder.stdin.end()
  await encoded
  await browser.close().catch(() => {})
  console.log(`\n${output}: ${(statSync(output).size / 1e6).toFixed(1)} MB`)
} finally {
  cleanUp()
}

if (options.release) {
  const exists = spawnSync("gh", ["release", "view", options.release], { stdio: "ignore" }).status === 0
  const upload = exists ? ["release", "upload", options.release, output, "--clobber"] : ["release", "create", options.release, output, "--title", options.release, "--notes", `Baked ${SCENE} loop.`]
  if (spawnSync("gh", upload, { stdio: "inherit" }).status !== 0) process.exit(1)
}
process.exit(0)
