import { FactoryCode } from "@/compiler/factory-code.ts";
import type { InjectDep, InjectFlags, ProviderMetadata } from "@/metadata/decorator-metadata.ts";

/**
 * `providers` de `@Component`/`@Directive` → `ClassName.ɵfac.ɵproviders = [...]` (colgado del MISMO array
 * que ya es `controller:` en `ModuleWriter` — así `ScopedInjectorRuntime` los lee de `expression.ɵproviders`
 * sin necesitar buscar la clase por otro lado). Son recetas para resolver LAZY, por instancia de elemento —
 * a diferencia de `ModuleWriter.providerCall` (`providers` de `@NgModule`), que registra de una en el
 * `$injector` global apenas se arma el módulo.
 */
export class ScopedProviders {
  static hasAny(providers: ProviderMetadata[]): boolean {
    return providers.length > 0;
  }

  static statement(className: string, providers: ProviderMetadata[]): string {
    ScopedProviders.assertNoMultiMix(className, providers);
    return `${className}.ɵfac.ɵproviders = [${providers.map(ScopedProviders.entry).join(", ")}];`;
  }

  /** Mismo criterio que `ModuleWriter.providerCalls`: mezclar multi/no-multi para el mismo token es error. */
  private static assertNoMultiMix(className: string, providers: ProviderMetadata[]): void {
    const seen = new Map<string, boolean>();
    for (const provider of providers) {
      const isMulti = provider.kind !== "class" && provider.multi;
      const previous = seen.get(provider.token);
      if (previous !== undefined && previous !== isMulti) {
        throw new Error(`ScopedProviders: "${className}" mezcla providers multi y no-multi para el token "${provider.token}".`);
      }
      seen.set(provider.token, isMulti);
    }
  }

  private static entry(provider: ProviderMetadata): string {
    const token = JSON.stringify(provider.token);
    const multi = provider.kind !== "class" && provider.multi ? ", multi: true" : "";

    switch (provider.kind) {
      case "class":
        return `{ token: ${token}, kind: "class", ctor: ${provider.classExpr} }`;
      case "constructor":
      case "useClass": {
        // Flags en `deps` (`[new Optional(), X]`): se construye con un wrapper (`FactoryCode`), como un `useFactory`.
        if (provider.deps && !FactoryCode.isPlain(provider.depFlags, undefined)) {
          const ctor = /^[\w$]+$/.test(provider.classExpr) ? provider.classExpr : `(${provider.classExpr})`;
          return ScopedProviders.wrappedFactory(token, provider.deps, provider.depFlags, undefined, (args) => `new ${ctor}(${args})`, multi);
        }
        const deps = provider.deps ? `, deps: ${JSON.stringify(provider.deps)}` : "";
        return `{ token: ${token}, kind: ${JSON.stringify(provider.kind)}, ctor: ${provider.classExpr}${deps}${multi} }`;
      }
      case "useValue":
        return `{ token: ${token}, kind: "useValue", value: ${provider.valueExpr}${multi} }`;
      case "useFactory":
        if (!FactoryCode.isPlain(provider.depFlags, provider.injectTokens)) {
          const factoryExpr = provider.factoryExpr;
          return ScopedProviders.wrappedFactory(token, provider.deps, provider.depFlags, provider.injectTokens, (args) => `(${factoryExpr})(${args})`, multi);
        }
        return `{ token: ${token}, kind: "useFactory", factory: ${provider.factoryExpr}, deps: ${JSON.stringify(provider.deps)}${multi} }`;
      case "useExisting":
        return `{ token: ${token}, kind: "useExisting", existing: ${JSON.stringify(provider.existingToken)}${multi} }`;
    }
  }

  /**
   * Receta `useFactory` con el wrapper de `FactoryCode`: el nodo resuelve `deps` (también `ɵresolve`, contra su
   * cadena) y llama al wrapper (`FactoryCode`), que expone los `inject()` del factory mientras corre.
   */
  private static wrappedFactory(
    token: string,
    deps: string[],
    depFlags: InjectFlags[] | undefined,
    injectTokens: InjectDep[] | undefined,
    call: (args: string) => string,
    multi: string,
  ): string {
    const names = FactoryCode.depNames(deps, depFlags, injectTokens);
    return `{ token: ${token}, kind: "useFactory", factory: ${FactoryCode.wrapper(deps, depFlags, injectTokens, call)}, deps: [${names.join(", ")}]${multi} }`;
  }
}
