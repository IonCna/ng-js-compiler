import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { HashId } from "@/compiler/hash-id.ts";

/**
 * Nombre de DI estable, calculado 100% en build: `HashId.readable(símbolo, paquete)`.
 * Depende solo de DÓNDE se declara el símbolo (nombre exportado + paquete), así
 * que sale igual en el archivo que lo declara (`ɵprov.token`) y en cada archivo
 * que lo usa (`ɵfac`, `providers`) — sin estampar nada en la clase para leerlo
 * después. Símbolo = el nombre EXPORTADO (`import { A as B }` → `A`); paquete =
 * el `name` del `package.json` más cercano (import relativo o mismo archivo) o
 * el del specifier (`from "pkg/sub"` → `pkg`).
 */
export class TokenName {
  private static readonly packageByDir = new Map<string, string>();

  static of(symbol: string, packageName: string): string {
    return HashId.readable(symbol, packageName);
  }

  /** `name` del `package.json` más cercano subiendo desde `path` (archivo). */
  static packageOf(path: string): string {
    const start = dirname(resolve(path));
    let dir = start;

    while (true) {
      const cached = TokenName.packageByDir.get(dir);
      if (cached) return cached;

      const manifest = join(dir, "package.json");
      if (existsSync(manifest)) {
        const { name } = JSON.parse(readFileSync(manifest, "utf8")) as { name?: string };
        if (!name) throw new Error(`TokenName: "${manifest}" no tiene "name" — hace falta para los nombres de DI.`);
        TokenName.packageByDir.set(start, name);
        TokenName.packageByDir.set(dir, name);
        return name;
      }

      const parent = dirname(dir);
      if (parent === dir) throw new Error(`TokenName: no hay package.json subiendo desde "${path}" — hace falta para los nombres de DI.`);
      dir = parent;
    }
  }

  /** `"pkg"`/`"pkg/sub"` → `"pkg"`, `"@scope/pkg/sub"` → `"@scope/pkg"`; relativo/absoluto → `undefined` (mismo paquete que el importador). */
  static packageFromSpecifier(specifier: string): string | undefined {
    if (specifier.startsWith(".") || specifier.startsWith("/")) return undefined;

    const segments = specifier.split("/");
    return specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
  }
}
