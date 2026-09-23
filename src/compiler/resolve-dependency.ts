import type { InjectFlags } from "@/metadata/decorator-metadata.ts";

/**
 * Flags de resolución (`@Optional()`/`@Self()`/`@SkipSelf()`/`@Host()`, `inject(X, { ... })`, `[new Optional(), X]` en
 * `deps`) — AngularJS no los conoce: un nombre sin provider es error, y hay un solo injector. Cada dependencia con
 * flags se pide en el `ɵfac`/factory como `"ɵresolve"` (una función `(token, flags, element?) → instancia | null`) y
 * se llama con el token al construir: `new X(a0, a1("Logger_ab12", {"optional":true}))`.
 *
 * `ɵresolve` lo registra cada `@NgModule` del proyecto si alguna dependencia lleva flags (`ModuleWriter`), y la
 * plataforma siempre (`PlatformCode`). Esa versión es la del injector de la app — sin injector de elemento: en una
 * clase de elemento (`element`, `@Component`/`@Directive`) `self` y `host` no salen del elemento/host y no hay nada
 * propio → no se encuentra (Angular tampoco consulta el injector del módulo con esos dos); `skipSelf` cae a la app.
 * Dentro de un elemento con providers la resuelve `ScopedInjectorRuntime` con la cadena de nodos.
 */
export class ResolveDependency {
  static readonly TOKEN = "ɵresolve";

  static hasFlags(flags: InjectFlags | undefined): boolean {
    return Boolean(flags && (flags.optional || flags.self || flags.skipSelf || flags.host));
  }

  /** Nombre de la anotación para una dep: el token tal cual, o `ɵresolve` si lleva flags. */
  static depName(token: string, flags: InjectFlags | undefined): string {
    return JSON.stringify(ResolveDependency.hasFlags(flags) ? ResolveDependency.TOKEN : token);
  }

  /** El valor al construir: el parámetro tal cual, o `param("Token", {flags}[, true])` si lleva flags. */
  static value(param: string, token: string, flags: InjectFlags | undefined, element = false): string {
    if (!ResolveDependency.hasFlags(flags)) return param;
    const set = Object.fromEntries(Object.entries(flags!).filter(([, on]) => on));
    return `${param}(${[JSON.stringify(token), JSON.stringify(set), ...(element ? ["true"] : [])].join(", ")})`;
  }

  /** Fragmento para la cadena `ɵangular.module(...)` (o el módulo raíz de la plataforma): `ɵresolve` contra el `$injector` de la app. */
  static factoryFragment(): string {
    return `.factory(${JSON.stringify(ResolveDependency.TOKEN)}, ["$injector", function ($injector) { return function (name, flags, element) {
    flags = flags || {};
    var bounded = element && (flags.self || flags.host);
    if (!bounded && $injector.has(name)) return $injector.get(name);
    if (flags.optional) return null;
    throw new Error("ɵresolve: no hay provider para \\"" + name + "\\"" + (bounded ? " con { " + (flags.self ? "self" : "host") + ": true } (sin injector de elemento)" : "") + ".");
  }; }])`;
  }
}
