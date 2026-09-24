import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ApplicationNode } from "@/compiler/application-node.ts";
import { DecoratorReader } from "@/compiler/decorator-reader.ts";
import type { NgjsTransform } from "@/compiler/ngjs-transform.ts";
import { ResolveDependency } from "@/compiler/resolve-dependency.ts";
import type { ModuleImport, NgModuleMetadata, ProviderMetadata } from "@/metadata/decorator-metadata.ts";
import { MetadataStore } from "@/metadata/metadata-store.ts";

/**
 * Lo que la emisión le hace a cada archivo ANTES de la cadena del compilador — el escaneo tiene que ver el mismo
 * código: `ModuleWriter` registra desde la metadata del escaneo (un `@NgModule` se emite antes que los archivos que
 * importa), así que si el escaneo leyera el archivo crudo, un `templateUrl` que `ng-js-vite` inlinea al emitir
 * quedaría registrado como `templateUrl` relativo, y un environment reemplazado se escanearía con el original.
 */
export interface ScanOptions {
  /** Transforms previos (`extraTransforms` de `pluginLoader`/`viteTransformPlugin`, ej. el template de `ng-js-vite`). */
  transforms?: NgjsTransform[];
  /** `fileReplacements`: ruta absoluta de `replace` → ruta absoluta de `with`. */
  fileReplacements?: Record<string, string>;
}

/**
 * Compilador de dos pasadas: `scan()` recorre TODO `sourceRoot` antes de que
 * nada se emita, así cuando le toca a un `@NgModule` sus `declarations`/
 * `imports` (nombres de clase, no resueltos) ya se pueden buscar en el mapa
 * completo del proyecto — sin importar en qué archivo vive cada uno ni el
 * orden en que se procesaron. Nada de esto corre en el código compilado, es
 * pura etapa de compilación.
 */
export class ApplicationScanner {
  private readonly nodes = new Map<string, ApplicationNode>();

  /**
   * Pasada 1 (lee todo) + pasada 2 (resuelve `declarations`/`imports` a nodos reales). Varias raíces se escanean
   * como un solo proyecto (ej. una app y el código fuente de una librería que compila junto con ella).
   */
  async scan(sourceRoot: string | string[], options: ScanOptions = {}): Promise<void> {
    const roots = Array.isArray(sourceRoot) ? sourceRoot : [sourceRoot];
    const files = (await Promise.all(roots.map((root) => ApplicationScanner.listTsFiles(root)))).flat();

    for (const file of files) {
      // Mismo path con que lo lee la emisión (`pluginLoader`: el del reemplazo, si hay).
      const path = options.fileReplacements?.[resolve(file)] ?? file;
      const code = await ApplicationScanner.readTransformed(path, options);
      await DecoratorReader.read(code, path);

      for (const metadata of MetadataStore.get(path)) {
        // El nombre de DI (`TokenName`) es símbolo + paquete — dos clases EXPORTADAS con el mismo nombre en el proyecto
        // chocarían. Una no exportada (`local`) se identifica por archivo + nombre: puede repetirse entre archivos.
        const key = ApplicationScanner.key(metadata.className, path, metadata.local);
        const existing = this.nodes.get(key);
        if (existing && existing.path !== path) {
          throw new Error(
            `ApplicationScanner: "${metadata.className}" está declarada dos veces ("${existing.path}" y "${path}") — los nombres tienen que ser únicos en el proyecto.`,
          );
        }
        this.nodes.set(key, new ApplicationNode(metadata.className, path, metadata));
      }
    }

    this.resolve();
  }

  /** El código que va a ver la emisión, con los transforms previos aplicados. */
  private static async readTransformed(path: string, options: ScanOptions): Promise<string> {
    let code = await readFile(path, "utf8");
    for (const transform of options.transforms ?? []) {
      const result = await transform.transform(code, path);
      if (result !== undefined) code = result;
    }
    return code;
  }

  /** Por nombre, como se ve desde `path`: primero una clase no exportada de ese archivo, después una exportada. */
  get(className: string, path?: string): ApplicationNode | undefined {
    return (path && this.nodes.get(ApplicationScanner.key(className, path, true))) || this.nodes.get(className);
  }

  private static key(className: string, path: string, local: boolean | undefined): string {
    return local ? `${resolve(path)}#${className}` : className;
  }

  /** Gate de todo el proyecto para `ScopedInjectorRuntime`: si nadie declara `providers` propios, no se estampa nada. */
  hasScopedProviders(): boolean {
    for (const node of this.nodes.values()) {
      if ((node.metadata.kind === "component" || node.metadata.kind === "directive") && node.metadata.providers.length > 0) return true;
    }
    return false;
  }

  /**
   * Gate de todo el proyecto para `ResolveDependency`: si ninguna dependencia lleva flags (`@Optional()`/`@Self()`/…,
   * `inject(X, { ... })`, `[new Optional(), X]` en `deps`), ningún módulo registra `ɵresolve`.
   */
  usesInjectFlags(): boolean {
    for (const { metadata } of this.nodes.values()) {
      const providers =
        metadata.kind === "ngmodule" || metadata.kind === "component" || metadata.kind === "directive"
          ? metadata.providers
          : metadata.kind === "service" || metadata.kind === "injectable"
            ? [metadata.recipe].filter((recipe): recipe is ProviderMetadata => recipe !== undefined)
            : [];
      if (providers.some(ApplicationScanner.providerUsesFlags)) return true;
      if (metadata.constructorFlags.some(ResolveDependency.hasFlags) || metadata.injectTokens.some((injected) => ResolveDependency.hasFlags(injected.flags))) return true;
    }
    return false;
  }

  /** Flags en `deps` (`[new Optional(), X]`) o en los `inject()` del cuerpo de un `useFactory`. */
  private static providerUsesFlags(provider: ProviderMetadata): boolean {
    if (provider.kind === "class" || provider.kind === "useValue" || provider.kind === "useExisting") return false;
    return Boolean(
      provider.depFlags?.some(ResolveDependency.hasFlags) ||
        (provider.kind === "useFactory" && provider.injectTokens?.some((injected) => ResolveDependency.hasFlags(injected.flags))),
    );
  }

  /** Pasada 2 — ya existen TODOS los nodos, así que resolver nombre → nodo no depende del orden de la pasada 1. */
  private resolve(): void {
    for (const node of this.nodes.values()) {
      if (node.metadata.kind === "ngmodule") this.resolveModule(node, node.metadata);
    }
    for (const node of this.nodes.values()) {
      if (node.metadata.kind === "ngmodule" && node.metadata.controllerAs) this.inheritControllerAs(node, node.metadata.controllerAs);
    }
  }

  /**
   * `controllerAs` de `@NgModule` en 3 capas (lo que hacía el runtime de `ngjs-core`): el del `@Component` si lo
   * declara; si no, el de su módulo; si el módulo tampoco, el del módulo que lo importa (hacia abajo por `imports`,
   * sin pisar uno propio). Con dos importadores distintos gana el primero que se recorre.
   */
  private inheritControllerAs(node: ApplicationNode, controllerAs: string): void {
    if (node.controllerAs !== undefined) return;
    node.controllerAs = controllerAs;
    for (const imported of node.imports) {
      const own = (imported.metadata as NgModuleMetadata).controllerAs;
      this.inheritControllerAs(imported, own ?? controllerAs);
    }
  }

  private resolveModule(node: ApplicationNode, metadata: NgModuleMetadata): void {
    for (const name of metadata.declarations) {
      const declared = this.get(name, node.path);
      if (!declared) continue;

      ApplicationScanner.bucketFor(node, declared).push(declared);
    }

    for (const imported of metadata.imports) this.resolveImport(node, imported);
  }

  /**
   * Primero se busca como clase del proyecto (`@NgModule` → su id). Si no es nuestra, en build no se sabe
   * qué es: un `@NgModule` de otro paquete compilado con ngjs trae `ɵmod.id`, un `IModule` legacy trae
   * `.name` — se emite la expresión que elige al correr. Un string es el nombre tal cual. Una llamada queda
   * para `ModuleWriter` (se evalúa una sola vez, al correr).
   */
  private resolveImport(node: ApplicationNode, imported: ModuleImport): void {
    switch (imported.kind) {
      case "name":
        node.legacyImports.push(JSON.stringify(imported.name));
        return;
      case "angularModule":
        node.legacyImports.push(`${imported.expr}.name`);
        return;
      case "expression":
        node.legacyImports.push(ApplicationScanner.externalModuleName(imported.expr));
        return;
      case "call":
        node.callImports.push(imported.expr);
        return;
    }

    const own = this.get(imported.identifier, node.path);
    if (!own) {
      node.legacyImports.push(ApplicationScanner.externalModuleName(imported.identifier));
      return;
    }
    if (own.metadata.kind !== "ngmodule") {
      throw new Error(`ApplicationScanner: "${own.className}" está en imports de "${node.className}" pero no es @NgModule.`);
    }
    node.imports.push(own);
  }

  /**
   * `@NgModule` de otro paquete (`ɵmod.id`), `IModule` legacy (`.name`) o ya el nombre (`legacy.name`, un string) —
   * `expr` es un identificador o acceso a miembro, sin efectos al repetirlo.
   */
  private static externalModuleName(expr: string): string {
    return `(typeof ${expr} === "string" ? ${expr} : ${expr}.ɵmod ? ${expr}.ɵmod.id : ${expr}.name)`;
  }

  /** Como Angular: `declarations` solo acepta component/directive/pipe — un servicio va en `providers`. */
  private static bucketFor(node: ApplicationNode, declared: ApplicationNode): ApplicationNode[] {
    switch (declared.metadata.kind) {
      case "component":
        return node.declarations.components;
      case "directive":
        return node.declarations.directives;
      case "pipe":
        return node.declarations.pipes;
      default:
        throw new Error(
          `ApplicationScanner: "${declared.className}" está en declarations de "${node.className}" pero no es @Component/@Directive/@Pipe.`,
        );
    }
  }

  private static async listTsFiles(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    const files: string[] = [];

    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) files.push(...(await ApplicationScanner.listTsFiles(path)));
      else if (entry.name.endsWith(".ts")) files.push(path);
    }

    return files;
  }
}
