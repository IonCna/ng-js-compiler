import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

    expect(calls).toEqual(["replaceValue", "noop"]);
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

    expect(seenPaths).toEqual([replacement]);
    expect(result.outputFiles[0]?.text).toContain("production = true");
  });
});
