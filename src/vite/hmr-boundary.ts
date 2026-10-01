import { relative, resolve, sep } from "node:path";
import { SelectorParser } from "@/compiler/selector-parser.ts";
import type { ComponentMetadata } from "@/metadata/decorator-metadata.ts";
import { MetadataStore } from "@/metadata/metadata-store.ts";
import { HmrRuntime, type HmrRegistration } from "@/vite/hmr-runtime.ts";

/**
 * Qué archivos del proyecto se actualizan en caliente en `ngjs serve` (ver `HmrRuntime`): los que solo declaran
 * `@Component` exportados. Todo lo demás — un `@Injectable` (su instancia ya vive en el injector), un `@NgModule`
 * (ya registró), rutas, utilidades, componentes legacy de AngularJS — recarga la página. Corre dentro del scope del
 * escaneo (`ApplicationScanner.within`).
 */
export class HmrBoundary {
  /** El archivo de un `@Component` (o varios) y nada más decorado; las clases, exportadas (el `accept` las recibe). */
  static isComponentFile(path: string): boolean {
    const metadata = HmrBoundary.metadataOf(path);
    return metadata.length > 0 && metadata.every((entry) => entry.kind === "component" && !entry.local);
  }

  /** El `accept` para el final del archivo, o `undefined` si no es de un componente. */
  static acceptCode(path: string): string | undefined {
    if (!HmrBoundary.isComponentFile(path)) return undefined;

    const registrations: Record<string, HmrRegistration[]> = {};
    for (const metadata of HmrBoundary.metadataOf(path) as ComponentMetadata[]) {
      registrations[metadata.className] = HmrBoundary.registrations((metadata.options as { selector: string }).selector);
    }
    return HmrRuntime.acceptCode(registrations);
  }

  /**
   * La metadata del archivo con el path como lo da Vite (`C:/…/src/x.ts`) o como lo guardó el escaneo (relativo a la
   * raíz, con el separador del sistema: `src\x.ts` en Windows): justo después de un cambio, el escaneo nuevo todavía no
   * pasó por el `transform` de Vite, que la guarda con su forma.
   */
  private static metadataOf(path: string): ReturnType<typeof MetadataStore.get> {
    const absolute = resolve(path);
    for (const candidate of [path, absolute, relative(process.cwd(), absolute), absolute.split(sep).join("/")]) {
      const metadata = MetadataStore.get(candidate);
      if (metadata.length) return metadata;
    }
    return [];
  }

  /** Igual que `ModuleWriter.componentCall`: un registro por nombre, con el selector CSS de sus elementos. */
  private static registrations(selector: string): HmrRegistration[] {
    const byName = new Map<string, string[]>();
    for (const parsed of SelectorParser.parse(selector)) {
      const kebab = parsed.registrationName.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);
      const tag = parsed.requiredTag?.toLowerCase() ?? "";
      const queries =
        parsed.restrict === "E" ? [kebab] : [...(parsed.restrict.includes("A") ? [`${tag}[${kebab}]`] : []), ...(parsed.restrict.includes("C") ? [`${tag}.${kebab}`] : [])];
      byName.set(parsed.registrationName, [...(byName.get(parsed.registrationName) ?? []), ...queries]);
    }
    return [...byName].map(([name, queries]) => ({ name, query: [...new Set(queries)].join(", ") }));
  }
}
