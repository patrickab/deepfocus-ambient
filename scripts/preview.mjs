// Serve the preview page: `npm run preview`, then open the printed URL. A baked video plays with ?video=/out/night-ocean.webm
import { context } from "esbuild"

const build = await context({ entryPoints: ["preview/main.ts"], bundle: true, format: "esm", outfile: "out/preview/main.js" })
const { port } = await build.serve({ servedir: ".", port: Number(process.env.PORT ?? 8765) })
console.log(`http://127.0.0.1:${port}/preview/`)
