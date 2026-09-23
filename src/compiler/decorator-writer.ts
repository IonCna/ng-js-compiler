import { ClassHierarchy } from "@/compiler/class-hierarchy.ts";
import { ElementInstances, HOST_DATA_KEY } from "@/compiler/element-instances.ts";
import { FactoryCode } from "@/compiler/factory-code.ts";
import { HostWiring } from "@/compiler/host-wiring.ts";
import { InjectedValues } from "@/compiler/injected-values.ts";
import { LifecycleWiring } from "@/compiler/lifecycle-wiring.ts";
import type { NgjsTransform } from "@/compiler/ngjs-transform.ts";
import { ResolveDependency } from "@/compiler/resolve-dependency.ts";
import { PlatformCode } from "@/compiler/platform-code.ts";
import { ScopedProviders } from "@/compiler/scoped-providers.ts";
import { SelectorParser } from "@/compiler/selector-parser.ts";
import type {
  ComponentMetadata,
  DecoratorMetadata,
  DirectiveMetadata,
  HostDirectiveMetadata,
  InjectDep,
  InjectFlags,
  PipeMetadata,
  QueryMetadata,
  ServiceMetadata,
} from "@/metadata/decorator-metadata.ts";
import { MetadataStore } from "@/metadata/metadata-store.ts";

type BindingsCarrier = ComponentMetadata | DirectiveMetadata;
type WritableMetadata = DecoratorMetadata;

/**
 * Fase 2: lee lo que guardó `DecoratorReader` en `MetadataStore` y estampa en
 * la clase los mismos campos estáticos que emite el compilador AOT (Ivy) de
 * Angular, con valores que AngularJS usa directo — nada que otro runtime
 * tenga que leer o traducir:
 * - `ClassName.ɵfac` — factory con anotación en array de AngularJS:
 *   `["Dep_hash", ..., function X_Factory(a0, ...) { return new X(a0, ...); }]`.
 *   Los nombres de DI ya vienen resueltos (`TokenName`). Es lo que `ModuleWriter`
 *   registra (`controller:`, factory de servicio, instancia de pipe, instancia del `@NgModule`).
 * - `ClassName.ɵprov` — `{ token, providedIn? }` de `@Injectable`/`@Service`; con `providedIn: "root"` además se
 *   anota en la cola de la plataforma (`PlatformCode.rootProviderStatement`).
 * - `ClassName.ɵcmp`/`ɵdir` — `{ selectors, inputs, outputs, exportAs? }` con
 *   la forma de Ivy (`selectors` en arrays, `inputs`/`outputs` como mapa
 *   nombre público → propiedad). Dato: la registración la arma `ModuleWriter`
 *   desde la metadata.
 * - `ClassName.ɵpipe` — `{ name, pure }`.
 */
export class DecoratorWriter {
  static write(code: string, path: string): string | undefined {
    const statements = MetadataStore.get(path).flatMap((metadata) => DecoratorWriter.statementsFor(metadata));
    // Una directiva/componente inyectada se lee del elemento con este helper (`ElementInstances`), uno por archivo.
    if (statements.some((statement) => statement.includes("ɵelementInstance("))) statements.push(ElementInstances.helperSource());
    return statements.length ? `${code}\n${statements.join("\n")}\n` : undefined;
  }

  private static statementsFor(declared: WritableMetadata): string[] {
    // Con lo heredado de sus bases del proyecto (constructor, bindings, lifecycle) — ver `ClassHierarchy`.
    const metadata = ClassHierarchy.effective(declared);
    // Import de efecto por cada archivo del que viene una dependencia del constructor: que se evalúe (y registre).
    const statements = [
      ...metadata.constructorImports.map((specifier) => `import ${JSON.stringify(specifier)};`),
      DecoratorWriter.facStatement(metadata, ClassHierarchy.injectsByClass(declared)),
    ];

    switch (metadata.kind) {
      case "component":
        statements.push(DecoratorWriter.defStatement(metadata, "ɵcmp"));
        // Marca de componente en el mismo array que es `controller:` — el injector por elemento la usa como límite de `@Host`.
        statements.push(`${metadata.className}.ɵfac.ɵcomponent = true;`);
        break;
      case "directive":
        statements.push(DecoratorWriter.defStatement(metadata, "ɵdir"));
        break;
      case "pipe":
        statements.push(DecoratorWriter.pipeStatement(metadata));
        break;
      case "ngmodule":
        // Solo `ɵfac`: `ɵmod` y la registración (con la instancia eager) los emite `ModuleWriter`.
        break;
      default:
        statements.push(DecoratorWriter.provStatement(metadata));
    }

    if (metadata.kind === "component" || metadata.kind === "directive") {
      if (ScopedProviders.hasAny(metadata.providers)) statements.push(ScopedProviders.statement(metadata.className, metadata.providers));
      if (LifecycleWiring.hasAny(metadata.lifecycleHooks)) {
        statements.push(...LifecycleWiring.statements(metadata.className, metadata.lifecycleHooks, metadata.inputs));
      }
    }

    return statements;
  }

  /**
   * `a0, a1, ...` en vez de los nombres originales del constructor — el factory solo los pasa en orden.
   * `@Component`/`@Directive` SIEMPRE agregan `$element`/`$scope` (`HostWiring.FACTORY_DEPS`) y envuelven la
   * instancia, tengan o no `@HostBinding`/`@HostListener` — gratis (`$compile` ya los arma en `locals` para
   * cualquier controller, se pidan o no), así que no hace falta detectar nada de antemano para tenerlos
   * disponibles. `@Injectable`/`@Pipe` no son controllers de AngularJS — quedan con el factory de siempre.
   *
   * `injects`: los `inject()` de construcción de la clase Y sus bases (`ClassHierarchy.injectsByClass`), cada grupo
   * expuesto con la clave de la clase que lo declara — los campos de la base leen lo suyo aunque vivan en otro archivo.
   */
  private static facStatement(metadata: WritableMetadata, injects: { owner: string; tokens: InjectDep[] }[]): string {
    const { className, constructorTokens, constructorFlags, constructorAttributes } = metadata;
    const injectTokens = injects.flatMap(({ tokens }) => tokens);
    // Flags (`@Optional()`/`@Self()`/…): se pide `ɵresolve` y se le pasa el token al construir (ver `ResolveDependency`).
    // En `@Component`/`@Directive` se avisa que es una clase de elemento (cambia `self` sin injector de elemento).
    const isElement = metadata.kind === "component" || metadata.kind === "directive";
    const depName = (token: string, flags: InjectFlags | undefined) => ResolveDependency.depName(token, flags);
    const value = (param: string, token: string, flags: InjectFlags | undefined) => ResolveDependency.value(param, token, flags, isElement);
    // `@Attribute("x")` no es DI: se lee del host (`$element`, que `@Component`/`@Directive` siempre reciben).
    const attributeOf = (index: number) => constructorAttributes[index] ?? null;
    // Una directiva/componente como token no es DI: se lee del elemento (`ElementInstances`) — solo en un elemento.
    const instanceNames = (token: string) => (isElement ? ElementInstances.namesFor(token) : undefined);
    const diIndexes = constructorTokens
      .map((_, index) => index)
      .filter((index) => attributeOf(index) === null && !instanceNames(constructorTokens[index]!));

    const ctorParams = diIndexes.map((index) => `a${index}`);
    const ctorArgs = constructorTokens
      .map((token, index) => {
        const attribute = attributeOf(index);
        if (attribute !== null) return `$element[0].getAttribute(${JSON.stringify(attribute)})`;
        const names = instanceNames(token);
        return names ? ElementInstances.value(names, constructorFlags[index], metadata.kind === "component") : value(`a${index}`, token, constructorFlags[index]);
      })
      .join(", ");
    // `inject()` durante la construcción: más deps del `ɵfac` (`i0, i1, ...`), expuestas mientras corre el `new` (`InjectedValues`).
    const injectedDi = injectTokens.filter(({ token }) => !instanceNames(token));
    const injectParams = injectedDi.map((_, index) => `i${index}`);
    const deps = [
      ...diIndexes.map((index) => depName(constructorTokens[index]!, constructorFlags[index])),
      ...injectedDi.map(({ token, flags }) => depName(token, flags)),
    ];
    const params = [...ctorParams, ...injectParams].join(", ");
    const construct = (assign: string) => {
      const statement = `${assign}new ${className}(${ctorArgs});`;
      if (!injectTokens.length) return statement;
      let next = 0;
      const injectedValue = ({ token, flags }: InjectDep) => {
        const names = instanceNames(token);
        return names ? ElementInstances.value(names, flags, metadata.kind === "component") : value(`i${next++}`, token, flags);
      };
      const byOwner = Object.fromEntries(injects.map(({ owner, tokens }) => [owner, tokens.map(injectedValue)]));
      return InjectedValues.around(byOwner, statement);
    };

    if (metadata.kind !== "component" && metadata.kind !== "directive") {
      const factory = `function ${className}_Factory(${params}) { ${injectTokens.length ? construct("var instance = ") + " return instance;" : construct("return ")} }`;
      return `${className}.ɵfac = [${[...deps, factory].join(", ")}];`;
    }

    const guard = DecoratorWriter.tagGuardStatement(metadata);
    const wiring = HostWiring.hasAny(metadata) ? HostWiring.statements(metadata, className) : [];
    const factoryParams = [params, ...HostWiring.FACTORY_DEPS].filter((param) => param.length > 0).join(", ");
    // Un componente marca su elemento como límite de `@Host` para lo que se construya adentro (`HOST_DATA_KEY`).
    const hostMark = metadata.kind === "component" ? `$element.data(${JSON.stringify(HOST_DATA_KEY)}, $element[0]);` : "";
    const body = [guard, hostMark, construct("var instance = "), ...wiring, "return instance;"].filter(Boolean).join(" ");
    const allDeps = [...deps, ...HostWiring.FACTORY_DEPS.map((dep) => JSON.stringify(dep))];

    return `${className}.ɵfac = [${[...allDeps, `function ${className}_Factory(${factoryParams}) { ${body} }`].join(", ")}];`;
  }

  /**
   * `tag[atributo]` se registra bajo el atributo (`SelectorParser`) — AngularJS matchea por nombre, no sabe
   * filtrar por tag a la vez, así que `bindToController`/el controller se instanciarían igual en cualquier
   * elemento con ese atributo. El único punto donde SÍ se puede decidir es acá: el factory recién construye
   * la instancia real si el tag matchea; si no, devuelve un objeto vacío — `bindToController` pisa props ahí
   * sin que nadie las lea, y el constructor real (con toda su lógica) nunca corre.
   *
   * Con lista por coma (`"button[x], label[x]"`) TODAS las alternativas comparten este mismo `ɵfac` — el
   * guard acepta cualquiera de los tags exigidos (unión), no uno solo. Si ALGUNA alternativa no exige tag
   * (`[attr]` simple mezclado con una compuesta), no se puede armar ningún guard sin romper esa alternativa
   * sin restricción — nadie sabe, al construir, cuál nombre de la lista fue el que realmente matcheó.
   *
   * Si `SelectorParser` no reconoce el selector (`attr=value` — sí lo entiende `ivySelectors` de
   * `defStatement`, un parser aparte para el estampado Ivy) no es cosa de esta función decidir que está
   * mal: sin guard, y que lo valide quien corresponda más adelante en el pipeline.
   */
  private static tagGuardStatement(metadata: BindingsCarrier): string {
    const { selector } = metadata.options as { selector: string };
    const requiredTags = DecoratorWriter.tryParseRequiredTags(selector);
    if (!requiredTags) return "";

    const tags = JSON.stringify(requiredTags.map((tag) => tag.toLowerCase()));
    const warning = JSON.stringify(`${metadata.className}: este selector requiere <${requiredTags.join("> o <")}>, no se aplica en <`);
    return `if (${tags}.indexOf($element[0].tagName.toLowerCase()) === -1) { console.warn(${warning} + $element[0].tagName.toLowerCase() + ">."); return {}; }`;
  }

  /** `undefined` = sin guard: selector no parseable acá, o alguna alternativa de la lista no exige tag. */
  private static tryParseRequiredTags(selector: string): string[] | undefined {
    let alternatives;
    try {
      alternatives = SelectorParser.parse(selector);
    } catch {
      return undefined;
    }

    const tags = alternatives.map((parsed) => parsed.requiredTag);
    if (tags.some((tag) => tag === undefined)) return undefined;
    return [...new Set(tags as string[])];
  }

  /**
   * `ɵprov = { token, providedIn?, factory? }` — `factory` solo con receta (`@Injectable({ useFactory, ... })`,
   * como Ivy): es lo que se usa cuando la clase se provee sola (`providers: [X]`, `providedIn: "root"`); sin
   * receta, su `ɵfac`.
   */
  private static provStatement(metadata: ServiceMetadata): string {
    const { providedIn } = metadata.options as { providedIn?: unknown };
    const { className, token, recipe } = metadata;
    const fields = [`token: ${JSON.stringify(token)}`, ...(providedIn === "root" ? ['providedIn: "root"'] : []), ...(recipe ? [`factory: ${FactoryCode.forRecipe(recipe)}`] : [])];
    const prov = `${className}.ɵprov = { ${fields.join(", ")} };`;
    if (providedIn !== "root") return prov;
    return `${prov}\n${PlatformCode.rootProviderStatement(token, recipe ? `${className}.ɵprov.factory` : `${className}.ɵfac`)}`;
  }

  private static defStatement(metadata: BindingsCarrier, field: "ɵcmp" | "ɵdir"): string {
    const { selector, exportAs } = metadata.options as { selector?: string; exportAs?: string };

    const def: Record<string, unknown> = {
      selectors: DecoratorWriter.ivySelectors(metadata.className, selector, field === "ɵdir"),
      inputs: DecoratorWriter.publicToProperty(metadata.inputs),
      outputs: DecoratorWriter.publicToProperty(metadata.outputs),
    };
    if (exportAs) def.exportAs = exportAs.split(",").map((name) => name.trim());

    const fields = Object.entries(def).map(([key, value]) => `${key}: ${JSON.stringify(value)}`);
    // Solo la definición, como Ivy (`ɵɵngDeclareComponent`); resolverlas/aplicarlas es del runtime.
    const contentQueries = metadata.queries.filter((query) => query.kind === "content");
    const viewQueries = metadata.queries.filter((query) => query.kind === "view");
    if (contentQueries.length) fields.push(`queries: [${contentQueries.map(DecoratorWriter.queryDef).join(", ")}]`);
    if (viewQueries.length) fields.push(`viewQueries: [${viewQueries.map(DecoratorWriter.queryDef).join(", ")}]`);
    if (metadata.hostDirectives.length) fields.push(`hostDirectives: [${metadata.hostDirectives.map(DecoratorWriter.hostDirectiveDef).join(", ")}]`);
    return `${metadata.className}.${field} = { ${fields.join(", ")} };`;
  }

  /**
   * Una query como dato. Las clases (`predicate`, `read`) van como getters: se leen como un valor, pero se resuelven
   * al usarse — una clase declarada más abajo o un import circular (lo que `forwardRef` cubre) no llegan `undefined`.
   */
  private static queryDef(query: QueryMetadata): string {
    const fields = [
      `propertyName: ${JSON.stringify(query.propertyName)}`,
      `first: ${query.first}`,
      `descendants: ${query.descendants}`,
      `static: ${query.static}`,
      query.predicate.kind === "names" ? `predicate: ${JSON.stringify(query.predicate.names)}` : `get predicate() { return ${query.predicate.expr}; }`,
      ...(query.readExpr ? [`get read() { return ${query.readExpr}; }`] : []),
    ];
    return `{ ${fields.join(", ")} }`;
  }

  /** `{ directive, inputs?, outputs? }` — la forma larga siempre; la clase como getter (ver `queryDef`). */
  private static hostDirectiveDef(hostDirective: HostDirectiveMetadata): string {
    const fields = [
      `get directive() { return ${hostDirective.directiveExpr}; }`,
      ...(hostDirective.inputs ? [`inputs: ${JSON.stringify(hostDirective.inputs)}`] : []),
      ...(hostDirective.outputs ? [`outputs: ${JSON.stringify(hostDirective.outputs)}`] : []),
    ];
    return `{ ${fields.join(", ")} }`;
  }

  private static pipeStatement(metadata: PipeMetadata): string {
    const { name, pure } = metadata.options as { name?: string; pure?: boolean };
    return `${metadata.className}.ɵpipe = { name: ${JSON.stringify(name)}, pure: ${JSON.stringify(pure ?? true)} };`;
  }

  /** Ivy: `{ nombrePúblico: "propiedad" }` — `@Input("aka") alias` → `{ aka: "alias" }`. */
  private static publicToProperty(bindings: { propName: string; bindingName: string }[]): Record<string, string> {
    return Object.fromEntries(bindings.map(({ propName, bindingName }) => [bindingName, propName]));
  }

  /**
   * Ivy: un array por selector de la lista (`a, b`), cada uno `[tag, attr, valor, ...]` —
   * `"app-card"` → `[["app-card"]]`, `"[appFoo]"` → `[["", "appFoo", ""]]`,
   * `"button[type=submit]"` → `[["button", "type", "submit"]]`. Clases/`:not()` no se soportan todavía.
   * `@Directive()` sin selector es una base abstracta (Angular): `selectors: []`, no se declara en ningún módulo.
   */
  private static ivySelectors(className: string, selector: string | undefined, abstract: boolean): string[][] {
    if (!selector && abstract) return [];
    if (!selector) throw new Error(`DecoratorWriter: "${className}" no tiene selector.`);

    return selector.split(",").map((part) => {
      const match = /^([a-zA-Z][\w-]*)?((?:\[[^\]=]+(?:=[^\]]*)?\])*)$/.exec(part.trim());
      if (!match) throw new Error(`DecoratorWriter: "${className}" — selector ${JSON.stringify(selector)} no soportado todavía.`);

      const attributes = [...(match[2] ?? "").matchAll(/\[([^\]=]+)(?:=([^\]]*))?\]/g)].flatMap(([, name, value]) => [
        name!.trim(),
        (value ?? "").trim().replace(/^["']|["']$/g, ""),
      ]);
      return [match[1] ?? "", ...attributes];
    });
  }
}

export const decoratorWriterTransform: NgjsTransform = {
  transform: (code, path) => Promise.resolve(DecoratorWriter.write(code, path)),
};
