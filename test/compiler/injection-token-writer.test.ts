import { describe, expect, it } from "vitest";
import { InjectionTokenWriter } from "@/compiler/injection-token-writer.ts";
import { TokenName } from "@/compiler/token-name.ts";

/** Paquete de los archivos de test (`tokens.ts` relativo al cwd → el `package.json` del compilador). */
const own = (symbol: string) => TokenName.of(symbol, "ng-js-compiler");

describe("InjectionTokenWriter", () => {
  it("sin `new InjectionToken` no toca nada", async () => {
    expect(await InjectionTokenWriter.write(`export const API = "x";`, "tokens.ts")).toBeUndefined();
  });

  it("estampa ɵprov con el mismo nombre que TokenName calcula en build — exportado o no, varios por declaración", async () => {
    const code = `import { InjectionToken } from "ngjs-core";
export const API_URL = new InjectionToken<string>("api.url");
const HOOKS = new InjectionToken<string[]>("hooks"), PLAIN = 1;
`;

    const output = (await InjectionTokenWriter.write(code, "tokens.ts"))!;

    expect(output.startsWith(code)).toBe(true);
    expect(output).toContain(`API_URL.ɵprov = { token: ${JSON.stringify(own("API_URL"))} };`);
    expect(output).toContain(`HOOKS.ɵprov = { token: ${JSON.stringify(own("HOOKS"))} };`);
    expect(output).not.toContain("PLAIN.ɵprov");
  });

  it("con { factory }: se provee solo (providedIn root, la cola de la plataforma), con sus inject() como deps", async () => {
    const code = `import { HttpClient } from "ngjs-core/http";
export const API = new InjectionToken<string>("api", { providedIn: "root", factory: () => inject(HttpClient).base + "/api" });
`;

    const output = (await InjectionTokenWriter.write(code, "tokens.ts"))!;
    const http = JSON.stringify(TokenName.of("HttpClient", "ngjs-core"));

    expect(output).toContain(
      `API.ɵprov = { token: ${JSON.stringify(own("API"))}, providedIn: "root", factory: [${http}, function (i0) { var ɵprevious = globalThis.ɵngjsInjected; globalThis.ɵngjsInjected = { "ɵfactory": [i0] }; try { return (() => globalThis.ɵngjsInjected["ɵfactory"][0].base + "/api")(); } finally { globalThis.ɵngjsInjected = ɵprevious; } }] };`,
    );
    expect(output).toContain(`.push([${JSON.stringify(own("API"))}, API.ɵprov.factory]);`);
  });

  it("providedIn distinto de root con factory es error en build", async () => {
    const code = `export const API = new InjectionToken("api", { providedIn: "any", factory: () => 1 });`;

    await expect(InjectionTokenWriter.write(code, "tokens.ts")).rejects.toThrow(/solo `providedIn: "root"` está soportado/);
  });

  it("solo a nivel de archivo: un token dentro de una función no tiene símbolo que importar", async () => {
    const code = `export function make() { const LOCAL = new InjectionToken("local"); return LOCAL; }`;

    expect(await InjectionTokenWriter.write(code, "tokens.ts")).toBeUndefined();
  });
});
