import { readFile } from "node:fs/promises";
import { ApplicationScanner } from "@/compiler/application-scanner.ts";
import { createNgjsCompilerTransforms } from "@/compiler/ngjs-compiler-transforms.ts";
import { PlatformCode, type ProjectType } from "@/compiler/platform-code.ts";
import type { NgjsTransform } from "@/compiler/ngjs-transform.ts";
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
 */
export function pluginLoader(
  sourceRoot: string | string[],
  extraTransforms: NgjsTransform[] = [],
  fileReplacements: Record<string, string> = {},
  projectType: ProjectType = "application",
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
        // (probado en V8 real: cero intercepciones) — a `target: "es2016"` esbuild baja `async/await` a un
        // helper basado en generadores que sí llama `.then()` por debajo, así el patch los agarra igual.
        // Si el proyecto ya pide un `target` propio, se respeta tal cual (puede ser más bajo — downlevelea
        // igual o más — o más alto a propósito, sabiendo que entonces `await` no dispara digest solo).
        if (build.initialOptions.target === undefined) build.initialOptions.target = "es2016";
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
        } catch (error) {
          scanFailed = true;
          return { errors: [{ text: error instanceof Error ? error.message : String(error) }] };
        }
        return undefined;
      });

      build.onLoad({ filter: /\.ts$/ }, async (args) => {
        if (scanFailed) return { contents: "", loader: "js" };
        const path = fileReplacements[args.path] ?? args.path;
        let code = await readFile(path, "utf8");

        for (const transform of transforms) {
          const result = await transform.transform(code, path);
          if (result !== undefined) code = result;
        }

        return { contents: code, loader: "js" };
      });
    },
  };
}
