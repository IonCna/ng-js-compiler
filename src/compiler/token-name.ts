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
  /** Patrones de `compilerOptions.paths` del `tsconfig.json` más cercano, por carpeta (`[]` si no hay). */
  private static readonly aliasesByDir = new Map<string, RegExp[]>();

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

  /**
   * `"pkg"`/`"pkg/sub"` → `"pkg"`, `"@scope/pkg/sub"` → `"@scope/pkg"`; relativo/absoluto → `undefined` (mismo
   * paquete que el importador). Un alias de `compilerOptions.paths` (`"@/core/x"`, `"@ngb/*"`) también es del mismo
   * paquete — si se tomara como un paquete npm con scope, el token importado por alias tendría otro nombre que el que
   * su clase estampa en sí misma. `importer` (el archivo que importa) ubica el `tsconfig.json`.
   */
  static packageFromSpecifier(specifier: string, importer?: string): string | undefined {
    if (specifier.startsWith(".") || specifier.startsWith("/")) return undefined;
    // `@/x`: scope vacío, no es un nombre de npm válido — siempre un alias.
    if (specifier.startsWith("@/")) return undefined;
    if (importer && TokenName.isPathAlias(specifier, importer)) return undefined;

    const segments = specifier.split("/");
    return specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
  }

  private static isPathAlias(specifier: string, importer: string): boolean {
    return TokenName.aliasesFor(dirname(resolve(importer))).some((pattern) => pattern.test(specifier));
  }

  /** Los `paths` del `tsconfig.json` más cercano subiendo desde `dir` (`"@ngb/*"` → `/^@ngb\/.*$/`). */
  private static aliasesFor(dir: string): RegExp[] {
    const cached = TokenName.aliasesByDir.get(dir);
    if (cached) return cached;

    const config = join(dir, "tsconfig.json");
    const parent = dirname(dir);
    let aliases: RegExp[];
    if (existsSync(config)) {
      const paths = (TokenName.readJsonc(config) as { compilerOptions?: { paths?: Record<string, unknown> } }).compilerOptions?.paths ?? {};
      aliases = Object.keys(paths).map(
        (key) => new RegExp(`^${key.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`),
      );
    } else {
      aliases = parent === dir ? [] : TokenName.aliasesFor(parent);
    }
    TokenName.aliasesByDir.set(dir, aliases);
    return aliases;
  }

  /** JSON con comentarios y comas finales (`tsconfig.json`): se sacan sin tocar el contenido de los strings. */
  private static readJsonc(path: string): unknown {
    const text = readFileSync(path, "utf8");
    let out = "";
    for (let i = 0; i < text.length; i++) {
      const char = text[i]!;
      if (char === '"') {
        let end = i + 1;
        while (end < text.length && text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
        out += text.slice(i, end + 1);
        i = end;
      } else if (char === "/" && text[i + 1] === "/") {
        while (i < text.length && text[i] !== "\n") i++;
      } else if (char === "/" && text[i + 1] === "*") {
        i = text.indexOf("*/", i + 2) + 1;
      } else {
        out += char;
      }
    }
    try {
      return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
    } catch {
      return {};
    }
  }
}
