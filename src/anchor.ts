/** Where a scene sits in the window, in viewport pixels from the top left. */
export interface SceneAnchor {
  /** The horizon line. */
  horizonY: number
  /** The scene's light source (the night ocean's hidden moon), the middle of its glow. */
  lightX: number
  lightY: number
}

const anchors: (() => SceneAnchor | null)[] = []

/**
 * Tie the scene to a piece of UI, until the returned release is called.
 *
 * - `read` is called each frame, so the scene follows layout animations. It returns null while its UI is not on screen
 * - With several anchors the newest one on screen wins
 */
export function anchorScene(read: () => SceneAnchor | null): () => void {
  anchors.push(read)
  return () => {
    const index = anchors.indexOf(read)
    if (index >= 0) anchors.splice(index, 1)
  }
}

/** The anchor on screen now, null without one. */
export function readSceneAnchor(): SceneAnchor | null {
  for (let i = anchors.length - 1; i >= 0; i--) {
    const anchor = anchors[i]?.()
    if (anchor) return anchor
  }
  return null
}
