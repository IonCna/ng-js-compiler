import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApplicationScanner } from "@/compiler/application-scanner.ts";
import { ModuleWriter } from "@/compiler/module-writer.ts";
import { MetadataStore } from "@/metadata/metadata-store.ts";

describe("ModuleWriter", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ngjs-module-writer-test-"));
    // `TokenName` saca el paquete del package.json más cercano.
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "test-app" }), "utf8");
    MetadataStore.clear();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function write(path: string, code: string): Promise<void> {
    await writeFile(path, code, "utf8");
  }

  it("devuelve undefined si no hay metadata de ngmodule para el path", async () => {
    const scanner = new ApplicationScanner();
    await scanner.scan(dir);
    expect(new ModuleWriter(scanner).write("class Foo {}", join(dir, "foo.ts"))).toBeUndefined();
  });

  it("emite angular.module(id, imports) con .component/.directive/.filter reales para cada declarado", async () => {
    const modulePath = join(dir, "app.module.ts");
    await write(
      modulePath,
      `import { NgModule } from "ngjs-core";
import { CardComponent } from "./card.component.ts";
import { HighlightDirective } from "./highlight.directive.ts";
import { UpperPipe } from "./upper.pipe.ts";

@NgModule({ declarations: [CardComponent, HighlightDirective, UpperPipe], imports: [] })
export class AppModule {}
`,
    );
    await write(
      join(dir, "card.component.ts"),
      `import { Component } from "ngjs-core";

@Component({ selector: "app-card", templateUrl: "./card.component.html" })
export class CardComponent {}
`,
    );
    await write(
      join(dir, "highlight.directive.ts"),
      `import { Directive } from "ngjs-core";

@Directive({ selector: "[appHighlight]" })
export class HighlightDirective {}
`,
    );
    await write(
      join(dir, "upper.pipe.ts"),
      `import { Pipe } from "ngjs-core";

@Pipe({ name: "upper" })
export class UpperPipe {}
`,
    );
    const scanner = new ApplicationScanner();
    await scanner.scan(dir);

    const output = new ModuleWriter(scanner).write("export class AppModule {}", modulePath)!;

    expect(output).toMatch(/angular\.module\("AppModule_[0-9a-f]{8}", \[\]\)/);
    expect(output).toContain('.component("appCard", { controller: CardComponent.ɵfac, templateUrl: "./card.component.html", controllerAs: "$ctrl" })');
    expect(output).toContain('.directive("appHighlight", function () { return { controller: HighlightDirective.ɵfac, restrict: "A", bindToController: true, controllerAs: "appHighlight" }; })');
    expect(output).toContain('.filter("upper", ["$injector", function ($injector) { var instance = $injector.invoke(UpperPipe.ɵfac);');
    expect(output).not.toContain(".service(");
    expect(output.trim().endsWith(";")).toBe(true);
  });

  it("un import (módulo hijo) se referencia por su ɵmod.id — el mismo id determinista que ese módulo estampa", async () => {
    const appModulePath = join(dir, "app.module.ts");
    const featureModulePath = join(dir, "feature.module.ts");
    await write(
      appModulePath,
      `import { NgModule } from "ngjs-core";
import { FeatureModule } from "./feature.module.ts";

@NgModule({ declarations: [], imports: [FeatureModule] })
export class AppModule {}
`,
    );
    await write(
      featureModulePath,
      `import { NgModule } from "ngjs-core";

@NgModule({ declarations: [], imports: [] })
export class FeatureModule {}
`,
    );

    const scanner = new ApplicationScanner();
    await scanner.scan(dir);
    const writer = new ModuleWriter(scanner);

    const appOutput = writer.write("export class AppModule {}", appModulePath)!;
    const featureOutput = writer.write("export class FeatureModule {}", featureModulePath)!;

    // El hijo estampa su id en `ɵmod`; el padre lo referencia (`X.ɵmod.id`) — así el import de su archivo no se elimina.
    const featureId = featureOutput.match(/angular\.module\("([^"]+)"/)?.[1];
    expect(featureOutput).toContain(`FeatureModule.ɵmod = { id: "${featureId}" };`);
    expect(appOutput).toMatch(/angular\.module\("AppModule_[0-9a-f]{8}", \[FeatureModule\.ɵmod\.id\]\)/);
  });

  it("inputs/outputs de un componente se traducen a bindings", async () => {
    const modulePath = join(dir, "app.module.ts");
    await write(
      modulePath,
      `import { NgModule } from "ngjs-core";
import { CardComponent } from "./card.component.ts";

@NgModule({ declarations: [CardComponent], imports: [] })
export class AppModule {}
`,
    );
    await write(
      join(dir, "card.component.ts"),
      `import { Component, Input, Output } from "ngjs-core";

@Component({ selector: "app-card" })
export class CardComponent {
  @Input() count;
  @Output() closed;
}
`,
    );

    const scanner = new ApplicationScanner();
    await scanner.scan(dir);
    const output = new ModuleWriter(scanner).write("export class AppModule {}", modulePath)!;

    expect(output).toContain('bindings: {"count":"<?","closed":"&?"}');
  });

  it("un @Component con selector de atributo tira error claro (no soportado todavía)", async () => {
    const modulePath = join(dir, "app.module.ts");
    await write(
      modulePath,
      `import { NgModule } from "ngjs-core";
import { CardComponent } from "./card.component.ts";

@NgModule({ declarations: [CardComponent], imports: [] })
export class AppModule {}
`,
    );
    await write(
      join(dir, "card.component.ts"),
      `import { Component } from "ngjs-core";

@Component({ selector: "[appCard]" })
export class CardComponent {}
`,
    );

    const scanner = new ApplicationScanner();
    await scanner.scan(dir);

    expect(() => new ModuleWriter(scanner).write("export class AppModule {}", modulePath)).toThrow(
      /selector de atributo.*no soportado/,
    );
  });

  it("el id es determinista para el mismo path+className", async () => {
    const modulePath = join(dir, "app.module.ts");
    await write(
      modulePath,
      `import { NgModule } from "ngjs-core";

@NgModule({ declarations: [], imports: [] })
export class AppModule {}
`,
    );

    const scanner = new ApplicationScanner();
    await scanner.scan(dir);
    const writer = new ModuleWriter(scanner);

    const first = writer.write("export class AppModule {}", modulePath);
    const second = writer.write("export class AppModule {}", modulePath);

    expect(first).toBe(second);
  });

  describe("bootstrap", () => {
    async function writeApp(bootstrap: string, declarations: string): Promise<() => string> {
      const modulePath = join(dir, "app.module.ts");
      await write(
        modulePath,
        `import { NgModule } from "ngjs-core";
import { AppComponent } from "./app.component.ts";

@NgModule({ declarations: ${declarations}, imports: [], bootstrap: ${bootstrap} })
export class AppModule {}
`,
      );
      await write(
        join(dir, "app.component.ts"),
        `import { Component } from "ngjs-core";

@Component({ selector: "app-root", template: "" })
export class AppComponent {}
`,
      );
      const scanner = new ApplicationScanner();
      await scanner.scan(dir);
      return () => new ModuleWriter(scanner).write("export class AppModule {}", modulePath)!;
    }

    it("ɵmod lleva los tags de bootstrap para que bootstrapModule() los monte", async () => {
      const output = (await writeApp("[AppComponent]", "[AppComponent]"))();
      expect(output).toMatch(/AppModule\.ɵmod = \{ id: "AppModule_[0-9a-f]{8}", bootstrap: \["app-root"\] \};/);
    });

    it("un componente de bootstrap que no está en declarations es error, como en Angular", async () => {
      const writeModule = await writeApp("[AppComponent]", "[]");
      expect(writeModule).toThrow(/"AppComponent" está en bootstrap de "AppModule" pero no es un @Component de sus declarations/);
    });
  });

  async function moduleWithProviders(providers: string): Promise<() => string> {
    const modulePath = join(dir, "app.module.ts");
    await write(
      modulePath,
      `import { NgModule } from "ngjs-core";

@NgModule({ declarations: [], imports: [], providers: ${providers} })
export class AppModule {}
`,
    );
    const scanner = new ApplicationScanner();
    await scanner.scan(dir);
    return () => new ModuleWriter(scanner).write("export class AppModule {}", modulePath)!;
  }

  it("providers: el último de un token gana, como en Angular", async () => {
    const output = (await moduleWithProviders(`[{ provide: "api", useValue: "a" }, { provide: "api", useValue: "b" }]`))();

    expect(output).toContain('.value("api", "b")');
    expect(output).not.toContain('.value("api", "a")');
  });

  it("providers: mezclar multi y no-multi para el mismo token es error", async () => {
    const writeModule = await moduleWithProviders(`[{ provide: "hooks", useValue: "a", multi: true }, { provide: "hooks", useValue: "b" }]`);

    expect(writeModule).toThrow(/mezcla providers multi y no-multi para el token "hooks"/);
  });
});
