import { ZonePatchesRuntime } from "@/compiler/zone-patches-runtime.ts";

/** Como `projectType` de `angular.json`: una librería nunca arranca nada, solo una aplicación lleva la plataforma. */
export type ProjectType = "application" | "library";

const PLATFORM_GLOBAL = "ɵngjsPlatform";
const ROOT_PROVIDERS_GLOBAL = "ɵngjsRootProviders";
const ROOT_SCOPE_GLOBAL = "ɵngjsRootScope";
const ROOT_MODULE = "ɵroot";
const ROOT_PROVIDERS_MODULE = "ɵroot.providers";

/**
 * La plataforma que el build deja en `globalThis.ɵngjsPlatform` — el contrato que consume
 * `platformBrowserDynamic()` (la puerta, del lado de quien lo exporte; acá no se sabe ni importa quién).
 * Se crea una sola vez y se inyecta al INICIO del build (antes de que se evalúe cualquier archivo de la
 * app, que puede llamar a `bootstrapModule` apenas se carga); cada adaptador la consume a su manera:
 * esbuild como `banner`, Vite como `<script>` en el HTML.
 *
 * Al inicio puede no existir `angular` todavía (si va dentro del mismo bundle), así que acá no se registra
 * nada: los `@Injectable({ providedIn: "root" })` se anotan en `globalThis.ɵngjsRootProviders` al evaluarse
 * (`rootProviderStatement`) — solo los que entran al bundle, como el tree-shaking de Angular — y
 * `bootstrapModule` arma los módulos raíz al correr: `ɵroot.providers` con esa cola, y `ɵroot` que depende
 * de él PRIMERO y después del módulo arrancado (AngularJS carga los `requires` en orden y el último registro
 * gana: así un provider del `@NgModule` pisa al root, como en Angular).
 *
 * También estampa `ZonePatchesRuntime` (mismo gate: `projectType: "application"`) — los patches globales
 * (`setTimeout`/`setInterval`/`addEventListener`/`Promise.then`) para que cualquier cosa que dispare
 * trabajo async termine en un digest, sin ninguna clase `NgZone` ni Zone.js real de por medio. Ver ese
 * archivo.
 */
export class PlatformCode {
  /** El código de la plataforma, JS plano; lo único que lee es lo que el compilador estampó (`ɵmod`, `ɵfac`). */
  static source(): string {
    return `(function () {
  if (globalThis.${PLATFORM_GLOBAL}) return;
  globalThis.${ROOT_PROVIDERS_GLOBAL} = globalThis.${ROOT_PROVIDERS_GLOBAL} || [];
  globalThis.${PLATFORM_GLOBAL} = {
    bootstrapModule: function (moduleType) {
      return new Promise(function (resolve, reject) {
        angular.element(document).ready(function () {
          try {
            if (!moduleType || !moduleType.ɵmod) throw new Error("bootstrapModule(): recibe una clase @NgModule compilada.");
            var providers = angular.module(${JSON.stringify(ROOT_PROVIDERS_MODULE)}, []);
            globalThis.${ROOT_PROVIDERS_GLOBAL}.forEach(function (provider) { providers.factory(provider[0], provider[1]); });
            angular.module(${JSON.stringify(ROOT_MODULE)}, [${JSON.stringify(ROOT_PROVIDERS_MODULE)}, moduleType.ɵmod.id]);
            var host = document.body;
            (moduleType.ɵmod.bootstrap || []).forEach(function (tag) { if (!host.querySelector(tag)) host.appendChild(document.createElement(tag)); });
            var injector = angular.bootstrap(host, [${JSON.stringify(ROOT_MODULE)}]);
            // El patch de ZonePatchesRuntime (setTimeout/addEventListener/Promise.then) necesita ESTE
            // $rootScope para saber a qué aplicarle $apply — no existe hasta que el bootstrap de verdad corrió.
            globalThis.${ROOT_SCOPE_GLOBAL} = injector.get("$rootScope");
            resolve(injector);
          } catch (error) { reject(error); }
        });
      });
    },
  };
})();
${ZonePatchesRuntime.source()}`;
  }

  /** Lo que emite cada `@Injectable({ providedIn: "root" })` junto a su `ɵprov`: se anota en la cola de la plataforma. */
  static rootProviderStatement(token: string, className: string): string {
    return `(globalThis.${ROOT_PROVIDERS_GLOBAL} = globalThis.${ROOT_PROVIDERS_GLOBAL} || []).push([${JSON.stringify(token)}, ${className}.ɵfac]);`;
  }

  /** esbuild: la plataforma antepuesta al `banner.js` que ya tuviera el build. */
  static banner(existing: string | undefined): string {
    return [PlatformCode.source(), existing].filter(Boolean).join("\n");
  }

  /** Vite: `<script>` clásico al principio del `<head>` — corre antes que los `<script type="module">` de la app. */
  static htmlTag(): { tag: "script"; children: string; injectTo: "head-prepend" } {
    return { tag: "script", children: PlatformCode.source(), injectTo: "head-prepend" };
  }
}
