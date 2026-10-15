import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TokenName } from "@/compiler/token-name.ts";

const fs = vi.hoisted(() => ({ existsSync: vi.fn<(path: string) => boolean>() }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  fs.existsSync.mockImplementation((path) => actual.existsSync(path));
  return { ...actual, existsSync: fs.existsSync };
});

describe("TokenName.packageOf", () => {
  let dir: string;

  beforeEach(async () => {
    // Carpeta nueva en cada test: la caché de `TokenName` es estática y dura todo el proceso.
    dir = await mkdtemp(join(tmpdir(), "ngjs-token-name-test-"));
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "test-app" }), "utf8");
    await mkdir(join(dir, "src", "app", "feature"), { recursive: true });
    fs.existsSync.mockClear();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("toma el name del package.json más cercano", () => {
    expect(TokenName.packageOf(join(dir, "src", "app", "feature", "a.ts"))).toBe("test-app");
  });

  it("no vuelve a subir carpetas para un archivo cuya carpeta ya se resolvió", () => {
    TokenName.packageOf(join(dir, "src", "app", "feature", "a.ts"));
    fs.existsSync.mockClear();

    TokenName.packageOf(join(dir, "src", "app", "feature", "b.ts"));
    TokenName.packageOf(join(dir, "src", "app", "c.ts"));

    expect(fs.existsSync).not.toHaveBeenCalled();
  });

  // El recorrido que corta en una carpeta ya conocida (acá `src/`) también deja en caché las que pasó: antes solo se
  // guardaban cuando aparecía el package.json, y cada pedido desde `feature/` volvía a subir con `existsSync`.
  it("deja en caché las carpetas recorridas aunque el recorrido corte en una conocida", () => {
    TokenName.packageOf(join(dir, "src", "main.ts"));
    TokenName.packageOf(join(dir, "src", "app", "feature", "a.ts"));
    fs.existsSync.mockClear();

    TokenName.packageOf(join(dir, "src", "app", "feature", "a.ts"));
    TokenName.packageOf(join(dir, "src", "app", "b.ts"));

    expect(fs.existsSync).not.toHaveBeenCalled();
  });
});
