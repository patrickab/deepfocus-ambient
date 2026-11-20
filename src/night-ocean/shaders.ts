/**
 * The night ocean's shaders.
 *
 * - `SEA_FRAGMENT` raymarches the wave height field and shades it with the Fresnel reflection of a hazy night sky, a moon hidden in the haze
 * - Compiled with `BAKE` it writes the scene's light alone, as the square root for precision in the dark, for a video
 * - `VIDEO_FRAGMENT` shows such a video. Both finish through `FINISH`: sea fade, stars, the two theme colors, film grain
 * - Wave field after afl_ext's "Very fast procedural ocean" (MIT License, 2017-2024)
 */
import { OCTAVES, waveTable } from "./loop"

/** Distance to the image plane, in half viewport heights: the field of view. */
export const FOCAL = 1.7
/** A baked video is this many viewport heights tall, the spare is room to slide it under the anchor. */
export const BAKE_MARGIN = 1.2
/** Horizon height in a baked video, 0 at the bottom. */
export const BAKE_HORIZON = 0.4
/** The moon above the horizon in a baked video, in viewport heights. */
export const BAKE_MOON_ABOVE = 0.08

const f = (value: number) => (Number.isInteger(value) ? `${value}.0` : String(value))

export const VERTEX = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`

const HEADER = `#version 300 es
precision highp float;
// the hashes need all 32 bits: integers default to mediump, which Vulkan drivers take at their word
precision highp int;
out vec4 outColor;

uniform vec2  uRes;        // canvas pixels
uniform float uHorizon;    // horizon height, 0 (bottom) .. 1 (top)
uniform vec2  uMoonAt;     // the hidden moon on screen, 0..1 from the bottom left

#define TAU 6.28318530718
#define FOCAL ${f(FOCAL)}
`

/** Stars, the two theme colors and film grain over the scene's light. */
const FINISH = `
uniform vec3  uPaper;      // background color, sRGB
uniform vec3  uLight;      // color of everything lit, sRGB
uniform float uClock;      // real seconds, for the stars' twinkle
uniform float uGrain;      // film grain amplitude
uniform float uGrainFrame; // index of the grain pattern
uniform float uStars;      // star brightness
uniform float uPx;         // canvas pixels per CSS pixel

uint pcg(uint v) {
  uint s = v * 747796405u + 2891336453u;
  uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
float hash3(vec2 p, float k) {
  uvec2 q = uvec2(ivec2(floor(p)) + 32768);
  return float(pcg(q.x + pcg(q.y + pcg(uint(k))))) / 4294967295.0;
}

float stars(vec2 frag, float elevation) {
  float cell = 34.0 * uPx;
  vec2 id = floor(frag / cell);
  if (hash3(id, 1.0) > 0.42) return 0.0;
  vec2 pos = (id + 0.15 + 0.7 * vec2(hash3(id, 2.0), hash3(id, 3.0))) * cell;
  float mag = hash3(id, 4.0);
  float radius = (0.45 + 0.5 * mag) * uPx;
  float core = smoothstep(radius, radius * 0.25, length(frag - pos));
  float twinkle = 1.0 + 0.3 * sin(uClock * (0.23 + 0.53 * hash3(id, 5.0)) + TAU * hash3(id, 6.0));
  return core * twinkle * smoothstep(0.03, 0.30, elevation) * (0.12 + 0.88 * mag * mag * mag);
}

// "light" is the scene's light after the tone curve, 0..1
vec3 finish(float light, vec2 frag) {
  float height = frag.y / uRes.y;
  // the sea sinks back into the page towards the bottom edge
  light *= mix(0.3, 1.0, smoothstep(0.0, 0.6, height / uHorizon));
  float elevation = (height - uHorizon) * 2.0 / FOCAL;
  if (elevation > 0.0) light += (1.0 - exp(-uStars * stars(frag, elevation))) * (1.0 - light);
  vec3 color = mix(uPaper, uLight, light);
  float grain = hash3(frag, 11.0 + uGrainFrame) + hash3(frag, 4111.0 + uGrainFrame) - 1.0;
  return color + grain * uGrain * (0.55 + 3.0 * light);
}
`

const SEA = `
uniform float uTime;       // sea seconds into the loop
uniform float uFocal;      // image plane distance of this canvas
uniform float uMist;       // horizon haze strength
uniform float uMoon;       // strength of the hidden moon behind the haze

#define CAM_HEIGHT 1.6
#define DEPTH 0.84
#define SWELL 0.30
#define MAX_DIST 380.0
#define STEPS 30
#define OCT_MARCH 8
#define OCT_DETAIL ${OCTAVES}
#define DRAG 0.38
// mean of exp(sin(x) - 1) over a period: filtered octaves settle here, sea level stays put
#define OCT_MEAN 0.46575961
${waveTable()}
vec3 moonDir;

float swell(vec2 p) {
  float sum = 0.0;
  for (int i = 0; i < 2; i++) sum += sin(dot(p, SWELLS[i].xy) + uTime * SWELLS[i].z) * SWELLS[i].w;
  return sum * SWELL;
}

// Wave height in [-DEPTH, 0] (plus swell) at "p" in camera space, filtered for a sample "fp" world units wide.
float height(vec2 p, int octaves, float fp) {
  vec2 p0 = p;
  float shift = length(p) * 0.1;
  float sum = 0.0, wsum = 0.0;
  for (int i = 0; i < octaves; i++) {
    vec4 o = OCT[i];
    // an octave fades out once a pixel covers a good part of its wavelength
    float keep = 1.0 - smoothstep(0.12, 0.45, fp * length(o.xy) / TAU);
    wsum += o.w;
    if (keep > 0.0) {
      float x = dot(o.xy, p) + uTime * o.z + shift;
      float e = exp(sin(x) - 1.0);
      sum += mix(OCT_MEAN, e, keep) * o.w;
      p -= OCT_DIR[i] * (e * cos(x) * o.w * keep * DRAG);
    } else {
      sum += OCT_MEAN * o.w;
    }
  }
  return (sum / wsum - 1.0) * DEPTH + swell(p0);
}

float march(vec3 o, vec3 r, float t0, float t1, float lod) {
  float stretch = 1.0 / (0.25 - r.y);
  float t = t0, prevT = t0, prevGap = 0.0;
  for (int i = 0; i < STEPS; i++) {
    vec3 p = o + r * t;
    float gap = p.y - height(p.xz, OCT_MARCH, t * lod);
    if (gap < 0.0) return mix(prevT, t, prevGap / (prevGap - gap));
    if (gap < 0.25 * t * lod * -r.y) return t;
    prevT = t;
    prevGap = gap;
    t += gap * stretch;
    if (t >= t1) return t1;
  }
  return t;
}

vec3 surfaceNormal(vec2 p, float e, float fp) {
  float h = height(p, OCT_DETAIL, fp);
  float hx = height(p - vec2(e, 0.0), OCT_DETAIL, fp);
  float hz = height(p + vec2(0.0, e), OCT_DETAIL, fp);
  return normalize(vec3(hx - h, e, h - hz));
}

// Light of the night sky in a direction: haze along the horizon, a moon hidden inside it.
float sky(vec3 d) {
  float y = max(d.y, 0.0);
  float haze = uMist * (0.72 * exp(-y * 11.0) + 0.28 * exp(-y * 3.2));
  float m = max(dot(d, moonDir), 0.0);
  float moon = uMoon * (0.55 * pow(m, 44.0) + 0.45 * pow(m, 320.0)) * exp(-y * 5.0);
  return haze + moon;
}

// The scene's light along the ray through "frag", before the tone curve.
float scene(vec2 frag) {
  vec2 aspect = vec2(uRes.x / uRes.y, 1.0);
  // tilt the camera so the horizon lands on uHorizon
  float tilt = atan(-(uHorizon * 2.0 - 1.0) / uFocal);
  float c = cos(tilt), s = sin(tilt);
  vec3 q = normalize(vec3(((frag / uRes) * 2.0 - 1.0) * aspect, uFocal));
  vec3 ray = vec3(q.x, c * q.y + s * q.z, c * q.z - s * q.y);
  vec3 mq = normalize(vec3((uMoonAt * 2.0 - 1.0) * aspect, uFocal));
  moonDir = vec3(mq.x, c * mq.y + s * mq.z, c * mq.z - s * mq.y);
  if (ray.y >= 0.0) return sky(ray);

  vec3 origin = vec3(0.0, CAM_HEIGHT, 0.0);
  float t0 = (origin.y - SWELL) / -ray.y;
  float t1 = min((origin.y + DEPTH + SWELL) / -ray.y, MAX_DIST);
  float pixelAngle = 2.0 / (uFocal * uRes.y);
  float lod = pixelAngle * inversesqrt(max(-ray.y, 0.01));
  float dist = t0 < t1 ? march(origin, ray, t0, t1, lod) : t1;
  vec3 hit = origin + ray * dist;

  float far = min(1.0, sqrt(dist * 0.01) * 1.1);
  vec3 n = surfaceNormal(hit.xz, max(0.01, dist * pixelAngle), dist * lod);
  n = normalize(mix(n, vec3(0.0, 1.0, 0.0), 0.45 * far));

  float fresnel = 0.03 + 0.97 * pow(1.0 - max(dot(n, -ray), 0.0), 5.0);
  float fresnelFlat = 0.03 + 0.97 * pow(1.0 + ray.y, 5.0);
  fresnel = mix(fresnel, fresnelFlat, 0.5 * far);

  vec3 refl = reflect(ray, n);
  refl.y = abs(refl.y);
  float body = uMist * 0.035 * (0.25 + (hit.y + DEPTH) / DEPTH);
  float glint = pow(max(dot(refl, moonDir), 0.0), 500.0);
  float light = fresnel * (sky(refl) + uMoon * 2.2 * glint) + max(body, 0.0);
  return mix(light, sky(normalize(vec3(ray.x, 0.0, ray.z))), 1.0 - exp(-dist * 0.02));
}
`

/** The sea drawn live. With `bake` it writes the square root of the scene's light, no stars, colors or grain. */
export function seaFragment(bake: boolean): string {
  if (bake) return `${HEADER}${SEA}
void main() {
  outColor = vec4(vec3(sqrt(1.0 - exp(-scene(gl_FragCoord.xy)))), 1.0);
}
`
  return `${HEADER}${FINISH}${SEA}
void main() {
  outColor = vec4(finish(1.0 - exp(-scene(gl_FragCoord.xy)), gl_FragCoord.xy), 1.0);
}
`
}

/** A baked video, slid so its horizon and moon land on the anchor, then finished like the live sea. */
export const VIDEO_FRAGMENT = `${HEADER}${FINISH}
uniform sampler2D uVideo;
uniform float uVideoAspect;

void main() {
  vec2 at = gl_FragCoord.xy / uRes;
  float aspect = uRes.x / uRes.y;
  // the video's width in viewport heights, enlarged where the window is wider still
  float wide = ${f(BAKE_MARGIN)} * uVideoAspect;
  float zoom = max(1.0, aspect / wide);
  float room = (wide * zoom - aspect) / (2.0 * aspect);
  float moonX = 0.5 + clamp(uMoonAt.x - 0.5, -room, room);
  vec2 uv = vec2(0.5 + (at.x - moonX) * aspect / (wide * zoom), ${f(BAKE_HORIZON)} + (at.y - uHorizon) / (${f(BAKE_MARGIN)} * zoom));
  float root = texture(uVideo, clamp(uv, 0.0, 1.0)).r;
  outColor = vec4(finish(root * root, gl_FragCoord.xy), 1.0);
}
`
