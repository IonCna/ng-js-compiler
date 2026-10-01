import { PlatformCode, type ProjectType } from "@/compiler/platform-code.ts";
import type { NgjsTransform } from "@/compiler/ngjs-transform.ts";
import { AsyncDownlevel } from "@/compiler/async-downlevel.ts";
import { TransformChain } from "@/compiler/transform-chain.ts";
import { HmrBoundary } from "@/vite/hmr-boundary.ts";
import { HmrRuntime } from "@/vite/hmr-runtime.ts";
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
 *
 * Hot reload (dev-server de una aplicación): solo los archivos de `@Component` se actualizan en caliente
 * (`HmrBoundary`/`HmrRuntime`); cualquier otro cambio del proyecto recarga la página.
 */
export function viteTransformPlugin(
  sourceRoot: string | string[],
  extraTransforms: NgjsTransform[] = [],
  projectType: ProjectType = "application",
): Plugin {
  const scan = new ProjectScan(sourceRoot, extraTransforms);
  let hmr = false;

  return {
    name: "ngjs-compiler",
    enforce: "pre",
    configResolved(config) {
      hmr = config.command === "serve" && projectType === "application";
      scan.hmr = hmr;
    },
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
      if (projectType !== "application") return [];
      return hmr ? [PlatformCode.htmlTag(), HmrRuntime.htmlTag()] : [PlatformCode.htmlTag()];
    },
    /**
     * Sin esto Vite sube el cambio por los importadores hasta un módulo que lo acepte — un `@Component` que importa un
     * servicio editado se recompilaría con la instancia vieja del servicio. Solo un archivo de `@Component` sigue el
     * camino normal (su propio `accept`); el resto del proyecto (`.ts` o lo que importen, como un `.html?raw`) recarga.
     * Un `.css` lo actualiza Vite, y lo que no está en el grafo (los templates de `ngjs serve`) no pasa por acá.
     */
    async handleHotUpdate({ file, modules, server }) {
      if (!hmr || file.endsWith(".css")) return;
      if (scan.covers(file) && (await scan.within(() => HmrBoundary.isComponentFile(file)))) return;
      if (!scan.covers(file) && modules.length === 0) return;

      server.ws.send({ type: "full-reload", path: "*" });
      return [];
    },
    async transform(code, id) {
      // Dependencias que sirve el dev-server (pre-bundleadas en `.vite/deps` o no): no pasan por el compilador ni por
      // esbuild, así que su `await` nativo se baja acá (`AsyncDownlevel`). Solo en una aplicación: una librería no
      // lleva `ZonePatchesRuntime`.
      if (projectType === "application" && AsyncDownlevel.isDependency(id)) return AsyncDownlevel.dependency(code, id);
      if (!id.endsWith(".ts")) return;

      const output = await TransformChain.run(code, id, await scan.ready());
      // Agregado al final: el source map sigue valiendo tal cual.
      const accept = hmr && scan.covers(id) ? await scan.within(() => HmrBoundary.acceptCode(id)) : undefined;
      if (accept) return { code: `${output?.code ?? code}${accept}`, map: output ? output.map : null };
      return output && { code: output.code, map: output.map };
    },
  };
}
