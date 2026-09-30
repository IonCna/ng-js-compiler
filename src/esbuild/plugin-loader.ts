import { readFile } from "node:fs/promises";
import { ApplicationScanner } from "@/compiler/application-scanner.ts";
import { createNgjsCompilerTransforms } from "@/compiler/ngjs-compiler-transforms.ts";
import { TransformChain } from "@/compiler/transform-chain.ts";
import { PlatformCode, type ProjectType } from "@/compiler/platform-code.ts";
import type { NgjsTransform } from "@/compiler/ngjs-transform.ts";
import { AsyncDownlevel } from "@/compiler/async-downlevel.ts";
import type { Plugin } from "esbuild";

/**
 * Único `onLoad` real de esbuild — esbuild solo deja que UNO se quede con
 * cada archivo, así que en vez de un `Plugin` por transform, hay un solo
 * `Plugin` acá que los corre en secuencia. `onStart` corre el escaneo de dos
 * pasadas (`ApplicationScanner`) sobre `sourceRoot` ANTES del primer
 * `onLoad` — así `ModuleWriter` ya tiene el grafo completo del proyecto
 * cuando le toca compilar cualquier archivo.
 *
 * `fileReplacements`: clave = ruta absoluta de `replace`, valor = ruta
 * absoluta de `with` (environments) — se resuelve ANTES de leer, así el
 * archivo reemplazado también pasa por la cadena de transforms como
 * cualquier otro.
 *
 * `onScanned`: recibe el escaneo de cada build (ej. `ngjs build` de una librería arma su `LibraryManifest`).
 */
export function pluginLoader(
  sourceRoot: string | string[],
  extraTransforms: NgjsTransform[] = [],
  fileReplacements: Record<string, string> = {},
  projectType: ProjectType = "application",
  onScanned?: (scanner: ApplicationScanner) => void,
): Plugin {
  return {
    name: "ngjs-plugin-loader",
    setup(build) {
      let transforms: NgjsTransform[] = extraTransforms;
      // La plataforma (`globalThis.ɵngjsPlatform`) al inicio del bundle, antes que cualquier archivo de la app —
      // solo en una aplicación: una librería no arranca nada (sus servicios root se anotan solos en la cola).
      if (projectType === "application") {
        const { banner } = build.initialOptions;
        build.initialOptions.banner = { ...banner, js: PlatformCode.banner(banner?.js) };

        // `ZonePatchesRuntime` parchea `Promise.prototype.then`, pero eso NO intercepta `async/await` nativo
        // (probado en V8 real: cero intercepciones). El código del proyecto ya sale sin `await` nativo
        // (`decoratorMetadataTransform`); esto baja solo esa sintaxis en lo que no pasa por el compilador
        // (dependencias en `node_modules`), sin tocar el `target` — como Angular CLI con Zone.js. Una clave
        // que el build ya fije a mano se respeta.
        build.initialOptions.supported = { ...AsyncDownlevel.SUPPORTED, ...build.initialOptions.supported };
      }

      // Si el escaneo falla no hay grafo: se corta ahí con ESE error, en vez de seguir cargando TypeScript crudo
      // como JS (lo que taparía el error real con uno de sintaxis por archivo).
      let scanFailed = false;
      build.onStart(async () => {
        scanFailed = false;
        try {
          const scanner = new ApplicationScanner();
          await scanner.scan(sourceRoot, { transforms: extraTransforms, fileReplacements });
          transforms = [...extraTransforms, ...createNgjsCompilerTransforms(scanner)];
          onScanned?.(scanner);
        } catch (error) {
          scanFailed = true;
          return { errors: [{ text: error instanceof Error ? error.message : String(error) }] };
        }
        return undefined;
      });

      build.onLoad({ filter: /\.ts$/ }, async (args) => {
        if (scanFailed) return { contents: "", loader: "js" };
        const path = fileReplacements[args.path] ?? args.path;
        const code = await readFile(path, "utf8");
        const output = await TransformChain.run(code, path, transforms);
        if (!output) return { contents: code, loader: "js" };

        // Como Angular CLI: el mapa va inline en lo que recibe esbuild, que lo junta con el del bundle (`sourcemap`).
        const contents = build.initialOptions.sourcemap && output.map ? TransformChain.inline(output.code, output.map) : output.code;
        return { contents, loader: "js" };
      });
    },
  };
}
