import { describe, expect, it } from "vitest";
import type { NgjsTransform } from "@/compiler/ngjs-transform.ts";
import { PlatformCode } from "@/compiler/platform-code.ts";
import { viteTransformPlugin } from "@/vite/vite-transform-plugin.ts";

describe("viteTransformPlugin", () => {
  it("tiene enforce: 'pre' (crítico: debe correr antes del transform interno de Vite)", () => {
    const plugin = viteTransformPlugin(".", []);
    expect(plugin.enforce).toBe("pre");
  });

  it("ignora archivos que no terminan en .ts", async () => {
    const calls: string[] = [];
    const track: NgjsTransform = {
      async transform(code) {
        calls.push(code);
        return undefined;
      },
    };

    const plugin = viteTransformPlugin(".", [track]);
    // @ts-expect-error — `transform` en el tipo `Plugin` de Vite puede ser objeto/función; acá siempre es función.
    const result = await plugin.transform("const x = 1;", "foo.js");

    expect(result).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it("corre los transforms en orden, encadenando el resultado, y solo transforma si algo cambió", async () => {
    const calls: string[] = [];
    const replaceValue: NgjsTransform = {
      async transform(code) {
        calls.push("replaceValue");
        return code.replace("1", "42");
      },
    };
    const noop: NgjsTransform = {
      async transform() {
        calls.push("noop");
        return undefined;
      },
    };

    const plugin = viteTransformPlugin(".", [replaceValue, noop]);
    // @ts-expect-error — ver nota arriba.
    const result = await plugin.transform("const x = 1;", "foo.ts");

    expect(calls).toEqual(["replaceValue", "noop"]);
    expect(result).toEqual({ code: "const x = 42;", map: null });
  });

  it("inyecta la plataforma como <script> clásico al principio del <head>", () => {
    const plugin = viteTransformPlugin(".", []);
    // @ts-expect-error — `transformIndexHtml` en el tipo `Plugin` de Vite puede ser objeto/función; acá siempre es función.
    expect(plugin.transformIndexHtml()).toEqual([{ tag: "script", children: PlatformCode.source(), injectTo: "head-prepend" }]);
  });

  it("en una librería no inyecta la plataforma", () => {
    const plugin = viteTransformPlugin(".", [], "library");
    // @ts-expect-error — ver nota arriba.
    expect(plugin.transformIndexHtml()).toEqual([]);
  });

  it("devuelve undefined si ningún transform cambió el código", async () => {
    const noop: NgjsTransform = { async transform() { return undefined; } };

    const plugin = viteTransformPlugin(".", [noop]);
    // @ts-expect-error — ver nota arriba.
    const result = await plugin.transform("const x = 1;", "foo.ts");

    expect(result).toBeUndefined();
  });
});
