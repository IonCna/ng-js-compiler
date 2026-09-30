import { ClassHierarchy } from "@/compiler/class-hierarchy.ts";
import { ComponentDefinition } from "@/compiler/component-definition.ts";
import { ElementInstances, HOST_DATA_KEY } from "@/compiler/element-instances.ts";
import { FactoryCode } from "@/compiler/factory-code.ts";
import { HostWiring } from "@/compiler/host-wiring.ts";
import { InheritedDefinition } from "@/compiler/inherited-definition.ts";
import { InheritedFactory } from "@/compiler/inherited-factory.ts";
import { InjectedValues } from "@/compiler/injected-values.ts";
import { InputTransforms } from "@/compiler/input-transforms.ts";
import { LifecycleWiring } from "@/compiler/lifecycle-wiring.ts";
import { CodeEdit } from "@/compiler/code-edit.ts";
import type { NgjsTransform, TransformOutput } from "@/compiler/ngjs-transform.ts";
import { ResolveDependency } from "@/compiler/resolve-dependency.ts";
import { PlatformCode } from "@/compiler/platform-code.ts";
import { ScopedProviders } from "@/compiler/scoped-providers.ts";
import { type CompoundSelector, type ParsedSelector, SelectorParser } from "@/compiler/selector-parser.ts";
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
    return DecoratorWriter.writeWithMap(code, path)?.code;
  }

  /** `write()` con su source map: lo generado va al final, el código original no se mueve. */
  static writeWithMap(code: string, path: string): TransformOutput | undefined {
    const statements = MetadataStore.get(path).flatMap((metadata) => DecoratorWriter.statementsFor(metadata));
    // Una directiva/componente inyectada se lee del elemento con este helper (`ElementInstances`), uno por archivo.
    if (statements.some((statement) => statement.includes("ɵelementInstance("))) statements.push(ElementInstances.helperSource());
    // El constructor heredado de una base de otro paquete se arma en runtime (`InheritedFactory`), uno por archivo.
    if (statements.some((statement) => statement.includes(`${InheritedFactory.NAME}(`))) statements.push(InheritedFactory.helperSource());
    if (statements.some((statement) => statement.includes(`${InheritedDefinition.NAME}(`))) statements.push(InheritedDefinition.helperSource());
    if (statements.some((statement) => statement.includes("ɵselectorAttr(") || statement.includes("ɵselectorClass("))) statements.push(DecoratorWriter.selectorHelperSource());
    if (statements.some((statement) => statement.includes("ɵtransformInput(") || statement.includes("ɵinputTransform("))) {
      statements.push(InputTransforms.helperSource());
    }
    return statements.length ? CodeEdit.append(code, path, `\n${statements.join("\n")}\n`) : undefined;
  }

  private static statementsFor(declared: WritableMetadata): string[] {
    // Con lo heredado de sus bases del proyecto (constructor, bindings, lifecycle) — ver `ClassHierarchy`.
    const metadata = ClassHierarchy.effective(declared);
    // Import de efecto por cada archivo del que viene una dependencia del constructor: que se evalúe (y registre).
    const statements = [
      ...metadata.constructorImports.map((specifier) => `import ${JSON.stringify(specifier)};`),
      DecoratorWriter.facStatement(metadata, ClassHierarchy.injectsByClass(declared), ClassHierarchy.externalConstructorHops(declared)),
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

    if (declared.kind === "component" || declared.kind === "directive") {
      // La definición de una base de otro paquete se suma en runtime (`InheritedDefinition`), antes de registrarse.
      const hops = ClassHierarchy.externalBaseHops(declared);
      if (hops !== undefined) statements.push(InheritedDefinition.statement(declared.className, hops, declared.kind === "component" ? "ɵcmp" : "ɵdir"));
      // Solo los `transform` que declara esta clase (en su archivo); los heredados se buscan en su base.
      const transforms = InputTransforms.declarationStatement(declared.className, declared.inputs);
      if (transforms) statements.push(transforms);
    }

    if (metadata.kind === "component" || metadata.kind === "directive") {
      // La clase, colgada del array que recibe `$controller` (como el `type` de Ivy): quien intercepta `$controller`
      // sabe QUÉ va a construir antes de construirlo (el runtime lo necesita para `hostDirectives`).
      statements.push(`${metadata.className}.ɵfac.ɵtype = ${metadata.className};`);
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
   *
   * Como el `t` del factory de Ivy, construye `this.ɵT` si se lo piden (`InheritedFactory`: una subclase de otro
   * paquete que hereda este constructor) — así sus args, sus `inject()` y su wiring de host valen para la subclase.
   * `externalHops`: el constructor es el de una base de otro paquete; la instancia sale de `ɵsuper()`.
   */
  private static facStatement(metadata: WritableMetadata, injects: { owner: string; tokens: InjectDep[] }[], externalHops?: number): string {
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
    const inherited = externalHops !== undefined;
    const params = [...(inherited ? ["ɵsuper"] : []), ...ctorParams, ...injectParams].join(", ");
    const construct = (assign: string) => {
      const statement = inherited ? `${assign}ɵsuper();` : `${assign}new ${InheritedFactory.target(className)}(${ctorArgs});`;
      if (!injectTokens.length) return statement;
      let next = 0;
      const injectedValue = ({ token, flags }: InjectDep) => {
        const names = instanceNames(token);
        return names ? ElementInstances.value(names, flags, metadata.kind === "component") : value(`i${next++}`, token, flags);
      };
      const byOwner = Object.fromEntries(injects.map(({ owner, tokens }) => [owner, tokens.map(injectedValue)]));
      return InjectedValues.around(byOwner, statement);
    };

    const fac = (allDeps: string[], factory: string) =>
      externalHops !== undefined ? InheritedFactory.statement(className, externalHops, `[${[...allDeps, factory].join(", ")}]`) : `${className}.ɵfac = [${[...allDeps, factory].join(", ")}];`;

    if (metadata.kind !== "component" && metadata.kind !== "directive") {
      return fac(deps, `function ${className}_Factory(${params}) { ${injectTokens.length ? construct("var instance = ") + " return instance;" : construct("return ")} }`);
    }

    const guard = DecoratorWriter.tagGuardStatement(metadata);
    const attributes = HostWiring.attributeStatements(metadata);
    const transforms = InputTransforms.wiringStatements(className, metadata.inputs);
    const wiring = HostWiring.hasAny(metadata) ? HostWiring.statements(metadata, className) : [];
    const factoryParams = [params, ...HostWiring.FACTORY_DEPS].filter((param) => param.length > 0).join(", ");
    // Un componente marca su elemento como límite de `@Host` para lo que se construya adentro (`HOST_DATA_KEY`).
    const hostMark = metadata.kind === "component" ? `$element.data(${JSON.stringify(HOST_DATA_KEY)}, $element[0]);` : "";
    const body = [guard, hostMark, ...attributes, construct("var instance = "), ...transforms, ...wiring, "return instance;"].filter(Boolean).join(" ");
    const allDeps = [...deps, ...HostWiring.FACTORY_DEPS.map((dep) => JSON.stringify(dep))];

    return fac(allDeps, `function ${className}_Factory(${factoryParams}) { ${body} }`);
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
   * Lo mismo con cualquier otra parte del selector que AngularJS no filtra al registrar (`[type=submit]`, otra clase,
   * `:not(...)`): el guard es la lista entera (una alternativa u otra). Si todas las alternativas se registran con el
   * mismo nombre, lo registrado no se vuelve a mirar (AngularJS ya lo garantizó — y en el comentario ancla de un
   * `<ng-template>` no hay atributos que leer); si no, cada alternativa se mira entera. El caso común
   * (`tag[atributo]`) conserva su guard y su aviso de tag.
   */
  private static tagGuardStatement(metadata: BindingsCarrier): string {
    const { selector } = metadata.options as { selector: string };
    let alternatives: ParsedSelector[];
    try {
      alternatives = SelectorParser.parse(selector);
    } catch {
      return ""; // Lo valida quien registra (`ModuleWriter`).
    }
    const [first] = alternatives;
    const shared = alternatives.every((parsed) => parsed.registrationName === first!.registrationName && parsed.restrict === first!.restrict);
    const conditions = alternatives.map((parsed) => DecoratorWriter.conditionExpr(parsed.compound, shared ? parsed : undefined));
    if (conditions.some((condition) => condition === "true")) return "";

    // Sobre `<ng-template>` la directiva queda en el comentario ancla de `ngTemplate` (transclusión de elemento):
    // ese nodo no tiene `tagName`, pero es el `<ng-template>`.
    const tag =
      '($element[0].nodeType === 8 && /ngTemplate/.test($element[0].nodeValue) ? "ng-template" : String($element[0].tagName || $element[0].nodeName).toLowerCase())';
    // Construyendo una subclase (`this.ɵT`, ver `InheritedFactory`) el selector que vale es el de ella, no este.
    const onlyTags = alternatives.every((parsed) => DecoratorWriter.conditionExpr(parsed.compound, shared ? parsed : undefined) === `ɵtag === ${JSON.stringify(parsed.compound.tag?.toLowerCase())}`);
    if (shared && onlyTags) {
      const requiredTags = [...new Set(alternatives.map((parsed) => parsed.compound.tag!))];
      const tags = JSON.stringify(requiredTags.map((required) => required.toLowerCase()));
      const warning = JSON.stringify(`${metadata.className}: este selector requiere <${requiredTags.join("> o <")}>, no se aplica en <`);
      return `var ɵtag = ${tag}; if (!(this && this.ɵT) && ${tags}.indexOf(ɵtag) === -1) { console.warn(${warning} + ɵtag + ">."); return {}; }`;
    }
    const warning = JSON.stringify(`${metadata.className}: el elemento no cumple el selector ${JSON.stringify(selector)}, no se aplica en <`);
    return `var ɵtag = ${tag}; if (!(this && this.ɵT) && !(${conditions.map((condition) => `(${condition})`).join(" || ")})) { console.warn(${warning} + ɵtag + ">."); return {}; }`;
  }

  /**
   * La alternativa como expresión JS sobre `$element[0]` (`ɵtag` ya calculado; `ɵselectorAttr`/`ɵselectorClass` de
   * `selectorHelperSource`). `registered`: lo que AngularJS ya garantizó al registrar, no se vuelve a mirar.
   */
  private static conditionExpr(compound: CompoundSelector, registered?: ParsedSelector): string {
    const parts: string[] = [];
    if (compound.tag && registered?.restrict !== "E") parts.push(`ɵtag === ${JSON.stringify(compound.tag.toLowerCase())}`);
    for (const { name, value } of compound.attributes) {
      const camel = SelectorParser.toCamelCase(name);
      const read = `ɵselectorAttr($element[0], ${JSON.stringify(camel)})`;
      if (value !== undefined) parts.push(`${read} === ${JSON.stringify(value)}`);
      else if (!(registered?.restrict === "A" && registered.registrationName === camel)) parts.push(`${read} !== null`);
    }
    for (const name of compound.classes) {
      if (registered?.restrict === "C" && registered.registrationName === SelectorParser.toCamelCase(name)) continue;
      parts.push(`ɵselectorClass($element[0], ${JSON.stringify(name)})`);
    }
    for (const negated of compound.not) parts.push(`!(${DecoratorWriter.conditionExpr(negated)})`);
    return parts.length ? parts.join(" && ") : "true";
  }

  /** Los helpers del guard — texto plano a nivel de archivo, si algún guard los usa. */
  private static selectorHelperSource(): string {
    return `function ɵselectorAttr(el, name) {
  if (!el || el.nodeType !== 1) return null;
  for (var i = 0; i < el.attributes.length; i++) {
    var attr = el.attributes[i];
    var normalized = attr.name.replace(/^(?:x|data)[:\\-_]/i, "").toLowerCase().replace(/[:\\-_]+(.)/g, function (_, c) { return c.toUpperCase(); });
    if (normalized === name) return attr.value;
  }
  return null;
}
function ɵselectorClass(el, name) {
  return !!el && el.nodeType === 1 && (" " + (el.getAttribute("class") || "") + " ").replace(/\\s+/g, " ").indexOf(" " + name + " ") !== -1;
}`;
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
    // Lo que `.component()` necesita (sin `controller`, que es `ɵfac`): para registrarlo al vuelo (`loadComponent`).
    if (field === "ɵcmp") fields.push(`definition: ${JSON.stringify(ComponentDefinition.fields(metadata as ComponentMetadata, undefined, null))}`);
    else if ((metadata.options as { selector?: string }).selector) {
      fields.push(`definition: ${JSON.stringify(ComponentDefinition.directiveFields(metadata as DirectiveMetadata))}`);
    } else {
      // Base abstracta: sus bindings de AngularJS, para una subclase de otro paquete (`InheritedDefinition`).
      const { bindings } = ComponentDefinition.directiveFields(metadata as DirectiveMetadata);
      if (bindings) fields.push(`definition: ${JSON.stringify({ bindings })}`);
    }
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
   * Ivy (`CssSelectorList`): un array por selector de la lista, `[tag, attr, valor, ..., flags, ...]` —
   * `"app-card"` → `[["app-card"]]`, `"[appFoo]"` → `[["", "appFoo", ""]]`,
   * `"button[type=submit]"` → `[["button", "type", "submit"]]`, `".btn"` → `[["", 8, "btn"]]` (`SelectorFlags.CLASS`),
   * `"input:not([type=radio])"` → `[["input", 3, "type", "radio"]]` (`NOT | ATTRIBUTE`).
   * `@Directive()` sin selector es una base abstracta (Angular): `selectors: []`, no se declara en ningún módulo.
   */
  private static ivySelectors(className: string, selector: string | undefined, abstract: boolean): (string | number)[][] {
    if (!selector && abstract) return [];
    if (!selector) throw new Error(`DecoratorWriter: "${className}" no tiene selector.`);
    let alternatives: ParsedSelector[];
    try {
      alternatives = SelectorParser.parse(selector);
    } catch (error) {
      throw new Error(`DecoratorWriter: "${className}" — ${(error as Error).message}`);
    }
    return alternatives.map(({ compound }) => DecoratorWriter.ivySelector(compound));
  }

  private static ivySelector(compound: CompoundSelector): (string | number)[] {
    const NOT = 1;
    const ATTRIBUTE = 2;
    const ELEMENT = 4;
    const CLASS = 8;
    const result: (string | number)[] = [compound.tag ?? "", ...compound.attributes.flatMap(({ name, value }) => [name, value ?? ""])];
    if (compound.classes.length) result.push(CLASS, ...compound.classes);
    for (const negated of compound.not) {
      if (negated.tag) result.push(NOT | ELEMENT, negated.tag);
      if (negated.attributes.length) result.push(NOT | ATTRIBUTE, ...negated.attributes.flatMap(({ name, value }) => [name, value ?? ""]));
      if (negated.classes.length) result.push(NOT | CLASS, ...negated.classes);
    }
    return result;
  }
}

export const decoratorWriterTransform: NgjsTransform = {
  transform: (code, path) => Promise.resolve(DecoratorWriter.writeWithMap(code, path)),
};
