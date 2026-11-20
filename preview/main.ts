// Preview of a scene behind a stand-in composer box. Query: ?video=<url> plays a baked video, ?bare hides the box.
import { anchorScene, readSceneAnchor, startNightOcean } from "../src"

const query = new URLSearchParams(location.search)
if (query.has("bare")) document.body.classList.add("bare")
const canvas = document.getElementById("scene") as HTMLCanvasElement
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
      paper: [11 / 255, 10 / 255, 9 / 255],
      light: [239 / 255, 236 / 255, 231 / 255],
      still: false,
    }
  },
})
