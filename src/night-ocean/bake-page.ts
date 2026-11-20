// Runs in the rendering browser (`scripts/render.mjs`): `bake(width, height, preview)` then `frame(index)`, which returns the frame as a PNG data URL.
import { BAKE_FPS, BAKE_FRAMES, bakeNightOcean } from "./index"

let canvas: HTMLCanvasElement | null = null
let draw: ((index: number) => void) | null = null

Object.assign(globalThis, {
  /** `preview` draws the finished picture in a dark theme's colors, else the sea alone for the video. */
  bake(width: number, height: number, preview: boolean) {
    canvas = document.createElement("canvas")
    canvas.width = width
    canvas.height = height
    draw = bakeNightOcean(canvas, preview ? { paper: [11 / 255, 10 / 255, 9 / 255], light: [239 / 255, 236 / 255, 231 / 255] } : undefined)
    if (!draw) throw new Error("No WebGL2 in the rendering browser")
    const gl = canvas.getContext("webgl2")
    const info = gl?.getExtension("WEBGL_debug_renderer_info")
    return { frames: BAKE_FRAMES, fps: BAKE_FPS, gpu: String(info ? gl?.getParameter(info.UNMASKED_RENDERER_WEBGL) : "unknown") }
  },
  frame(index: number) {
    draw?.(index)
    return canvas?.toDataURL("image/png") ?? ""
  },
})
