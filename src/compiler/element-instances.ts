import { ClassHierarchy } from "@/compiler/class-hierarchy.ts";
import { SelectorParser } from "@/compiler/selector-parser.ts";
import { TokenName } from "@/compiler/token-name.ts";
import type { DecoratorMetadata, InjectFlags } from "@/metadata/decorator-metadata.ts";
import { MetadataStore } from "@/metadata/metadata-store.ts";

type ClassMetadata = DecoratorMetadata;

/** jqLite `data()` que cada `@Component` deja en su elemento (valor: el propio elemento) — el límite de `@Host`. */
export const HOST_DATA_KEY = "$ngjsHost";

/**
 * Inyectar una directiva/componente (`constructor(tabs: TabsComponent)`, `@Host() parent: ParentDirective`,
 * `inject(BaseTabs)`) — la versión de build de lo que `ngjs-core` hace en runtime (`registerInstance` en el
 * `ElementInjectorNode` + el fallback `$element.controller()` + `getControllerTokens`). En build se sabe qué
 * tokens son clases `@Component`/`@Directive` del proyecto (también sus bases, vía `ClassHierarchy`) y con qué
 * nombre las registra AngularJS; así que esa dep no pasa por DI: el `ɵfac` la lee del dato que AngularJS ya guarda
 * en cada elemento con un controller (`$<nombre>Controller`, lo mismo que usa `require`), con los flags:
 * sin flags = el elemento y sus ancestros; `self` = solo el propio; `skipSelf` = desde el padre; `host` = hasta el
 * componente host (un componente es su propio host); `optional` = `null` si no aparece.
 */
export class ElementInstances {
  /**
   * Nombres de registro de AngularJS de todas las clases elemento del proyecto que SON `token` o lo extienden;
   * `undefined` si `token` no es una clase elemento (entonces es una dep de DI común).
   */
  static namesFor(token: string): string[] | undefined {
    const names = new Set<string>();
    for (const [, metadata] of MetadataStore.entries()) {
      for (const candidate of metadata) {
        if (candidate.kind !== "component" && candidate.kind !== "directive") continue;
        const { selector } = candidate.options as { selector?: string };
        if (!selector) continue; // `@Directive()` abstracta: nunca está en un elemento
        const tokens = ClassHierarchy.chain(candidate).map((member) => ElementInstances.tokenOf(member));
        if (!tokens.includes(token)) continue;
        for (const parsed of SelectorParser.parse(selector)) names.add(parsed.registrationName);
      }
    }
    return names.size ? [...names] : undefined;
  }

  /** La expresión que da la instancia al construir (dentro del `ɵfac` de un elemento, con `$element` a mano). */
  static value(names: string[], flags: InjectFlags | undefined, isComponent: boolean): string {
    const set = Object.fromEntries(Object.entries(flags ?? {}).filter(([, on]) => on));
    return `ɵelementInstance($element, ${JSON.stringify(names)}, ${JSON.stringify(set)}, ${isComponent})`;
  }

  /**
   * El helper que usa `value()` — texto plano a nivel de archivo (una declaración de función: se eleva). Lo que
   * AngularJS guarda de un controller del MISMO elemento que todavía no se construyó es un objeto vacío: si trae
   * `ɵngjsBuild` (`lazyControllerSource`), se construye ahí, antes que quien lo pide — como el injector de nodo de Angular.
   */
  static helperSource(): string {
    const host = JSON.stringify(HOST_DATA_KEY);
    const build = JSON.stringify(ElementInstances.BUILD_KEY);
    return `function ɵelementInstance($element, names, flags, isComponent) {
  var read = function (el) { for (var i = 0; i < names.length; i++) { var found = el.data("$" + names[i] + "Controller"); if (found) return typeof found[${build}] === "function" ? found[${build}]() : found; } return undefined; };
  var boundary = isComponent ? $element[0] : $element.parent().inheritedData(${host});
  for (var el = flags.skipSelf ? $element.parent() : $element; el && el.length; el = el.parent()) {
    var found = read(el);
    if (found) return found;
    if (flags.self || (flags.host && boundary && el[0] === boundary)) break;
  }
  if (flags.optional) return null;
  throw new Error("No hay una instancia de " + names.join("/") + (flags.self ? " en este elemento" : flags.host ? " entre este elemento y su host" : " en este elemento ni en sus ancestros") + ".");
}`;
  }

  private static readonly BUILD_KEY = "ɵngjsBuild";

  /**
   * AngularJS arma los controllers de un elemento en dos tiempos: primero guarda en el elemento un objeto vacío por
   * cada uno (`$controller(..., later = true)`) y después los construye en el orden de las directivas — así que
   * inyectar una directiva/componente del mismo elemento que va después daba ese objeto vacío. Este decorador de
   * `$controller` le cuelga al objeto vacío de cada `ɵfac` compilado (`ɵtype`) la construcción, memorizada:
   * `ɵelementInstance` la llama cuando lo encuentra, y cuando AngularJS llega a ese controller recibe la misma instancia.
   * Un ciclo (A pide B y B pide A) es error, como `NG0200` de Angular.
   *
   * Texto plano a nivel de módulo; lo estampa cada `@NgModule` si alguna clase elemento del proyecto inyecta otra
   * (`ApplicationScanner.usesElementInstances`), y se instala una sola vez por app (marca en el `$injector`).
   */
  static lazyControllerSource(): string {
    const build = JSON.stringify(ElementInstances.BUILD_KEY);
    return `function ɵlazyController($delegate, $injector) {
  if ($injector.ɵngjsLazyController) return $delegate;
  $injector.ɵngjsLazyController = true;
  return function (expression, locals, later, ident) {
    var init = $delegate.apply(this, arguments);
    if (!later || !expression || !expression.ɵtype || typeof init !== "function" || !init.instance) return init;
    var state = 0, built;
    var lazy = function () {
      if (state === 2) return built;
      if (state === 1) throw new Error("NG0200: dependencia circular — \\"" + expression.ɵtype.name + "\\" se pidió a sí misma mientras se construía (directivas del mismo elemento que se inyectan entre sí).");
      state = 1;
      try { built = init(); state = 2; } finally { if (state !== 2) state = 0; }
      return built;
    };
    Object.defineProperty(init.instance, ${build}, { value: lazy, configurable: true });
    lazy.instance = init.instance;
    lazy.identifier = init.identifier;
    return lazy;
  };
}`;
  }

  /** Fragmento para la cadena `ɵangular.module(...)`: decora `$controller` (una vez por app). */
  static decoratorFragment(): string {
    return '.decorator("$controller", ["$delegate", "$injector", ɵlazyController])';
  }

  /** El mismo nombre de DI que `TokenName` le da a la clase en cada archivo que la usa como tipo. */
  private static tokenOf(metadata: ClassMetadata): string {
    const path = MetadataStore.entries().find(([, list]) => list.includes(metadata))?.[0] ?? "";
    return metadata.local ? TokenName.local(metadata.className, path) : TokenName.of(metadata.className, TokenName.packageOf(path));
  }
}
