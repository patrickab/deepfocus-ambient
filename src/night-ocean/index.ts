/**
 * The night ocean scene: a dark sea under a hazy, starry sky, a moon hidden in the haze.
 *
 * - `startNightOcean` draws it on a canvas, from a baked video of the sea when one loads, else live
 * - `bakeNightOcean` draws single frames of the sea alone, for the video (`scripts/render.mjs`)
 */
import { LOOP, LOOP_SECONDS, SEA_SPEED } from "./loop"
import { BAKE_HORIZON, BAKE_MARGIN, BAKE_MOON_ABOVE, FOCAL, seaFragment, VERTEX, VIDEO_FRAGMENT } from "./shaders"

/** What a frame is drawn from, read anew each frame. */
export interface NightOceanFrame {
  /** Horizon height as a share of the canvas height, 0 at the bottom. */
  horizon: number
  /** The hidden moon, the middle of its glow, as shares of the canvas from its bottom left. A video follows it sideways only. */
  moon: [number, number]
  /** The page color and the color of everything lit, sRGB 0..1. */
  paper: [number, number, number]
  light: [number, number, number]
  /** A still sea: one frame, redrawn only when the canvas, the scene's place or a color changes. */
  still: boolean
}

export interface NightOceanOptions {
  frame: () => NightOceanFrame
  /** Fires once the canvas holds a picture, again after a lost graphics context came back. */
  onFirstFrame?: () => void
  /** Fires when the browser takes the graphics context away: the canvas is blank until `onFirstFrame`. */
  onLost?: () => void
  /** A video baked by `scripts/render.mjs`. Without one, or when it fails to load, the sea is computed live. */
  videoUrl?: string
}

/** Canvas pixels per CSS pixel, before the device pixel ratio (capped at 2). The upscale is what softens the sea. */
const RESOLUTION_SCALE = 0.75
const FRAME_INTERVAL_MS = 1000 / 30
const HAZE = 0.2
const MOON = 0.65
const GRAIN = 0.03
/** Grain patterns per second, like film. */
const GRAIN_FPS = 24
const STARS = 0.8
/** A video that has no picture by then is given up for the live sea. */
const VIDEO_WAIT_MS = 5000

type Uniforms = Record<string, WebGLUniformLocation | null>

function link(gl: WebGL2RenderingContext, fragment: string, names: string[]): { program: WebGLProgram; uniforms: Uniforms } {
  const program = gl.createProgram()
  for (const [type, source] of [[gl.VERTEX_SHADER, VERTEX], [gl.FRAGMENT_SHADER, fragment]] as const) {
    const shader = gl.createShader(type)
    if (!shader) throw new Error("WebGL shader allocation failed")
    gl.shaderSource(shader, source)
    gl.compileShader(shader)
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? "WebGL shader compile failed")
    gl.attachShader(program, shader)
  }
  gl.bindAttribLocation(program, 0, "aPos")
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? "WebGL program link failed")
  return { program, uniforms: Object.fromEntries(names.map((name) => [name, gl.getUniformLocation(program, name)])) }
}

function context(canvas: HTMLCanvasElement | OffscreenCanvas, preserveDrawingBuffer = false): WebGL2RenderingContext | null {
  const gl = canvas.getContext("webgl2", { antialias: false, alpha: false, powerPreference: "high-performance", preserveDrawingBuffer }) as WebGL2RenderingContext | null
  if (gl) coverCanvas(gl)
  return gl
}

/** The one triangle every program draws, covering the canvas. */
function coverCanvas(gl: WebGL2RenderingContext) {
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer())
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
  gl.enableVertexAttribArray(0)
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
}

const SEA_UNIFORMS = ["uRes", "uHorizon", "uMoonAt", "uTime", "uFocal", "uMist", "uMoon"]
const FINISH_UNIFORMS = ["uPaper", "uLight", "uClock", "uDay", "uGrain", "uGrainFrame", "uStars", "uPx"]

const luma = (color: readonly number[]) => 0.2126 * (color[0] ?? 0) + 0.7152 * (color[1] ?? 0) + 0.0722 * (color[2] ?? 0)
/** A page paler than the light color gets the scene by day. */
const isDay = (paper: readonly number[], light: readonly number[]) => (luma(light) < luma(paper) ? 1 : 0)

function selectSea(gl: WebGL2RenderingContext, sea: { program: WebGLProgram; uniforms: Uniforms }) {
  gl.useProgram(sea.program)
  gl.uniform1f(sea.uniforms.uMist ?? null, HAZE)
  gl.uniform1f(sea.uniforms.uMoon ?? null, MOON)
}

/** A looping, muted video that resolves to whether it got a picture in time. */
function loadVideo(url: string): { video: HTMLVideoElement; ready: Promise<boolean> } {
  const video = document.createElement("video")
  video.muted = true
  video.loop = true
  video.playsInline = true
  video.preload = "auto"
  const ready = new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => resolve(false), VIDEO_WAIT_MS)
    const settle = (ok: boolean) => {
      clearTimeout(timeout)
      resolve(ok)
    }
    video.addEventListener("loadeddata", () => settle(true), { once: true })
    video.addEventListener("error", () => settle(false), { once: true })
  })
  video.src = url
  return { video, ready }
}

/**
 * Animate the night ocean on `canvas` until the returned stop is called. Null without WebGL2.
 *
 * - With `videoUrl` the sea comes from that video once it has a picture, stars and grain are drawn over it. It falls back to the live sea
 * - Draws nothing while the canvas has no size (a hidden tab)
 * - A graphics context the browser took away (GPU reset, too many contexts) is rebuilt when it comes back
 */
export function startNightOcean(canvas: HTMLCanvasElement, { frame, onFirstFrame, onLost, videoUrl }: NightOceanOptions): (() => void) | null {
  const gl = context(canvas)
  if (!gl) return null

  let request = 0
  let isStopped = false
  let video: HTMLVideoElement | null = null
  /** Whether the sea comes from the video, null until that is known. */
  let source: boolean | null = null

  const run = (fromVideo: boolean) => {
    source = fromVideo
    if (isStopped || gl.isContextLost()) return
    let stage: { program: WebGLProgram; uniforms: Uniforms }
    try {
      stage = fromVideo
        ? link(gl, VIDEO_FRAGMENT, ["uRes", "uHorizon", "uMoonAt", "uVideo", "uVideoAspect", ...FINISH_UNIFORMS])
        : link(gl, seaFragment(false), [...SEA_UNIFORMS, ...FINISH_UNIFORMS])
    } catch (error) {
      console.error(error)
      return
    }
    const u = stage.uniforms
    if (fromVideo && video) {
      gl.useProgram(stage.program)
      gl.bindTexture(gl.TEXTURE_2D, gl.createTexture())
      for (const [name, value] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]] as const) {
        gl.texParameteri(gl.TEXTURE_2D, name, value)
      }
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
      gl.uniform1i(u.uVideo ?? null, 0)
      gl.uniform1f(u.uVideoAspect ?? null, video.videoWidth / video.videoHeight)
    } else {
      selectSea(gl, stage)
      gl.uniform1f(u.uFocal ?? null, FOCAL)
    }
    gl.uniform1f(u.uGrain ?? null, GRAIN)
    gl.uniform1f(u.uStars ?? null, STARS)

    let lastDraw = 0
    let drawnStill = ""
    let videoTime = -1
    let hasFrame = false
    const draw = (now: number) => {
      request = requestAnimationFrame(draw)
      if (now - lastDraw < FRAME_INTERVAL_MS - 2) return
      const px = RESOLUTION_SCALE * Math.min(window.devicePixelRatio || 1, 2)
      const width = Math.round(canvas.clientWidth * px)
      const height = Math.round(canvas.clientHeight * px)
      if (width === 0 || height === 0) return
      const { horizon, moon, paper, light, still } = frame()
      if (video && video.paused !== still) {
        if (still) video.pause()
        else void video.play().catch(() => {})
      }
      const stillKey = still ? [width, height, horizon, ...moon, ...paper, ...light].join(" ") : ""
      if (still && stillKey === drawnStill) return
      drawnStill = stillKey
      lastDraw = now
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width
        canvas.height = height
      }
      gl.viewport(0, 0, width, height)
      if (video && video.currentTime !== videoTime && video.readyState >= 2) {
        videoTime = video.currentTime
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video)
      }
      const seconds = now / 1000
      gl.uniform2f(u.uRes ?? null, width, height)
      gl.uniform1f(u.uHorizon ?? null, horizon)
      gl.uniform2f(u.uMoonAt ?? null, moon[0], moon[1])
      gl.uniform1f(u.uTime ?? null, still ? 0 : (seconds * SEA_SPEED) % LOOP)
      gl.uniform1f(u.uClock ?? null, still ? 0 : seconds % 3600)
      gl.uniform1f(u.uGrainFrame ?? null, still ? 0 : Math.floor(seconds * GRAIN_FPS) % 4096)
      gl.uniform3fv(u.uPaper ?? null, paper)
      gl.uniform3fv(u.uLight ?? null, light)
      gl.uniform1f(u.uDay ?? null, isDay(paper, light))
      gl.uniform1f(u.uPx ?? null, px)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
      if (!hasFrame) {
        hasFrame = true
        onFirstFrame?.()
      }
    }
    request = requestAnimationFrame(draw)
  }

  if (videoUrl) {
    const loading = loadVideo(videoUrl)
    video = loading.video
    void loading.ready.then((ok) => {
      if (!ok) {
        loading.video.removeAttribute("src")
        loading.video.load()
        video = null
      }
      run(ok)
    })
  } else {
    run(false)
  }
  const handleLost = (event: Event) => {
    // Without this the browser never gives the context back
    event.preventDefault()
    cancelAnimationFrame(request)
    onLost?.()
  }
  const handleRestored = () => {
    coverCanvas(gl)
    if (source !== null) run(source)
  }
  canvas.addEventListener("webglcontextlost", handleLost)
  canvas.addEventListener("webglcontextrestored", handleRestored)
  return () => {
    isStopped = true
    cancelAnimationFrame(request)
    canvas.removeEventListener("webglcontextlost", handleLost)
    canvas.removeEventListener("webglcontextrestored", handleRestored)
    if (video) {
      video.pause()
      video.removeAttribute("src")
      video.load()
    }
  }
}

/** Frames per second and frame count of a baked loop. */
export const BAKE_FPS = 30
export const BAKE_FRAMES = LOOP_SECONDS * BAKE_FPS

/**
 * Draw frames of the sea alone on `canvas`, at its size: `(index)` draws frame `index` of the loop. Null without WebGL2.
 *
 * - Grayscale, the square root of the scene's light, framed with `BAKE_MARGIN` spare for `startNightOcean` to slide the video
 * - With `finished` it draws the finished picture in those colors, stars and grain included, framed like a window: a preview
 */
export function bakeNightOcean(canvas: HTMLCanvasElement | OffscreenCanvas, finished?: Pick<NightOceanFrame, "paper" | "light">): ((index: number) => void) | null {
  const gl = context(canvas, true)
  if (!gl) return null
  const sea = link(gl, seaFragment(!finished), finished ? [...SEA_UNIFORMS, ...FINISH_UNIFORMS] : SEA_UNIFORMS)
  selectSea(gl, sea)
  const u = sea.uniforms
  const horizon = finished ? 0.4 : BAKE_HORIZON
  gl.viewport(0, 0, canvas.width, canvas.height)
  gl.uniform2f(u.uRes ?? null, canvas.width, canvas.height)
  gl.uniform1f(u.uFocal ?? null, finished ? FOCAL : FOCAL / BAKE_MARGIN)
  gl.uniform1f(u.uHorizon ?? null, horizon)
  gl.uniform2f(u.uMoonAt ?? null, 0.5, horizon + BAKE_MOON_ABOVE / (finished ? 1 : BAKE_MARGIN))
  if (finished) {
    gl.uniform3fv(u.uPaper ?? null, finished.paper)
    gl.uniform3fv(u.uLight ?? null, finished.light)
    gl.uniform1f(u.uDay ?? null, isDay(finished.paper, finished.light))
    gl.uniform1f(u.uGrain ?? null, GRAIN)
    gl.uniform1f(u.uStars ?? null, STARS)
    gl.uniform1f(u.uPx ?? null, 1)
  }
  return (index) => {
    gl.uniform1f(u.uTime ?? null, ((index % BAKE_FRAMES) / BAKE_FRAMES) * LOOP)
    gl.uniform1f(u.uClock ?? null, index / BAKE_FPS)
    gl.uniform1f(u.uGrainFrame ?? null, index)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    gl.finish()
  }
}
