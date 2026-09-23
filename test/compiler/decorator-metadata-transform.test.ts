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
});
