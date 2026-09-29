import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApplicationScanner } from "@/compiler/application-scanner.ts";
import { LibraryManifest } from "@/compiler/library-manifest.ts";
import { MetadataStore } from "@/metadata/metadata-store.ts";

describe("LibraryManifest", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ngjs-library-manifest-test-"));
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "test-lib" }), "utf8");
    MetadataStore.clear();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("publica selector, inputs (con su modo) y outputs de cada @Component/@Directive, con los heredados", async () => {
    await writeFile(
      join(dir, "toast.component.ts"),
      `import { Component, Directive, Injectable, Input, Output } from "ngjs-core";

@Directive()
export class BaseToggle {
  @Input() disabled;
  @Output() hidden;
}

@Component({ selector: "lib-toast", template: "<div></div>" })
export class LibToast extends BaseToggle {
  @Input({ binding: "@" }) header;
  @Input("toastDelay") delay;
  @Output("afterShown") shown;
}

@Directive({ selector: "[libTip]" })
export class LibTip {
  @Input() libTip;
}

@Directive({ selector: "[libPrivate]" })
class LibPrivate {}

@Injectable({ providedIn: "root" })
export class LibService {}
`,
      "utf8",
    );

    const scanner = new ApplicationScanner();
    await scanner.scan(dir);

    expect(LibraryManifest.from(scanner)).toEqual({
      version: 1,
      declarations: [
        {
          className: "LibTip",
          kind: "directive",
          selector: "[libTip]",
          inputs: [{ property: "libTip", name: "libTip", mode: "<" }],
          outputs: [],
        },
        {
          className: "LibToast",
          kind: "component",
          selector: "lib-toast",
          inputs: expect.arrayContaining([
            { property: "disabled", name: "disabled", mode: "<" },
            { property: "header", name: "header", mode: "@" },
            { property: "delay", name: "toastDelay", mode: "<" },
          ]),
          outputs: expect.arrayContaining([
            { property: "hidden", name: "hidden" },
            { property: "shown", name: "afterShown" },
          ]),
        },
      ],
    });
  });

  it("fromSources: lo mismo que el escaneo, sin tocar MetadataStore (global)", async () => {
    await writeFile(
      join(dir, "rating.component.ts"),
      `import { Component, Directive, Input, Output } from "ngjs-core";

@Directive()
export class BaseControl {
  @Input() disabled;
}

@Component({ selector: "lib-rating" })
export class LibRating extends BaseControl {
  @Input() readonly;
  @Output() rateChange;
}
`,
      "utf8",
    );

    const fromSources = await LibraryManifest.fromSources(dir);
    expect(MetadataStore.entries()).toEqual([]);

    const scanner = new ApplicationScanner();
    await scanner.scan(dir);
    expect(fromSources).toEqual(LibraryManifest.from(scanner));
    expect(fromSources.declarations[0]!.inputs.map((input) => input.name).sort()).toEqual(["disabled", "readonly"]);
  });

  it("fromDependencies: lee el manifiesto junto al entry de cada dependencia que lo publica", async () => {
    const app = join(dir, "app");
    const toast = { className: "LibToast", kind: "component", selector: "lib-toast", inputs: [], outputs: [{ property: "hidden", name: "hidden" }] };
    await mkdir(join(app, "src"), { recursive: true });
    await writeFile(
      join(app, "package.json"),
      JSON.stringify({ name: "app", dependencies: { "ui-lib": "*", "plain-lib": "*" }, devDependencies: { "missing-lib": "*" } }),
    );
    // `ui-lib` en el `node_modules` de un directorio de arriba (como lo resuelve Node), con entry en `exports`.
    const uiLib = join(dir, "node_modules", "ui-lib");
    await mkdir(join(uiLib, "dist"), { recursive: true });
    await writeFile(join(uiLib, "package.json"), JSON.stringify({ name: "ui-lib", exports: { ".": { import: "./dist/index.js" } } }));
    await writeFile(join(uiLib, "dist", LibraryManifest.FILE_NAME), JSON.stringify({ version: 1, declarations: [toast] }));
    // `plain-lib` sin manifiesto: no es de ngjs.
    const plainLib = join(app, "node_modules", "plain-lib");
    await mkdir(plainLib, { recursive: true });
    await writeFile(join(plainLib, "package.json"), JSON.stringify({ name: "plain-lib", main: "index.js" }));

    expect(await LibraryManifest.fromDependencies(join(app, "src"))).toEqual([toast]);
  });
});
