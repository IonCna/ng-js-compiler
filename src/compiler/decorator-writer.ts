import { HostWiring } from "@/compiler/host-wiring.ts";
import { LifecycleWiring } from "@/compiler/lifecycle-wiring.ts";
import type { NgjsTransform } from "@/compiler/ngjs-transform.ts";
import { PlatformCode } from "@/compiler/platform-code.ts";
import { ScopedProviders } from "@/compiler/scoped-providers.ts";
import { SelectorParser } from "@/compiler/selector-parser.ts";
import type {
  ComponentMetadata,
  DecoratorMetadata,
  DirectiveMetadata,
  NgModuleMetadata,
  PipeMetadata,
  ServiceMetadata,
} from "@/metadata/decorator-metadata.ts";
import { MetadataStore } from "@/metadata/metadata-store.ts";

type BindingsCarrier = ComponentMetadata | DirectiveMetadata;
type WritableMetadata = Exclude<DecoratorMetadata, NgModuleMetadata>;

/**
 * Fase 2: lee lo que guardó `DecoratorReader` en `MetadataStore` y estampa en
 * la clase los mismos campos estáticos que emite el compilador AOT (Ivy) de
 * Angular, con valores que AngularJS usa directo — nada que otro runtime
 * tenga que leer o traducir:
 * - `ClassName.ɵfac` — factory con anotación en array de AngularJS:
 *   `["Dep_hash", ..., function X_Factory(a0, ...) { return new X(a0, ...); }]`.
 *   Los nombres de DI ya vienen resueltos (`TokenName`). Es lo que `ModuleWriter`
 *   registra (`controller:`, factory de servicio, instancia de pipe).
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
    const statements = MetadataStore.get(path)
      .filter((metadata): metadata is WritableMetadata => metadata.kind !== "ngmodule")
      .flatMap((metadata) => DecoratorWriter.statementsFor(metadata));

    return statements.length ? `${code}\n${statements.join("\n")}\n` : undefined;
  }

  private static statementsFor(metadata: WritableMetadata): string[] {
    // Import de efecto por cada archivo del que viene una dependencia del constructor: que se evalúe (y registre).
    const statements = [...metadata.constructorImports.map((specifier) => `import ${JSON.stringify(specifier)};`), DecoratorWriter.facStatement(metadata)];

    switch (metadata.kind) {
      case "component":
        statements.push(DecoratorWriter.defStatement(metadata, "ɵcmp"));
        break;
      case "directive":
        statements.push(DecoratorWriter.defStatement(metadata, "ɵdir"));
        break;
      case "pipe":
        statements.push(DecoratorWriter.pipeStatement(metadata));
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
   */
  private static facStatement(metadata: WritableMetadata): string {
    const { className, constructorTokens } = metadata;
    const ctorParams = constructorTokens.map((_, index) => `a${index}`).join(", ");
    const deps = constructorTokens.map((token) => JSON.stringify(token));

    if (metadata.kind !== "component" && metadata.kind !== "directive") {
      const factory = `function ${className}_Factory(${ctorParams}) { return new ${className}(${ctorParams}); }`;
      return `${className}.ɵfac = [${[...deps, factory].join(", ")}];`;
    }

    const guard = DecoratorWriter.tagGuardStatement(metadata);
    const wiring = HostWiring.hasAny(metadata) ? HostWiring.statements(metadata, className) : [];
    const factoryParams = [ctorParams, ...HostWiring.FACTORY_DEPS].filter((param) => param.length > 0).join(", ");
    const body = [guard, `var instance = new ${className}(${ctorParams});`, ...wiring, "return instance;"].filter(Boolean).join(" ");
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

  private static provStatement(metadata: ServiceMetadata): string {
    const { providedIn } = metadata.options as { providedIn?: unknown };
    const prov = `${metadata.className}.ɵprov = { token: ${JSON.stringify(metadata.token)}${providedIn === "root" ? ', providedIn: "root"' : ""} };`;
    return providedIn === "root" ? `${prov}
${PlatformCode.rootProviderStatement(metadata.token, metadata.className)}` : prov;
  }

  private static defStatement(metadata: BindingsCarrier, field: "ɵcmp" | "ɵdir"): string {
    const { selector, exportAs } = metadata.options as { selector?: string; exportAs?: string };

    const def: Record<string, unknown> = {
      selectors: DecoratorWriter.ivySelectors(metadata.className, selector),
      inputs: DecoratorWriter.publicToProperty(metadata.inputs),
      outputs: DecoratorWriter.publicToProperty(metadata.outputs),
    };
    if (exportAs) def.exportAs = exportAs.split(",").map((name) => name.trim());

    const fields = Object.entries(def)
      .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
      .join(", ");
    return `${metadata.className}.${field} = { ${fields} };`;
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
   */
  private static ivySelectors(className: string, selector: string | undefined): string[][] {
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
