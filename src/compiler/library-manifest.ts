import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { ApplicationScanner } from "@/compiler/application-scanner.ts";
import { ClassHierarchy, type ClassLookup } from "@/compiler/class-hierarchy.ts";
import { DecoratorReader } from "@/compiler/decorator-reader.ts";
import type { ComponentMetadata, DecoratorMetadata, DirectiveMetadata } from "@/metadata/decorator-metadata.ts";
import { MetadataStore } from "@/metadata/metadata-store.ts";

/** Un `@Component`/`@Directive` de la librería, con lo que el compilador de una app necesita para sus templates. */
export interface ManifestDeclaration {
  className: string;
  kind: "component" | "directive";
  selector: string;
  /** `name`: el nombre del binding (el atributo, en camelCase); `mode`: `<` (expresión) o `@` (interpolación). */
  /** `required`: `@Input({ required: true })` — el compilador de templates exige el atributo en cada uso. */
  inputs: { property: string; name: string; mode: "<" | "@"; required?: true }[];
  outputs: { property: string; name: string }[];
}

export interface NgjsManifest {
  version: 1;
  declarations: ManifestDeclaration[];
}

/**
 * Lo que `ngjs build` de una librería publica junto a su `dist`: selector, inputs y outputs de cada declaración —
 * como Angular, que los publica en los `.d.ts` (`ɵɵComponentDeclaration`) para que el compilador de la app que la
 * consume sepa qué atributo de un template es input, output o nativo. Con los bindings heredados de sus bases.
 */
export class LibraryManifest {
  static readonly FILE_NAME = "ngjs-manifest.json";

  static from(scanner: ApplicationScanner): NgjsManifest {
    const metadata = [...scanner.allNodes()].map((node) => node.metadata);
    // Contra la metadata de ese escaneo (corre después, desde `onScanned`, fuera de su scope).
    return scanner.within(() => LibraryManifest.build(metadata, (className, from) => MetadataStore.findClass(className, from)));
  }

  /**
   * Lo mismo leyendo los fuentes de `roots` directo, sin `MetadataStore` (global): se puede armar en paralelo con el
   * escaneo del compilador sin pisarle nada — lo usa `ng-js-template-compiler` para las declaraciones del proyecto.
   */
  static async fromSources(roots: string | string[]): Promise<NgjsManifest> {
    const files = (await Promise.all((Array.isArray(roots) ? roots : [roots]).map((root) => ApplicationScanner.listTsFiles(root)))).flat();
    const byFile = await Promise.all(
      files.map(async (path) => ({ path, metadata: await DecoratorReader.metadataOf(await readFile(path, "utf8"), path) })),
    );
    // Como `MetadataStore.findClass`: primero una clase del mismo archivo, después una exportada de cualquiera.
    const lookup: ClassLookup = (className, from) => {
      const sameFile = byFile.find(({ metadata }) => metadata.includes(from))?.metadata.find((candidate) => candidate.className === className);
      return sameFile ?? byFile.flatMap(({ metadata }) => metadata).find((candidate) => candidate.className === className && !candidate.local);
    };
    return LibraryManifest.build(byFile.flatMap(({ metadata }) => metadata), lookup);
  }

  private static build(all: DecoratorMetadata[], lookup: ClassLookup): NgjsManifest {
    const declarations: ManifestDeclaration[] = [];
    for (const declared of all) {
      const { kind } = declared;
      if (kind !== "component" && kind !== "directive") continue;
      // Una no exportada no se puede usar fuera de la librería; una sin selector es una base abstracta.
      if (declared.local) continue;
      const { selector } = declared.options as { selector?: string };
      if (!selector) continue;
      const { inputs, outputs } = ClassHierarchy.bindingsOf(declared as ComponentMetadata | DirectiveMetadata, lookup);
      declarations.push({
        className: declared.className,
        kind,
        selector,
        inputs: inputs.map((input) => ({
          property: input.propName,
          name: input.bindingName,
          mode: input.mode ?? "<",
          ...(input.required && { required: true as const }),
        })),
        outputs: outputs.map((output) => ({ property: output.propName, name: output.bindingName })),
      });
    }
    declarations.sort((a, b) => a.className.localeCompare(b.className));
    return { version: 1, declarations };
  }

  /**
   * Las declaraciones de las dependencias del proyecto (`dependencies`/`devDependencies`/`peerDependencies` del
   * `package.json` más cercano a `projectDir`) que publican un manifiesto: `ngjs-manifest.json` junto a su entry
   * (`exports["."]`, `module` o `main`). Sin configuración — una dependencia sin manifiesto no es de ngjs.
   */
  static async fromDependencies(projectDir: string): Promise<ManifestDeclaration[]> {
    const project = await LibraryManifest.nearestPackageJson(resolve(projectDir));
    if (!project) return [];
    const names = Object.keys({ ...project.json.dependencies, ...project.json.devDependencies, ...project.json.peerDependencies });
    const manifests = await Promise.all(names.map((name) => LibraryManifest.ofPackage(name, project.dir)));
    return manifests.flatMap((manifest) => manifest?.declarations ?? []);
  }

  private static async ofPackage(name: string, fromDir: string): Promise<NgjsManifest | undefined> {
    const pkg = await LibraryManifest.installedPackage(name, fromDir);
    const entry = pkg && LibraryManifest.entryOf(pkg.json);
    if (!pkg || !entry) return undefined;
    const manifest = await LibraryManifest.readJson<NgjsManifest>(join(pkg.dir, dirname(entry), LibraryManifest.FILE_NAME));
    return manifest?.version === 1 ? manifest : undefined;
  }

  /** `node_modules/<name>` subiendo desde `fromDir`, como la resolución de Node (también un `link:`). */
  private static async installedPackage(name: string, fromDir: string): Promise<{ dir: string; json: PackageJson } | undefined> {
    for (let dir = fromDir; ; dir = dirname(dir)) {
      const candidate = join(dir, "node_modules", name);
      const json = await LibraryManifest.readJson<PackageJson>(join(candidate, "package.json"));
      if (json) return { dir: candidate, json };
      if (dirname(dir) === dir) return undefined;
    }
  }

  private static async nearestPackageJson(fromDir: string): Promise<{ dir: string; json: PackageJson } | undefined> {
    for (let dir = fromDir; ; dir = dirname(dir)) {
      const json = await LibraryManifest.readJson<PackageJson>(join(dir, "package.json"));
      if (json) return { dir, json };
      if (dirname(dir) === dir) return undefined;
    }
  }

  private static entryOf(json: PackageJson): string | undefined {
    const root = typeof json.exports === "object" && json.exports !== null ? (json.exports as Record<string, unknown>)["."] : json.exports;
    if (typeof root === "string") return root;
    if (root && typeof root === "object") {
      const conditions = root as Record<string, unknown>;
      const entry = conditions.import ?? conditions.default ?? conditions.require;
      if (typeof entry === "string") return entry;
    }
    return json.module ?? json.main;
  }

  private static async readJson<T>(path: string): Promise<T | undefined> {
    try {
      return JSON.parse(await readFile(path, "utf8")) as T;
    } catch {
      return undefined;
    }
  }
}

interface PackageJson {
  main?: string;
  module?: string;
  exports?: unknown;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}
