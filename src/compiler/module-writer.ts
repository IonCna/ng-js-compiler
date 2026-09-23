import type { ApplicationNode } from "@/compiler/application-node.ts";
import type { ApplicationScanner } from "@/compiler/application-scanner.ts";
import { ComponentBindings } from "@/compiler/component-bindings.ts";
import { HashId } from "@/compiler/hash-id.ts";
import type { NgjsTransform } from "@/compiler/ngjs-transform.ts";
import { ScopedInjectorRuntime } from "@/compiler/scoped-injector-runtime.ts";
import { type ParsedSelector, SelectorParser } from "@/compiler/selector-parser.ts";
import type {
  ComponentMetadata,
  DirectiveMetadata,
  NgModuleMetadata,
  PipeMetadata,
  ProviderMetadata,
} from "@/metadata/decorator-metadata.ts";
import { MetadataStore } from "@/metadata/metadata-store.ts";

/** Binding del `import` de angular que emite cada archivo con un `@NgModule` (propio, para no chocar con un `import angular` del usuario). */
const ANGULAR = "ɵangular";

/**
 * Fase 3: con el grafo YA resuelto por `ApplicationScanner` (declarations
 * categorizadas, imports apuntando a nodos reales), emite la registración
 * REAL de AngularJS — `angular.module(id, imports)` con `providers` como
 * `.factory()`/`.value()` y declarations como `.component()`/`.directive()`/
 * `.filter()` — texto final, nada para interpretar después.
 *
 * El archivo importa `angular` él mismo: el orden de evaluación de ES modules garantiza que esté cargado antes
 * de cualquier registro — se bundlea o queda external según el build, como cualquier dependencia.
 *
 * El `id` de cada módulo (propio o importado) sale de `HashId.readable(className, path)`
 * — determinista, así el import de `FeatureModule` puede calcularse acá sin
 * esperar a que el archivo de `FeatureModule` se haya procesado.
 */
export class ModuleWriter {
  constructor(private readonly scanner: ApplicationScanner) {}

  write(code: string, path: string): string | undefined {
    const modules = MetadataStore.get(path).filter((metadata) => metadata.kind === "ngmodule");
    if (!modules.length) return undefined;

    // Se estampa una sola vez, en el archivo del módulo raíz (el que tiene `bootstrap`) — y solo si algún
    // component/directive del proyecto declaró `providers` propios (si no, no hay nada que resolver distinto
    // de lo nativo). Ver `ScopedInjectorRuntime`.
    const needsScopedInjector = this.scanner.hasScopedProviders();
    let scopedInjectorEmitted = false;

    const statements = modules.map((metadata) => {
      const node = this.scanner.get(metadata.className);
      if (!node) throw new Error(`ModuleWriter: "${metadata.className}" no está en el escaneo del proyecto (¿corrió ApplicationScanner.scan()?).`);
      const isRoot = (metadata as NgModuleMetadata).bootstrap.length > 0;
      const attachScopedInjector = isRoot && needsScopedInjector;
      scopedInjectorEmitted ||= attachScopedInjector;
      return ModuleWriter.moduleStatement(node, attachScopedInjector);
    });

    const prelude = scopedInjectorEmitted ? `${ScopedInjectorRuntime.source()}\n` : "";
    return `import ${ANGULAR} from "angular";\n${prelude}${code}\n${statements.join("\n")}\n`;
  }

  private static moduleStatement(node: ApplicationNode, attachScopedInjector: boolean): string {
    const id = ModuleWriter.idFor(node);
    // `@NgModule` propios por REFERENCIA (`X.ɵmod.id`), no por el string del id: así el `import { X }` sigue en
    // uso y ese archivo se evalúa antes (si no, SWC lo elimina y su `angular.module` nunca se registra).
    // Después los legacy (expresión que da su nombre).
    const requires = [...node.imports.map((imported) => `${imported.className}.ɵmod.id`), ...node.legacyImports];

    const calls = [
      ...ModuleWriter.providerCalls(node),
      ...(attachScopedInjector ? [ScopedInjectorRuntime.decoratorFragment()] : []),
      ...node.declarations.components.flatMap(ModuleWriter.componentCall),
      ...node.declarations.directives.flatMap(ModuleWriter.directiveCall),
      ...node.declarations.pipes.map(ModuleWriter.pipeCall),
    ];

    const chain = [`${ANGULAR}.module(${JSON.stringify(id)}, [${requires.join(", ")}])`, ...calls].join("\n  ");
    // `ɵmod` como en Ivy — el id del `angular.module` (para que otro `@NgModule` lo importe por referencia) y los
    // tags de `bootstrap` (los monta `bootstrapModule()` de la plataforma, ver `PlatformCode`).
    const bootstrap = ModuleWriter.bootstrapTags(node);
    const mod = bootstrap.length ? `{ id: ${JSON.stringify(id)}, bootstrap: ${JSON.stringify(bootstrap)} }` : `{ id: ${JSON.stringify(id)} }`;
    return `${node.className}.ɵmod = ${mod};\n${chain};`;
  }

  /** Como Angular: cada componente de `bootstrap` tiene que estar en `declarations` del mismo módulo y tener selector de elemento. */
  private static bootstrapTags(node: ApplicationNode): string[] {
    return (node.metadata as NgModuleMetadata).bootstrap.map((name) => {
      const component = node.declarations.components.find((declared) => declared.className === name);
      if (!component) {
        throw new Error(`ModuleWriter: "${name}" está en bootstrap de "${node.className}" pero no es un @Component de sus declarations.`);
      }

      const { selector } = (component.metadata as ComponentMetadata).options as { selector: string };
      const alternatives = SelectorParser.parse(selector);
      if (alternatives.length !== 1 || alternatives[0]!.restrict !== "E") {
        throw new Error(`ModuleWriter: "${name}" (bootstrap) necesita un selector de elemento simple, no ${JSON.stringify(selector)}.`);
      }
      return selector.trim();
    });
  }

  /**
   * `providers` del `@NgModule` → registración nativa, una por token. Como en Angular: el último
   * provider de un token gana; los `multi` se juntan en un array (cada uno se registra aparte como
   * `token#multi#i` y un `.factory(token)` los inyecta a todos); mezclar multi y no-multi es error.
   */
  private static providerCalls(node: ApplicationNode): string[] {
    const { providers } = node.metadata as NgModuleMetadata;
    const single = new Map<string, ProviderMetadata>();
    const multi = new Map<string, ProviderMetadata[]>();

    for (const provider of providers) {
      const isMulti = provider.kind !== "class" && provider.multi;
      if (isMulti ? single.has(provider.token) : multi.has(provider.token)) {
        throw new Error(`ModuleWriter: "${node.className}" mezcla providers multi y no-multi para el token "${provider.token}".`);
      }
      if (isMulti) multi.set(provider.token, [...(multi.get(provider.token) ?? []), provider]);
      else single.set(provider.token, provider);
    }

    const calls = [...single].map(([token, provider]) => ModuleWriter.providerCall(token, provider));
    for (const [token, group] of multi) {
      const members = group.map((_, index) => `${token}#multi#${index}`);
      calls.push(...group.map((provider, index) => ModuleWriter.providerCall(members[index]!, provider)));
      calls.push(
        `.factory(${JSON.stringify(token)}, [${[...members.map((member) => JSON.stringify(member)), "function () { return Array.prototype.slice.call(arguments); }"].join(", ")}])`,
      );
    }
    return calls;
  }

  private static providerCall(name: string, provider: ProviderMetadata): string {
    const key = JSON.stringify(name);

    switch (provider.kind) {
      case "useValue":
        // `.value` evalúa la expresión al registrar — como `useValue` en Angular, no lazy.
        return `.value(${key}, ${provider.valueExpr})`;
      case "useFactory":
        return `.factory(${key}, [${[...provider.deps.map((dep) => JSON.stringify(dep)), provider.factoryExpr].join(", ")}])`;
      case "useExisting":
        return `.factory(${key}, [${JSON.stringify(provider.existingToken)}, function (existing) { return existing; }])`;
      default: {
        // class / constructor / useClass: sin `deps` el `ɵfac` de la clase; con `deps`, `new X(...deps)`.
        const cls = /^[\w$]+$/.test(provider.classExpr) ? provider.classExpr : `(${provider.classExpr})`;
        const deps = provider.kind === "class" ? undefined : provider.deps;
        if (!deps) {
          // Sin `ɵfac` (clase sin decorador) solo se puede construir sin argumentos — igual que en Angular.
          return `.factory(${key}, ${cls}.ɵfac || [function () { return new ${cls}(); }])`;
        }
        const params = deps.map((_, index) => `a${index}`).join(", ");
        const factory = `function (${params}) { return new ${cls}(${params}); }`;
        return `.factory(${key}, [${[...deps.map((dep) => JSON.stringify(dep)), factory].join(", ")}])`;
      }
    }
  }

  private static idFor(node: ApplicationNode): string {
    return HashId.readable(node.className, node.path);
  }

  /**
   * Varias alternativas de una lista por coma pueden compartir `registrationName` (mismo atributo, distinto
   * tag, ej. `"button[x], label[x]"`) — el guard de `DecoratorWriter.tagGuardStatement` ya acepta cualquiera
   * de los tags, así que registrar dos veces bajo el mismo nombre no suma nada y AngularJS lo rechaza
   * (`$compile:multidir`: dos directivas pidiendo el mismo `controllerAs` en el mismo elemento).
   */
  private static uniqueByName(alternatives: ParsedSelector[]): ParsedSelector[] {
    const seen = new Set<string>();
    return alternatives.filter((parsed) => {
      if (seen.has(parsed.registrationName)) return false;
      seen.add(parsed.registrationName);
      return true;
    });
  }

  /**
   * Una lista por coma registra una vez por nombre único (mismo `controller`/bindings, distinto nombre) —
   * pero TODAS las alternativas se validan antes de deduplicar: si una alternativa inválida comparte nombre
   * con una válida, el dedupe la taparía y el error nunca saldría.
   */
  private static componentCall(node: ApplicationNode): string[] {
    const metadata = node.metadata as ComponentMetadata;
    const options = metadata.options as { selector: string; template?: string; templateUrl?: string; controllerAs?: string };
    const alternatives = SelectorParser.parse(options.selector);

    for (const parsed of alternatives) {
      if (parsed.restrict !== "E") {
        throw new Error(
          `ModuleWriter: "${node.className}" tiene selector de atributo (${JSON.stringify(options.selector)}) — @Component con selector de atributo no soportado todavía.`,
        );
      }
    }

    const bindings = ComponentBindings.from(metadata.inputs, metadata.outputs);
    const fields = [`controller: ${node.className}.ɵfac`];
    if (options.template !== undefined) fields.push(`template: ${JSON.stringify(options.template)}`);
    if (options.templateUrl !== undefined) fields.push(`templateUrl: ${JSON.stringify(options.templateUrl)}`);
    fields.push(`controllerAs: ${JSON.stringify(options.controllerAs ?? "$ctrl")}`);
    if (Object.keys(bindings).length) fields.push(`bindings: ${JSON.stringify(bindings)}`);

    return ModuleWriter.uniqueByName(alternatives).map(
      (parsed) => `.component(${JSON.stringify(parsed.registrationName)}, { ${fields.join(", ")} })`,
    );
  }

  private static directiveCall(node: ApplicationNode): string[] {
    const metadata = node.metadata as DirectiveMetadata;
    const options = metadata.options as { selector: string; template?: string; templateUrl?: string; controllerAs?: string };
    const alternatives = ModuleWriter.uniqueByName(SelectorParser.parse(options.selector));
    const bindings = ComponentBindings.from(metadata.inputs, metadata.outputs);

    return alternatives.map((parsed) => {
      const fields = [
        `controller: ${node.className}.ɵfac`,
        `restrict: ${JSON.stringify(parsed.restrict)}`,
        `bindToController: ${Object.keys(bindings).length ? JSON.stringify(bindings) : "true"}`,
        `controllerAs: ${JSON.stringify(options.controllerAs ?? parsed.registrationName)}`,
      ];
      if (options.template !== undefined) fields.push(`template: ${JSON.stringify(options.template)}`);
      if (options.templateUrl !== undefined) fields.push(`templateUrl: ${JSON.stringify(options.templateUrl)}`);

      return `.directive(${JSON.stringify(parsed.registrationName)}, function () { return { ${fields.join(", ")} }; })`;
    });
  }

  /** La instancia sale de `ɵfac` vía `$injector.invoke` (con sus deps de constructor); el filtro delega en `transform` con `value` + args extra. */
  private static pipeCall(node: ApplicationNode): string {
    const metadata = node.metadata as PipeMetadata;
    const { name, pure } = metadata.options as { name: string; pure?: boolean };
    const markStateful = pure === false ? " fn.$stateful = true;" : "";

    const body = `var instance = $injector.invoke(${node.className}.ɵfac); var fn = function (value) { return instance.transform.apply(instance, arguments); };${markStateful} return fn;`;
    return `.filter(${JSON.stringify(name)}, ["$injector", function ($injector) { ${body} }])`;
  }

}

export function createModuleWriterTransform(scanner: ApplicationScanner): NgjsTransform {
  const writer = new ModuleWriter(scanner);
  return { transform: (code, path) => Promise.resolve(writer.write(code, path)) };
}
