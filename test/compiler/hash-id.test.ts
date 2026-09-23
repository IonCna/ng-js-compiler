import { describe, expect, it } from "vitest";
import { HashId } from "@/compiler/hash-id.ts";

describe("HashId", () => {
  it("from() es determinístico para las mismas partes", () => {
    expect(HashId.from("a.ts", "Foo")).toBe(HashId.from("a.ts", "Foo"));
  });

  it("from() da valores distintos para inputs distintos", () => {
    expect(HashId.from("a.ts", "Foo")).not.toBe(HashId.from("b.ts", "Foo"));
  });

  it("readable() prefija con el nombre — legible en un error de AngularJS", () => {
    const id = HashId.readable("AppModule", "src/app.module.ts");
    expect(id).toMatch(/^AppModule_[0-9a-f]{8}$/);
  });

  it("readable() no colisiona si dos clases distintas comparten nombre en archivos distintos", () => {
    const a = HashId.readable("AppModule", "features/a/app.module.ts");
    const b = HashId.readable("AppModule", "features/b/app.module.ts");
    expect(a).not.toBe(b);
  });
});
