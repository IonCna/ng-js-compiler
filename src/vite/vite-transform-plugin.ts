import { PlatformCode, type ProjectType } from "@/compiler/platform-code.ts";
import type { NgjsTransform } from "@/compiler/ngjs-transform.ts";
import { AsyncDownlevel } from "@/compiler/async-downlevel.ts";
import { ProjectScan } from "@/vite/project-scan.ts";
import type { Plugin } from "vite";

/**
 * Equivalente de `pluginLoader` (esbuild) para Vite. `buildStart` corre el
 * escaneo de dos pasadas (`ApplicationScanner`) sobre `sourceRoot` ANTES del
 * primer `transform` — mismo momento que usaría cualquier plugin de Vite
 * para un análisis de todo el proyecto. `enforce: "pre"` es crítico: el
 * transform interno de Vite (`vite:esbuild`) borra las anotaciones de tipo
 * antes de los plugins de prioridad normal — sin esto, `DecoratorReader` no
 * ve los tipos de los parámetros del constructor (tokens de DI de `ɵfac`).
 *
 * En el dev-server el escaneo se rehace con cada cambio de un `.ts` de `sourceRoot` (`ProjectScan`): un módulo
 * nuevo tiene que entrar al grafo, y la salida de un `@NgModule` depende de archivos que no se tocaron.
 */
export function viteTransformPlugin(
  sourceRoot: string | string[],
  extraTransforms: NgjsTransform[] = [],
  projectType: ProjectType = "application",
): Plugin {
  const scan = new ProjectScan(sourceRoot, extraTransforms);

  return {
    name: "ngjs-compiler",
    enforce: "pre",
    async buildStart() {
      await scan.rescan();
    },
    /**
     * Archivo agregado/editado/borrado bajo `sourceRoot` → escaneo nuevo. Se invalida YA (sincrónico, en el mismo
     * evento del watcher que dispara el reload de Vite) todo módulo de `sourceRoot`: el `@NgModule` que declara un
     * componente editado cambia su salida sin haber cambiado él. El pedido que llegue después espera el escaneo.
     */
    configureServer(server) {
      const onChange = (file: string) => {
        if (!scan.covers(file)) return;
        for (const module of server.moduleGraph.idToModuleMap.values()) {
          if (module.id && scan.covers(module.id)) server.moduleGraph.invalidateModule(module);
        }
        void scan.rescan().catch(() => undefined); // el error lo ven los `transform` que esperan (`ready()`)
      };
      server.watcher.on("add", onChange);
      server.watcher.on("change", onChange);
      server.watcher.on("unlink", onChange);
    },
    // La plataforma (`globalThis.ɵngjsPlatform`) antes que los `<script type="module">` de la app — solo en una
    // aplicación (una librería no arranca nada).
    transformIndexHtml() {
      return projectType === "application" ? [PlatformCode.htmlTag()] : [];
    },
    async transform(code, id) {
      // Dependencias que sirve el dev-server (pre-bundleadas en `.vite/deps` o no): no pasan por el compilador ni por
      // esbuild, así que su `await` nativo se baja acá (`AsyncDownlevel`). Solo en una aplicación: una librería no
      // lleva `ZonePatchesRuntime`.
      if (projectType === "application" && AsyncDownlevel.isDependency(id)) return AsyncDownlevel.dependency(code, id);
      if (!id.endsWith(".ts")) return;

      let result = code;
      for (const transform of await scan.ready()) {
        const next = await transform.transform(result, id);
        if (next !== undefined) result = next;
      }

      return result === code ? undefined : { code: result, map: null };
    },
  };
}
