import { InjectedValues } from "@/compiler/injected-values.ts";
import { ResolveDependency } from "@/compiler/resolve-dependency.ts";
import type { InjectDep, InjectFlags, ProviderMetadata } from "@/metadata/decorator-metadata.ts";

/**
 * Factory de un provider con `deps` en la forma de AngularJS (`[nombres..., function (a0, ..., i0, ...) {...}]`),
 * compartido por `ModuleWriter` (providers de `@NgModule`), `ScopedProviders` (providers de `@Component`) y el
 * `ɵprov.factory` de `@Injectable`/`InjectionToken`:
 * - `depFlags` (`[new Optional(), new Self(), X]`): esa dep se pide como `ɵresolve` y se llama con el token y los
 *   flags (`ResolveDependency`).
 * - `injectTokens` (`inject()` en el cuerpo del factory, ya reemplazado — `InjectedValues`): deps extra `i0, i1, ...`,
 *   expuestas mientras corre el factory — mismo mecanismo que el `ɵfac` de una clase.
 */
export class FactoryCode {
  /** Sin nada de lo anterior, el factory del usuario sirve tal cual con sus `deps`. */
  static isPlain(depFlags: InjectFlags[] | undefined, injectTokens: InjectDep[] | undefined): boolean {
    return !depFlags?.some(ResolveDependency.hasFlags) && !injectTokens?.length;
  }

  /** Nombres de DI (JSON) de la anotación, en el orden de los parámetros del wrapper. */
  static depNames(deps: string[], depFlags: InjectFlags[] | undefined, injectTokens: InjectDep[] | undefined): string[] {
    return [
      ...deps.map((token, index) => ResolveDependency.depName(token, depFlags?.[index])),
      ...(injectTokens ?? []).map(({ token, flags }) => ResolveDependency.depName(token, flags)),
    ];
  }

  /** `function (a0, ..., i0, ...) { ... return <call(args)>; }` — `args` son los valores de `deps`, ya resueltos. */
  static wrapper(deps: string[], depFlags: InjectFlags[] | undefined, injectTokens: InjectDep[] | undefined, call: (args: string) => string): string {
    const injected = injectTokens ?? [];
    const params = [...deps.map((_, index) => `a${index}`), ...injected.map((_, index) => `i${index}`)].join(", ");
    const args = deps.map((token, index) => ResolveDependency.value(`a${index}`, token, depFlags?.[index])).join(", ");
    if (!injected.length) return `function (${params}) { return ${call(args)}; }`;

    const values = injected.map(({ token, flags }, index) => ResolveDependency.value(`i${index}`, token, flags));
    return `function (${params}) { ${InjectedValues.around({ [InjectedValues.FACTORY]: values }, `return ${call(args)};`)} }`;
  }

  /** Anotación completa (`[nombres..., wrapper]`), como la recibe `.factory()`. */
  static array(deps: string[], depFlags: InjectFlags[] | undefined, injectTokens: InjectDep[] | undefined, call: (args: string) => string): string {
    return `[${[...FactoryCode.depNames(deps, depFlags, injectTokens), FactoryCode.wrapper(deps, depFlags, injectTokens, call)].join(", ")}]`;
  }

  /**
   * El `ɵfac` PROPIO de `cls` (un estático de JS se hereda: el de la base construiría a la base). Sin `ɵfac` en
   * ningún lado, una clase sin decorador se construye sin argumentos; con uno heredado es error al registrar — una
   * subclase provista con DI heredada tiene que llevar `@Injectable()`, como pide Angular.
   */
  static ownFactory(cls: string): string {
    const inherited = `(function () { throw new Error("\\"" + ${cls}.name + "\\" hereda el factory de su clase padre — agregale @Injectable() (Angular también lo exige)."); })()`;
    return `(Object.prototype.hasOwnProperty.call(${cls}, "ɵfac") ? ${cls}.ɵfac : ${cls}.ɵfac ? ${inherited} : [function () { return new ${cls}(); }])`;
  }

  /**
   * Una receta completa como anotación (`[nombres..., fn]`) — el `ɵprov.factory` de `@Injectable({ use* })`. A
   * diferencia de `ModuleWriter.providerCall` no hay `.value()`: `useValue` también es un factory.
   */
  static forRecipe(provider: ProviderMetadata): string {
    switch (provider.kind) {
      case "useValue":
        return `[function () { return (${provider.valueExpr}); }]`;
      case "useFactory":
        return FactoryCode.array(provider.deps, provider.depFlags, provider.injectTokens, (args) => `(${provider.factoryExpr})(${args})`);
      case "useExisting":
        return `[${JSON.stringify(provider.existingToken)}, function (existing) { return existing; }]`;
      default: {
        const cls = /^[\w$]+$/.test(provider.classExpr) ? provider.classExpr : `(${provider.classExpr})`;
        const deps = provider.kind === "class" ? undefined : provider.deps;
        // Se resuelve al llamar, no al definir: la clase puede estar declarada más abajo (`forwardRef`) y, si
        // extiende a la que lleva la receta, antes de su propio `ɵfac` heredaría el del padre (estático de JS).
        if (!deps) {
          return `["$injector", function ($injector) { return $injector.invoke(Object.prototype.hasOwnProperty.call(${cls}, "ɵfac") ? ${cls}.ɵfac : [function () { return new ${cls}(); }]); }]`;
        }
        return FactoryCode.array(deps, provider.kind === "class" ? undefined : provider.depFlags, undefined, (args) => `new ${cls}(${args})`);
      }
    }
  }
}
