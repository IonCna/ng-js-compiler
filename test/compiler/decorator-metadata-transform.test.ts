import { describe, expect, it } from "vitest";
import { decoratorMetadataTransform } from "@/compiler/decorator-metadata-transform.ts";

describe("decoratorMetadataTransform", () => {
  it("pasa TS → JS sin emitir design:paramtypes (los tokens ya salen resueltos en ɵfac)", async () => {
    const code = `
      function Inject(t: unknown): ParameterDecorator { return () => {}; }
      class Config {}
      class Api {
        constructor(@Inject(Config) public config: Config) {}
      }
    `;

    const result = await decoratorMetadataTransform.transform(code, "api.ts");

    expect(result).not.toContain("design:paramtypes");
    expect(result).not.toContain(": Config");
    expect(result).not.toMatch(/@Inject/);
  });

  it("no necesita experimentalDecorators en un tsconfig.json (SWC parsea solo)", async () => {
    const code = `
      function Log(): ClassDecorator { return () => {}; }
      @Log()
      class Plain {}
    `;

    await expect(decoratorMetadataTransform.transform(code, "plain.ts")).resolves.toBeDefined();
  });

  it("baja async/await y for await a generadores (reanudan con .then(), el que parchea la zona); el resto queda ES2022", async () => {
    const code = `
      class Loader {
        #cache = new Map<string, unknown>();
        async load(url: string) { const res = await fetch(url); return res?.ok ?? false; }
        async drain(items: AsyncIterable<number>) { for await (const item of items) this.#cache.set(String(item), item); }
      }
      export const arrow = async () => await Promise.resolve(1);
      export async function* stream() { yield await Promise.resolve(1); }
    `;

    const result = (await decoratorMetadataTransform.transform(code, "loader.ts"))!;

    expect(result).not.toMatch(/\bawait\b/);
    expect(result).not.toMatch(/\basync\s+(function|\(|\w+\s*\()/);
    expect(result).toContain(".then(");
    expect(result).toContain("#cache"); // privados nativos: no se bajó el target
    expect(result).toContain("?.");
  });
});
