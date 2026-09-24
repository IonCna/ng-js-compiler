import { type Options, transform } from "@swc/core";

/**
 * `async/await` → generadores, en un solo lugar: `ZonePatchesRuntime` parchea `Promise.prototype.then`, y V8 no pasa
 * por `.then` al reanudar un `await` nativo (cero intercepciones, probado). Los helpers de SWC/esbuild reanudan con
 * `Promise.resolve(x).then(...)`, así el digest se dispara. Solo esa sintaxis: el resto queda ES2022 (como Angular
 * CLI con Zone.js).
 *
 * - `SWC_ENV`: el código del proyecto (`decoratorMetadataTransform`, cada `.ts` compilado).
 * - `SUPPORTED`: esbuild (`pluginLoader`), para lo que entra al bundle sin pasar por el compilador (`node_modules`).
 * - `dependency()`: el dev-server de Vite, para las dependencias que sirve (pre-bundleadas o no), que no pasan ni
 *   por el compilador ni por esbuild.
 */
export class AsyncDownlevel {
  static readonly SWC_ENV: NonNullable<Options["env"]> = {
    targets: { chrome: "94" },
    include: ["transform-async-to-generator", "transform-async-generator-functions"],
  };

  static readonly SUPPORTED: Readonly<Record<string, boolean>> = {
    "async-await": false,
    "async-generator": false,
    "for-await": false,
  };

  /** `.js`/`.mjs` de `node_modules` (incluido `node_modules/.vite/deps`), con o sin `?v=` de Vite. */
  static isDependency(id: string): boolean {
    const [path = id] = id.split("?");
    return /[\/]node_modules[\/]/.test(path) && /\.m?js$/.test(path);
  }

  /** Una dependencia sin `await` (la gran mayoría: `angular`, `rxjs`, …) sale intacta sin pasar por SWC. */
  static async dependency(code: string, id: string): Promise<{ code: string; map?: string } | undefined> {
    if (!/\bawait\b/.test(code)) return undefined;
    const [filename = id] = id.split("?");
    const output = await transform(code, {
      filename,
      env: AsyncDownlevel.SWC_ENV,
      jsc: { parser: { syntax: "ecmascript" } },
      module: { type: "es6" },
      sourceMaps: true,
      isModule: true,
    });
    return { code: output.code, map: output.map };
  }
}
