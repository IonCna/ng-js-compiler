import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NgjsTransform } from "@/compiler/ngjs-transform.ts";
import { ProjectScan } from "@/vite/project-scan.ts";

describe("ProjectScan (re-escaneo del dev-server)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "project-scan-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("covers(): solo los .ts dentro de sourceRoot", () => {
    const scan = new ProjectScan(join(dir, "src"), []);
    expect(scan.covers(join(dir, "src", "app", "a.module.ts"))).toBe(true);
    expect(scan.covers(join(dir, "src", "app", "a.component.html"))).toBe(false);
    expect(scan.covers(join(dir, "src-other", "a.ts"))).toBe(false);
    expect(scan.covers(join(dir, "node_modules", "x", "index.ts"))).toBe(false);
  });

  it("ready() espera el escaneo en curso: los transforms nuevos incluyen los del compilador", async () => {
    await mkdir(join(dir, "src"));
    const extra: NgjsTransform = { transform: async () => undefined };
    const scan = new ProjectScan(join(dir, "src"), [extra]);

    expect(await scan.ready()).toEqual([extra]); // sin escanear todavía: solo los previos
    void scan.rescan();
    const transforms = await scan.ready();
    expect(transforms[0]).toBe(extra);
    expect(transforms.length).toBeGreaterThan(1);
  });

  it("un escaneo fallido sale en ready() y el siguiente cambio lo reintenta", async () => {
    const root = join(dir, "src");
    const scan = new ProjectScan(root, []);

    await writeFile(join(dir, "placeholder"), ""); // `src` todavía no existe → el escaneo falla
    await expect(scan.rescan()).rejects.toThrow();
    await expect(scan.ready()).rejects.toThrow();

    await mkdir(root);
    await writeFile(join(root, "a.ts"), "export const a = 1;\n");
    await scan.rescan();
    expect((await scan.ready()).length).toBeGreaterThan(0);
  });
});
