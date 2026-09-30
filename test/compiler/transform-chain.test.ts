import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { originalPositionFor, TraceMap } from "@jridgewell/trace-mapping";
import * as esbuild from "esbuild";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApplicationScanner } from "@/compiler/application-scanner.ts";
import { CodeEdit } from "@/compiler/code-edit.ts";
import { createNgjsCompilerTransforms } from "@/compiler/ngjs-compiler-transforms.ts";
import type { NgjsTransform, TransformSourceMap } from "@/compiler/ngjs-transform.ts";
import { TransformChain } from "@/compiler/transform-chain.ts";
import { pluginLoader } from "@/esbuild/plugin-loader.ts";

/** Un componente con un decorador de varias líneas (se saca) y un `@NgModule` (el `import` de angular va arriba). */
const SOURCE = `import { Component, NgModule } from "ngjs-core";

@Component({
  selector: "app-card",
  template: "<b>card</b>",
})
export class CardComponent {
  explode(): never {
    throw new Error("boom");
  }
}

@NgModule({ declarations: [CardComponent] })
export class AppModule {}
`;

/** La línea (1-based) donde está `needle` en `code`. */
function lineOf(code: string, needle: string): { line: number; column: number } {
  const lines = code.split("\n");
  const index = lines.findIndex((line) => line.includes(needle));
  return { line: index + 1, column: lines[index]!.indexOf(needle) };
}

function original(map: TransformSourceMap, code: string, needle: string) {
  return originalPositionFor(new TraceMap(map as never), lineOf(code, needle));
}

describe("TransformChain", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ngjs-transform-chain-test-"));
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "test-app" }), "utf8");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("la cadena del compilador devuelve un mapa al TypeScript original, aunque saque decoradores y agregue código arriba", async () => {
    const file = join(dir, "card.component.ts");
    await writeFile(file, SOURCE, "utf8");
    const scanner = new ApplicationScanner();
    await scanner.scan(dir);

    const output = (await TransformChain.run(SOURCE, file, createNgjsCompilerTransforms(scanner)))!;

    expect(output.code).not.toContain("@Component");
    expect(lineOf(output.code, "boom").line).not.toBe(9);
    expect(output.map).not.toBeNull();
    expect(output.map!.sources).toEqual([file]);
    expect(output.map!.sourcesContent).toEqual([SOURCE]);
    expect(original(output.map!, output.code, "boom")).toMatchObject({ source: file, line: 9 });
  });

  it("un paso que devuelve solo un string corta el mapa (sin saber qué movió, apuntaría a líneas equivocadas)", async () => {
    const withMap: NgjsTransform = { transform: async (code, path) => CodeEdit.append(code, path, "\nexport const a = 1;\n") };
    const withoutMap: NgjsTransform = { transform: async (code) => `// arriba\n${code}` };

    expect((await TransformChain.run("export const x = 1;\n", "x.ts", [withMap]))!.map).not.toBeNull();
    expect((await TransformChain.run("export const x = 1;\n", "x.ts", [withMap, withoutMap]))!.map).toBeNull();
  });

  it("sin cambios devuelve undefined", async () => {
    const noop: NgjsTransform = { transform: async () => undefined };
    expect(await TransformChain.run("export const x = 1;\n", "x.ts", [noop])).toBeUndefined();
  });

  it("con esbuild (`sourcemap`), el mapa del bundle apunta al .ts original", async () => {
    const file = join(dir, "card.component.ts");
    await writeFile(file, SOURCE, "utf8");

    const result = await esbuild.build({
      entryPoints: [file],
      bundle: false,
      write: false,
      sourcemap: "external",
      outdir: join(dir, "out"),
      plugins: [pluginLoader(dir, [], {}, "library")],
    });

    const js = result.outputFiles.find((out) => out.path.endsWith(".js"))!.text;
    const map = JSON.parse(result.outputFiles.find((out) => out.path.endsWith(".js.map"))!.text) as TransformSourceMap;
    const position = original(map, js, "boom");
    expect(position.line).toBe(9);
    expect(position.source).toMatch(/card\.component\.ts$/);
    expect(map.sourcesContent).toEqual([SOURCE]);
  });
});
