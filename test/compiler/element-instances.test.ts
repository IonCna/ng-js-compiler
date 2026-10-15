import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DecoratorReader } from "@/compiler/decorator-reader.ts";
import { ElementInstances } from "@/compiler/element-instances.ts";
import { TokenName } from "@/compiler/token-name.ts";
import { MetadataStore } from "@/metadata/metadata-store.ts";

const token = (className: string) => TokenName.of(className, "test-app");

describe("ElementInstances.namesFor", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ngjs-element-instances-test-"));
    // `TokenName` saca el paquete del package.json más cercano.
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "test-app" }), "utf8");
    MetadataStore.clear();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  const read = (file: string, code: string) => DecoratorReader.read(code, join(dir, file));

  it("da los nombres de registro de una clase elemento, también por su base; undefined si no es elemento", async () => {
    await read(
      "base-tabs.ts",
      `import { Directive } from "ngjs-core";

@Directive()
export abstract class BaseTabs {}
`,
    );
    await read(
      "tabs.component.ts",
      `import { Component } from "ngjs-core";
import { BaseTabs } from "./base-tabs.ts";

@Component({ selector: "app-tabs", template: "" })
export class TabsComponent extends BaseTabs {}
`,
    );
    await read(
      "user.service.ts",
      `import { Injectable } from "ngjs-core";

@Injectable()
export class UserService {}
`,
    );

    expect(ElementInstances.namesFor(token("TabsComponent"))).toEqual(["appTabs"]);
    expect(ElementInstances.namesFor(token("BaseTabs"))).toEqual(["appTabs"]);
    expect(ElementInstances.namesFor(token("UserService"))).toBeUndefined();
  });

  // `DecoratorWriter` pregunta por cada dependencia de cada componente: recorrer el proyecto en cada pregunta costaba
  // segundos por archivo. El índice se arma una vez y se rehace solo cuando el store cambia.
  it("arma el índice una vez mientras el store no cambie y lo rehace cuando cambia", async () => {
    await read(
      "tabs.component.ts",
      `import { Component } from "ngjs-core";

@Component({ selector: "app-tabs", template: "" })
export class TabsComponent {}
`,
    );
    const entries = vi.spyOn(MetadataStore, "entries");

    ElementInstances.namesFor(token("TabsComponent"));
    ElementInstances.namesFor(token("TabsComponent"));
    ElementInstances.namesFor(token("Other"));
    expect(entries).toHaveBeenCalledTimes(1);

    await read(
      "tab.directive.ts",
      `import { Directive } from "ngjs-core";

@Directive({ selector: "[appTab]" })
export class TabDirective {}
`,
    );
    expect(ElementInstances.namesFor(token("TabDirective"))).toEqual(["appTab"]);
    expect(entries).toHaveBeenCalledTimes(2);
  });
});
