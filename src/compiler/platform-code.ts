import { ResolveDependency } from "@/compiler/resolve-dependency.ts";
import { ZonePatchesRuntime } from "@/compiler/zone-patches-runtime.ts";

/** Como `projectType` de `angular.json`: una librería nunca arranca nada, solo una aplicación lleva la plataforma. */
export type ProjectType = "application" | "library";

const PLATFORM_GLOBAL = "ɵngjsPlatform";
const ROOT_PROVIDERS_GLOBAL = "ɵngjsRootProviders";
const ROOT_SCOPE_GLOBAL = "ɵngjsRootScope";
const INJECTOR_GLOBAL = "ɵngjsInjector";
const ROOT_MODULE = "ɵroot";
const ROOT_PROVIDERS_MODULE = "ɵroot.providers";
/** Propiedad del injector de providers con los tokens que solo tienen su default de raíz (ver `rootDefaultsConfig`). */
export const ROOT_DEFAULTS = "ɵrootDefaults";

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
            // \`ɵresolve\` siempre acá: un factory \`providedIn: "root"\` (\`InjectionToken\`, receta de \`@Injectable\`) puede pedirlo
            // aunque ningún \`@NgModule\` del proyecto lo registre (ver \`ResolveDependency\`).
            var providers = angular.module(${JSON.stringify(ROOT_PROVIDERS_MODULE)}, [])${ResolveDependency.factoryFragment()};
            globalThis.${ROOT_PROVIDERS_GLOBAL}.forEach(function (provider) { providers.factory(provider[0], provider[1]); });
            providers.config(${PlatformCode.rootDefaultsConfig()});
            var registerLateRoot;
            providers.config(${PlatformCode.lateRootConfig("registerLateRoot")});
            angular.module(${JSON.stringify(ROOT_MODULE)}, [${JSON.stringify(ROOT_PROVIDERS_MODULE)}, moduleType.ɵmod.id]);
            var host = document.body;
            (moduleType.ɵmod.bootstrap || []).forEach(function (tag) { if (!host.querySelector(tag)) host.appendChild(document.createElement(tag)); });
            var injector = angular.bootstrap(host, [${JSON.stringify(ROOT_MODULE)}]);
            // El patch de ZonePatchesRuntime (setTimeout/addEventListener/Promise.then) necesita ESTE
            // $rootScope para saber a qué aplicarle $apply — no existe hasta que el bootstrap de verdad corrió.
            globalThis.${ROOT_SCOPE_GLOBAL} = injector.get("$rootScope");
            globalThis.${INJECTOR_GLOBAL} = injector;
            ${PlatformCode.lateRootHook("registerLateRoot")}
            var initializers = globalThis.ɵngjsAppInitializers || [];
            globalThis.ɵngjsAppInitializers = [];
            Promise.all(initializers.map(function (initializer) { return initializer(injector); })).then(function () {
              resolve(injector);
            }, reject);
          } catch (error) { reject(error); }
        });
      });
    },
  };
})();
${ZonePatchesRuntime.source()}`;
  }

  /**
   * `.config` de `ɵroot.providers`: anota en el injector de providers (`ɵrootDefaults`) qué tokens tienen solo su
   * default `providedIn: "root"`. En Angular ese default no es un provider más: si un módulo aporta providers
   * `multi` para el token (un `InjectionToken` con `factory`), los multi lo reemplazan sin error de "mezcla"
   * (`MultiProvidersRuntime` consulta la marca). Corre después de la cola de `ɵroot.providers` y antes que la de
   * cualquier `@NgModule`; un registro posterior del token (un provider no-multi de un módulo) borra la marca.
   */
  static rootDefaultsConfig(): string {
    return `["$provide", "$injector", function ($provide, providerInjector) {
              var defaults = providerInjector.${ROOT_DEFAULTS} = {};
              globalThis.${ROOT_PROVIDERS_GLOBAL}.forEach(function (provider) { defaults[provider[0]] = true; });
              ["provider", "factory", "service", "value", "constant"].forEach(function (method) {
                var original = $provide[method];
                $provide[method] = function (name) {
                  if (typeof name === "string") delete defaults[name];
                  return original.apply(this, arguments);
                };
              });
            }]`;
  }

  /**
   * `.config` de `ɵroot.providers` (después de `rootDefaultsConfig`, así usa su `$provide` ya envuelto): deja en
   * `variable` cómo registrar un `providedIn: "root"` que se evalúa DESPUÉS del bootstrap — un servicio que solo
   * importa un chunk lazy (`loadChildren`), en Angular igual de disponible que uno del bundle inicial.
   * `$provide.factory` después del bootstrap anda: el instance injector busca `<token>Provider` en el provider cache
   * recién cuando alguien lo pide. Un token ya registrado (por un `@NgModule` o por la cola inicial) no se pisa.
   */
  static lateRootConfig(variable: string): string {
    return `["$provide", "$injector", function ($provide, providerInjector) {
              ${variable} = function (provider) {
                if (providerInjector.has(provider[0] + "Provider")) return;
                $provide.factory(provider[0], provider[1]);
                if (providerInjector.${ROOT_DEFAULTS}) providerInjector.${ROOT_DEFAULTS}[provider[0]] = true;
              };
            }]`;
  }

  /**
   * Después del bootstrap: cada `push` nuevo a la cola (`rootProviderStatement` de un archivo recién evaluado) se
   * registra también en cada app viva. El `push` se envuelve una sola vez por página; cada bootstrap suma su
   * registrador (varias apps, o una por test).
   */
  static lateRootHook(variable: string): string {
    return `var queue = globalThis.${ROOT_PROVIDERS_GLOBAL};
            if (!queue.ɵlateRoot) {
              var push = queue.push;
              queue.ɵlateRoot = [];
              queue.push = function () {
                var added = Array.prototype.slice.call(arguments);
                var length = push.apply(queue, added);
                added.forEach(function (provider) { queue.ɵlateRoot.forEach(function (register) { register(provider); }); });
                return length;
              };
            }
            queue.ɵlateRoot.push(${variable});`;
  }

  /**
   * Lo que emite cada `providedIn: "root"` (`@Injectable`, `InjectionToken` con `factory`) junto a su `ɵprov`: se
   * anota en la cola de la plataforma. `factory` es la expresión de la anotación (`X.ɵfac`, `X.ɵprov.factory`).
   */
  static rootProviderStatement(token: string, factory: string): string {
    return `(globalThis.${ROOT_PROVIDERS_GLOBAL} = globalThis.${ROOT_PROVIDERS_GLOBAL} || []).push([${JSON.stringify(token)}, ${factory}]);`;
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
