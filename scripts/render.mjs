#!/usr/bin/env node
// Bake a scene's loop into a video: frames are drawn by a headless Chromium on the GPU machine, encoded here.
//
//   npm run render -- [--height 1440] [--frames N] [--crf 30] [--release <tag>]
//
// - SSH_GPU_HOST (environment or .env) is the SSH target. It needs a Chromium: Playwright's, or CHROMIUM=<path> in its environment
// - Writes out/night-ocean.webm (AV1). --frames bakes only the first N frames, for a look
// - --release uploads the video to that GitHub release of this repository, creating it if needed (gh)
import { spawn, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs"
import { parseArgs } from "node:util"
import { build } from "esbuild"
import { chromium } from "playwright-core"

const SCENE = "night-ocean"
const PORT = 9377
const { values: options } = parseArgs({ options: { height: { type: "string", default: "1440" }, frames: { type: "string" }, crf: { type: "string", default: "30" }, release: { type: "string" } } })

function gpuHost() {
  if (process.env.SSH_GPU_HOST) return process.env.SSH_GPU_HOST
  const line = existsSync(".env") && readFileSync(".env", "utf8").split("\n").find((entry) => entry.startsWith("SSH_GPU_HOST="))
  const host = line ? line.slice("SSH_GPU_HOST=".length).trim() : ""
  if (!host) throw new Error("Set SSH_GPU_HOST (environment or .env) to the machine that renders")
  return host
}

const height = Number(options.height)
const width = Math.round((height * 16) / 9 / 2) * 2
const output = `out/${SCENE}.webm`
mkdirSync("out", { recursive: true })

const bundle = await build({ entryPoints: [`src/${SCENE}/bake-page.ts`], bundle: true, write: false, format: "iife" })

// The browser lives as long as the SSH session: its terminal closing takes it down
const browserCommand = `chrome=\${CHROMIUM:-$(ls -d ~/.cache/ms-playwright/chromium-*/chrome-linux*/chrome | tail -1)}; exec "$chrome" --headless=new --remote-debugging-port=${PORT} --user-data-dir=$(mktemp -d) --no-first-run --use-angle=vulkan --enable-features=Vulkan --ignore-gpu-blocklist about:blank`
const ssh = spawn("ssh", ["-tt", "-o", "ExitOnForwardFailure=yes", "-L", `${PORT}:127.0.0.1:${PORT}`, gpuHost(), browserCommand], { stdio: "ignore" })
let encoder
const cleanUp = () => {
  ssh.kill()
  encoder?.kill()
}
process.on("SIGINT", () => {
  cleanUp()
  process.exit(130)
})

try {
  let browser
  for (let attempt = 0; attempt < 60 && !browser; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`).catch(() => null)
  }
  if (!browser) throw new Error(`No Chromium answered on ${gpuHost()}`)
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
