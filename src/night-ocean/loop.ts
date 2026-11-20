/**
 * The timing of the night ocean and the wave table that makes it loop.
 *
 * - The sea repeats exactly every `LOOP_SECONDS`, so a baked video of one loop plays seamlessly
 * - The camera drifts sideways at `DRIFT`. The shader works in camera space, the drift is folded into each wave's phase speed
 * - Each wave's phase speed is rounded to a whole number of turns per loop, a change of a few percent at most
 */

/** Sea seconds per real second: slow enough to read as calm. */
export const SEA_SPEED = 0.38
/** Real seconds until the sea repeats. */
export const LOOP_SECONDS = 60
/** Sea seconds until the sea repeats. */
export const LOOP = LOOP_SECONDS * SEA_SPEED
/** Sideways camera drift, world units per sea second. */
const DRIFT = 0.45

export const OCTAVES = 18
const SWELL_DIRECTION: [number, number] = [-0.2425356, 0.9701425]
/** How far each wave's heading leans towards the swell. */
const SWELL_BIAS = 0.35
const BASE_FREQUENCY = 1.18
const TAU = 2 * Math.PI

/** The phase speed nearest to a wave's own plus the drift along its wave vector, in whole turns per loop. */
function loopedSpeed(waveVectorX: number, speed: number): number {
  return (TAU * Math.round(((speed + waveVectorX * DRIFT) * LOOP) / TAU)) / LOOP
}

const glsl = (value: number) => {
  const text = String(Number(value.toPrecision(9)))
  return /[.e]/.test(text) ? text : `${text}.0`
}

/** GLSL constants of the wave field: `OCT[i]` is (wave vector, phase speed, weight), `OCT_DIR[i]` the heading, `SWELLS[i]` (wave vector, phase speed, weight). */
export function waveTable(): string {
  const octaves: string[] = []
  const headings: string[] = []
  let angle = 0
  let frequency = BASE_FREQUENCY
  let speed = 2
  let weight = 1
  for (let i = 0; i < OCTAVES; i++) {
    let x = Math.sin(angle) + (SWELL_DIRECTION[0] - Math.sin(angle)) * SWELL_BIAS
    let y = Math.cos(angle) + (SWELL_DIRECTION[1] - Math.cos(angle)) * SWELL_BIAS
    const length = Math.hypot(x, y)
    x /= length
    y /= length
    octaves.push(`vec4(${glsl(x * frequency)}, ${glsl(y * frequency)}, ${glsl(loopedSpeed(x * frequency, speed))}, ${glsl(weight)})`)
    headings.push(`vec2(${glsl(x)}, ${glsl(y)})`)
    weight *= 0.78
    frequency *= 1.18
    speed *= 1.07
    angle = Math.fround(angle + Math.fround(1232.399963))
  }
  // Long slow swells: they lift and lower whole stretches of sea
  const swells = ([[SWELL_DIRECTION, 0.17, 0.55, 0.65], [[0.55, 0.835], 0.093, 0.38, 0.35]] as const).map(([direction, frequency, speed, weight]) => {
    const x = direction[0] * frequency
    return `vec4(${glsl(x)}, ${glsl(direction[1] * frequency)}, ${glsl(loopedSpeed(x, -speed))}, ${glsl(weight)})`
  })
  return `
const vec4 OCT[${OCTAVES}] = vec4[${OCTAVES}](${octaves.join(", ")});
const vec2 OCT_DIR[${OCTAVES}] = vec2[${OCTAVES}](${headings.join(", ")});
const vec4 SWELLS[2] = vec4[2](${swells.join(", ")});
`
}
