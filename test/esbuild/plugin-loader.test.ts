import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { MetadataStore } from "@/metadata/metadata-store.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as esbuild from "esbuild";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NgjsTransform } from "@/compiler/ngjs-transform.ts";
import { PlatformCode } from "@/compiler/platform-code.ts";
import { pluginLoader } from "@/esbuild/plugin-loader.ts";

describe("pluginLoader", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "plugin-loader-test-"));
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "test-app" }));
    MetadataStore.clear();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("corre los transforms en orden, cada uno viendo el resultado del anterior, y solo registra un onLoad", async () => {
    const file = join(dir, "entry.ts");
    await writeFile(file, "export const x = 1;");

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

    const result = await esbuild.build({
      entryPoints: [file],
      bundle: false,
      write: false,
      format: "esm",
      plugins: [pluginLoader(dir, [replaceValue, noop])],
    });

    // Una vez en el escaneo (que ve el mismo código que la emisión) y otra al emitir.
    expect(calls).toEqual(["replaceValue", "noop", "replaceValue", "noop"]);
    expect(result.outputFiles[0]?.text).toContain("42");
  });

  it("inyecta la plataforma al inicio del bundle (banner), antes del banner que ya tuviera el build", async () => {
    const file = join(dir, "entry.ts");
    await writeFile(file, "export const x = 1;");

    const result = await esbuild.build({
      entryPoints: [file],
      bundle: false,
      write: false,
      format: "esm",
      banner: { js: "/* propio */" },
      plugins: [pluginLoader(dir)],
    });

    const text = result.outputFiles[0]!.text;
    expect(text.startsWith(PlatformCode.source())).toBe(true);
    expect(text.indexOf("/* propio */")).toBeGreaterThan(text.indexOf("globalThis.ɵngjsPlatform ="));
  });

  it("en una aplicación baja async/await de las dependencias (lo que no pasa por el compilador) sin tocar el target", async () => {
    const dep = join(dir, "dep.js");
    await writeFile(dep, "export async function depLoad(x) { const v = await x; return v?.ok ?? false; }\n");
    const file = join(dir, "entry.ts");
    await writeFile(file, `export { depLoad } from "./dep.js";`);

    const result = await esbuild.build({
      entryPoints: [file],
      bundle: true,
      write: false,
      format: "esm",
      target: "es2022",
      plugins: [pluginLoader(dir)],
    });

    const bundle = result.outputFiles[0]!.text.slice(PlatformCode.source().length);
    expect(bundle).toContain("depLoad");
    expect(bundle).not.toMatch(/\bawait\b/);
    expect(bundle).toContain("?."); // target es2022 intacto: solo se bajó async/await
  });

  it("en una librería no inyecta la plataforma (una librería no arranca nada)", async () => {
    const file = join(dir, "entry.ts");
    await writeFile(file, "export const x = 1;");

    const result = await esbuild.build({
      entryPoints: [file],
      bundle: false,
      write: false,
      format: "esm",
      plugins: [pluginLoader(dir, [], {}, "library")],
    });

    expect(result.outputFiles[0]!.text).not.toContain("ɵngjsPlatform");
  });

  it("fileReplacements redirige a otro archivo y ese archivo también pasa por los transforms", async () => {
    const original = join(dir, "environment.ts");
    const replacement = join(dir, "environment.prod.ts");
    await writeFile(original, "export const production = false;");
    await writeFile(replacement, "export const production = true;");

    const seenPaths: string[] = [];
    const track: NgjsTransform = {
      async transform(_code, path) {
        seenPaths.push(path);
        return undefined;
      },
    };

    const result = await esbuild.build({
      entryPoints: [original],
      bundle: false,
      write: false,
      format: "esm",
      plugins: [pluginLoader(dir, [track], { [original]: replacement })],
    });

    // El escaneo también lee el reemplazo (por el original y por sí mismo), nunca el original; después la emisión.
    expect(seenPaths).toEqual([replacement, replacement, replacement]);
    expect(result.outputFiles[0]?.text).toContain("production = true");
  });

  it("el escaneo ve lo que dejan los transforms previos: un template inlineado se registra inline, no como templateUrl", async () => {
    await writeFile(
      join(dir, "card.component.ts"),
      `import { Component } from "ngjs-core";
@Component({ selector: "app-card", templateUrl: "./card.html" })
export class CardComponent {}
`,
    );
    await writeFile(
      join(dir, "app.module.ts"),
      `import { NgModule } from "ngjs-core";
import { CardComponent } from "./card.component";
@NgModule({ declarations: [CardComponent] })
export class AppModule {}
`,
    );
    // Como `templateTransform` de `ng-js-vite`: reemplaza `templateUrl` por el template inline.
    const inlineTemplate: NgjsTransform = {
      async transform(code) {
        return code.includes("templateUrl") ? code.replace(`templateUrl: "./card.html"`, `template: "<b>card</b>"`) : undefined;
      },
    };

    const result = await esbuild.build({
      entryPoints: [join(dir, "app.module.ts")],
      bundle: true,
      write: false,
      format: "esm",
      external: ["angular", "ngjs-core"],
      plugins: [pluginLoader(dir, [inlineTemplate], {}, "library")],
    });

    const text = result.outputFiles[0]!.text;
    expect(text).toContain(`template: "<b>card</b>"`);
    expect(text).not.toContain("templateUrl");
  });

  it("si el escaneo falla, el build reporta ESE error (no uno de sintaxis por cada archivo TypeScript)", async () => {
    await writeFile(
      join(dir, "svc.ts"),
      `import { Injectable } from "ngjs-core";
export type Id = string;
@Injectable()
export class Svc { constructor(id: string) {} }
`,
    );

    const failure = await esbuild
      .build({ entryPoints: [join(dir, "svc.ts")], bundle: false, write: false, format: "esm", logLevel: "silent", plugins: [pluginLoader(dir, [], {}, "library")] })
      .catch((error: esbuild.BuildFailure) => error);

    const texts = (failure as esbuild.BuildFailure).errors.map((error) => error.text);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain("no tiene tipo de clase ni @Inject()");
  });
});
