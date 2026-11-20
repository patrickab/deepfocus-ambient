// Runs in the rendering browser (`scripts/render.mjs`): `bake(width, height)` then `frame(index)`, which returns the frame as a PNG data URL.
import { BAKE_FPS, BAKE_FRAMES, bakeNightOcean } from "./index"

const canvas = document.createElement("canvas")
let draw: ((index: number) => void) | null = null

Object.assign(globalThis, {
  bake(width: number, height: number) {
    canvas.width = width
    canvas.height = height
    draw = bakeNightOcean(canvas)
    if (!draw) throw new Error("No WebGL2 in the rendering browser")
    const gl = canvas.getContext("webgl2")
    const info = gl?.getExtension("WEBGL_debug_renderer_info")
    return { frames: BAKE_FRAMES, fps: BAKE_FPS, gpu: String(info ? gl?.getParameter(info.UNMASKED_RENDERER_WEBGL) : "unknown") }
  },
  frame(index: number) {
    draw?.(index)
    return canvas.toDataURL("image/png")
  },
})
