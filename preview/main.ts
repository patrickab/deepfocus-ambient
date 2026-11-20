// Preview of a scene behind a stand-in composer box. Query: ?video=<url> plays a baked video, ?pale draws it dark on a pale page.
import { anchorScene, readSceneAnchor, startNightOcean } from "../src"

const query = new URLSearchParams(location.search)
const canvas = document.getElementById("scene") as HTMLCanvasElement
type Color = [number, number, number]
const DARK: Color = [11 / 255, 10 / 255, 9 / 255]
const PALE_INK: Color = [239 / 255, 236 / 255, 231 / 255]
const PALE: Color = [243 / 255, 237 / 255, 224 / 255]
const DARK_INK: Color = [45 / 255, 41 / 255, 34 / 255]
if (query.has("pale")) document.body.style.background = "#f3ede0"
const box = document.getElementById("box") as HTMLElement

anchorScene(() => {
  const rect = box.getBoundingClientRect()
  return { horizonY: rect.bottom + 30, lightX: rect.left + rect.width / 2, lightY: rect.top + rect.height / 2 }
})

startNightOcean(canvas, {
  videoUrl: query.get("video") ?? undefined,
  frame: () => {
    const anchor = readSceneAnchor()
    const { clientWidth: width, clientHeight: height } = canvas
    return {
      horizon: anchor ? 1 - anchor.horizonY / height : 0.4,
      moon: anchor ? [anchor.lightX / width, 1 - anchor.lightY / height] : [0.5, 0.48],
      paper: query.has("pale") ? PALE : DARK,
      light: query.has("pale") ? DARK_INK : PALE_INK,
      still: false,
    }
  },
})
