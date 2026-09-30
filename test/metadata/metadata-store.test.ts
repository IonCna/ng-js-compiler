import { afterEach, describe, expect, it } from "vitest";
import type { ComponentMetadata } from "@/metadata/decorator-metadata.ts";
import { MetadataStore } from "@/metadata/metadata-store.ts";

describe("MetadataStore", () => {
  afterEach(() => {
    MetadataStore.clear();
  });

  it("devuelve [] si no hay nada guardado para un path", () => {
    expect(MetadataStore.get("nunca-guardado.ts")).toEqual([]);
  });

  it("guarda y devuelve la metadata por path", () => {
    const metadata: ComponentMetadata = {
      kind: "component",
      className: "CardComponent",
      options: { selector: "app-card" },
      constructorTokens: [], constructorFlags: [], constructorAttributes: [], injectTokens: [], constructorImports: [],
      inputs: [],
      outputs: [],
      hostBindings: [],
      hostListeners: [],
      providers: [],
      lifecycleHooks: [],
      queries: [],
      hostDirectives: [],
    };

    MetadataStore.set("card.component.ts", [metadata]);

    expect(MetadataStore.get("card.component.ts")).toEqual([metadata]);
  });

  it("no mezcla metadata entre paths distintos", () => {
    MetadataStore.set("a.ts", [
      { kind: "component", className: "A", options: {}, constructorTokens: [], constructorFlags: [], constructorAttributes: [], injectTokens: [], constructorImports: [], inputs: [], outputs: [], hostBindings: [], hostListeners: [], providers: [], lifecycleHooks: [], queries: [], hostDirectives: [] },
    ]);

    expect(MetadataStore.get("b.ts")).toEqual([]);
  });

  it("delete() saca la entrada de un path", () => {
    MetadataStore.set("a.ts", []);
    MetadataStore.delete("a.ts");
    expect(MetadataStore.entries()).toEqual([]);
  });

  it("within(): cada scope ve solo lo suyo, también después de un await, y no toca el scope por defecto", async () => {
    const a = MetadataStore.scope();
    const b = MetadataStore.scope();
    const pipe = (className: string) => ({ kind: "pipe", className, options: { name: className }, constructorTokens: [], constructorFlags: [], constructorAttributes: [], injectTokens: [], constructorImports: [] }) as never;

    await Promise.all([
      MetadataStore.within(a, async () => {
        MetadataStore.set("x.ts", [pipe("A")]);
        await Promise.resolve();
        expect(MetadataStore.get("x.ts")[0]).toMatchObject({ className: "A" });
      }),
      MetadataStore.within(b, async () => {
        MetadataStore.set("x.ts", [pipe("B")]);
        await Promise.resolve();
        expect(MetadataStore.get("x.ts")[0]).toMatchObject({ className: "B" });
      }),
    ]);

    expect(MetadataStore.get("x.ts")).toEqual([]);
  });
});

