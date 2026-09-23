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
      constructorTokens: [], constructorImports: [],
      inputs: [],
      outputs: [],
      hostBindings: [],
      hostListeners: [],
      providers: [],
      lifecycleHooks: [],
    };

    MetadataStore.set("card.component.ts", [metadata]);

    expect(MetadataStore.get("card.component.ts")).toEqual([metadata]);
  });

  it("no mezcla metadata entre paths distintos", () => {
    MetadataStore.set("a.ts", [
      { kind: "component", className: "A", options: {}, constructorTokens: [], constructorImports: [], inputs: [], outputs: [], hostBindings: [], hostListeners: [], providers: [], lifecycleHooks: [] },
    ]);

    expect(MetadataStore.get("b.ts")).toEqual([]);
  });
});
