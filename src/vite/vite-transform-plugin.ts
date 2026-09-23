import { ApplicationScanner } from "@/compiler/application-scanner.ts";
import { createNgjsCompilerTransforms } from "@/compiler/ngjs-compiler-transforms.ts";
import { PlatformCode, type ProjectType } from "@/compiler/platform-code.ts";
import type { NgjsTransform } from "@/compiler/ngjs-transform.ts";
import type { Plugin } from "vite";

/**
 * Equivalente de `pluginLoader` (esbuild) para Vite. `buildStart` corre el
 * escaneo de dos pasadas (`ApplicationScanner`) sobre `sourceRoot` ANTES del
 * primer `transform` — mismo momento que usaría cualquier plugin de Vite
 * para un análisis de todo el proyecto. `enforce: "pre"` es crítico: el
 * transform interno de Vite (`vite:esbuild`) borra las anotaciones de tipo
 * antes de los plugins de prioridad normal — sin esto, `DecoratorReader` no
 * ve los tipos de los parámetros del constructor (tokens de DI de `ɵfac`).
 */
export function viteTransformPlugin(
  sourceRoot: string,
  extraTransforms: NgjsTransform[] = [],
  projectType: ProjectType = "application",
): Plugin {
  let transforms: NgjsTransform[] = extraTransforms;

  return {
    name: "ngjs-compiler",
    enforce: "pre",
    async buildStart() {
      const scanner = new ApplicationScanner();
      await scanner.scan(sourceRoot);
      transforms = [...extraTransforms, ...createNgjsCompilerTransforms(scanner)];
    },
    // La plataforma (`globalThis.ɵngjsPlatform`) antes que los `<script type="module">` de la app — solo en una
    // aplicación (una librería no arranca nada).
    transformIndexHtml() {
      return projectType === "application" ? [PlatformCode.htmlTag()] : [];
    },
    /**
     * `ZonePatchesRuntime` (ver `platform-code.ts`) parchea `Promise.prototype.then`, que NO intercepta
     * `async/await` nativo (probado en V8 real: cero intercepciones) — a `target: "es2016"` esbuild baja
     * `async/await` a un helper basado en generadores que sí llama `.then()` por debajo, así el patch lo
     * agarra igual. Vite usa esbuild para transformar cada archivo (dev y build), mismo mecanismo que
     * `pluginLoader` (esbuild). Si el proyecto ya pide un `target` propio, o desactivó esbuild
     * (`esbuild: false`), se respeta tal cual — no se pisa una elección explícita.
     */
    config(userConfig) {
      if (projectType !== "application") return;
      if (userConfig.esbuild === false) return;
      if (userConfig.esbuild?.target !== undefined) return;
      return { esbuild: { ...userConfig.esbuild, target: "es2016" } };
    },
    async transform(code, id) {
      if (!id.endsWith(".ts")) return;

      let result = code;
      for (const transform of transforms) {
        const next = await transform.transform(result, id);
        if (next !== undefined) result = next;
      }

      return result === code ? undefined : { code: result, map: null };
    },
  };
}
