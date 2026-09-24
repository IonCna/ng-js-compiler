import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApplicationScanner } from "@/compiler/application-scanner.ts";
import { MetadataStore } from "@/metadata/metadata-store.ts";

describe("ApplicationScanner", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ngjs-scanner-test-"));
    // `TokenName` saca el paquete del package.json más cercano.
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "test-app" }), "utf8");
    MetadataStore.clear();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // "app.module.ts" ordena ANTES que "card.component.ts" alfabéticamente — a propósito,
  // así el escaneo ya ejercita el caso en que el módulo se lee antes que lo que declara.
  it("resuelve declarations/imports sin importar el orden de escaneo", async () => {
    await writeFile(
      join(dir, "app.module.ts"),
      `import { NgModule } from "ngjs-core";
import { CardComponent } from "./card.component.ts";
import { HighlightDirective } from "./highlight.directive.ts";
import { UpperPipe } from "./upper.pipe.ts";

@NgModule({ declarations: [CardComponent, HighlightDirective, UpperPipe], imports: [] })
export class AppModule {}
`,
      "utf8",
    );
    await writeFile(
      join(dir, "card.component.ts"),
      `import { Component } from "ngjs-core";

@Component({ selector: "app-card" })
export class CardComponent {}
`,
      "utf8",
    );
    await writeFile(
      join(dir, "highlight.directive.ts"),
      `import { Directive } from "ngjs-core";

@Directive({ selector: "[appHighlight]" })
export class HighlightDirective {}
`,
      "utf8",
    );
    await writeFile(
      join(dir, "upper.pipe.ts"),
      `import { Pipe } from "ngjs-core";

@Pipe({ name: "upper" })
export class UpperPipe {}
`,
      "utf8",
    );

    const scanner = new ApplicationScanner();
    await scanner.scan(dir);

    const appModule = scanner.get("AppModule");
    expect(appModule?.declarations.components.map((n) => n.className)).toEqual(["CardComponent"]);
    expect(appModule?.declarations.directives.map((n) => n.className)).toEqual(["HighlightDirective"]);
    expect(appModule?.declarations.pipes.map((n) => n.className)).toEqual(["UpperPipe"]);

    expect(scanner.get("CardComponent")?.metadata.kind).toBe("component");
  });

  it("resuelve imports (módulos hijos) a nodos reales", async () => {
    await writeFile(
      join(dir, "app.module.ts"),
      `import { NgModule } from "ngjs-core";
import { FeatureModule } from "./feature.module.ts";

@NgModule({ declarations: [], imports: [FeatureModule] })
export class AppModule {}
`,
      "utf8",
    );
    await writeFile(
      join(dir, "feature.module.ts"),
      `import { NgModule } from "ngjs-core";

@NgModule({ declarations: [], imports: [] })
export class FeatureModule {}
`,
      "utf8",
    );

    const scanner = new ApplicationScanner();
    await scanner.scan(dir);

    expect(scanner.get("AppModule")?.imports.map((n) => n.className)).toEqual(["FeatureModule"]);
  });

  it("un declarado que no existe en el proyecto se ignora, sin tirar error", async () => {
    await writeFile(
      join(dir, "app.module.ts"),
      `import { NgModule } from "ngjs-core";
import { Ghost } from "some-external-package";

@NgModule({ declarations: [Ghost], imports: [] })
export class AppModule {}
`,
      "utf8",
    );

    const scanner = new ApplicationScanner();
    await expect(scanner.scan(dir)).resolves.toBeUndefined();
    expect(scanner.get("AppModule")?.declarations.components).toEqual([]);
  });

  it("recorre subdirectorios", async () => {
    await mkdir(join(dir, "feature"), { recursive: true });
    await writeFile(
      join(dir, "feature", "card.component.ts"),
      `import { Component } from "ngjs-core";

@Component({ selector: "app-card" })
export class CardComponent {}
`,
      "utf8",
    );

    const scanner = new ApplicationScanner();
    await scanner.scan(dir);

    expect(scanner.get("CardComponent")?.path).toBe(join(dir, "feature", "card.component.ts"));
  });

  it("un servicio (@Injectable) se escanea pero no participa de declarations", async () => {
    await writeFile(
      join(dir, "app.module.ts"),
      `import { NgModule } from "ngjs-core";

@NgModule({ declarations: [], imports: [] })
export class AppModule {}
`,
      "utf8",
    );
    await writeFile(
      join(dir, "user.service.ts"),
      `import { Injectable } from "ngjs-core";

@Injectable()
export class UserService {}
`,
      "utf8",
    );

    const scanner = new ApplicationScanner();
    await scanner.scan(dir);

    expect(scanner.get("UserService")?.metadata.kind).toBe("injectable");
  });

  it("un servicio en declarations es error, como Angular (va en providers)", async () => {
    await writeFile(
      join(dir, "app.module.ts"),
      `import { NgModule } from "ngjs-core";
import { UserService } from "./user.service.ts";

@NgModule({ declarations: [UserService], imports: [] })
export class AppModule {}
`,
      "utf8",
    );
    await writeFile(
      join(dir, "user.service.ts"),
      `import { Injectable } from "ngjs-core";

@Injectable()
export class UserService {}
`,
      "utf8",
    );

    await expect(new ApplicationScanner().scan(dir)).rejects.toThrow(
      '"UserService" está en declarations de "AppModule" pero no es @Component/@Directive/@Pipe.',
    );
  });

  it("imports: primero busca el @NgModule del proyecto; si no es nuestro, lo resuelve al correr (ɵmod de otro paquete o IModule legacy)", async () => {
    await writeFile(
      join(dir, "app.module.ts"),
      `import { NgModule } from "ngjs-core";
import { FeatureModule } from "./feature.module.ts";
import { legacyModule } from "./legacy";

@NgModule({ declarations: [], imports: [FeatureModule, legacyModule, "ngAnimate", angular.module("legacy.core")] })
export class AppModule {}
`,
      "utf8",
    );
    await writeFile(
      join(dir, "feature.module.ts"),
      `import { NgModule } from "ngjs-core";

@NgModule({ declarations: [], imports: [] })
export class FeatureModule {}
`,
      "utf8",
    );

    const scanner = new ApplicationScanner();
    await scanner.scan(dir);

    const appModule = scanner.get("AppModule")!;
    expect(appModule.imports.map((n) => n.className)).toEqual(["FeatureModule"]);
    expect(appModule.legacyImports).toEqual([
      // Un string (el nombre), un @NgModule de otro paquete o un IModule: se decide al correr.
      '(typeof legacyModule === "string" ? legacyModule : legacyModule.ɵmod ? legacyModule.ɵmod.id : legacyModule.name)',
      '"ngAnimate"',
      'angular.module("legacy.core").name',
    ]);
  });

  it("imports: una clase del proyecto que no es @NgModule es error", async () => {
    await writeFile(
      join(dir, "app.module.ts"),
      `import { NgModule } from "ngjs-core";
import { CardComponent } from "./card.component.ts";

@NgModule({ declarations: [], imports: [CardComponent] })
export class AppModule {}
`,
      "utf8",
    );
    await writeFile(
      join(dir, "card.component.ts"),
      `import { Component } from "ngjs-core";

@Component({ selector: "app-card" })
export class CardComponent {}
`,
      "utf8",
    );

    await expect(new ApplicationScanner().scan(dir)).rejects.toThrow('"CardComponent" está en imports de "AppModule" pero no es @NgModule.');
  });

  it("hasScopedProviders(): true si algún component/directive del proyecto tiene providers propios, false si no", async () => {
    await writeFile(
      join(dir, "card.component.ts"),
      `import { Component } from "ngjs-core";

@Component({ selector: "app-card" })
export class CardComponent {}
`,
      "utf8",
    );

    const withoutProviders = new ApplicationScanner();
    await withoutProviders.scan(dir);
    expect(withoutProviders.hasScopedProviders()).toBe(false);

    await writeFile(
      join(dir, "user.service.ts"),
      `import { Injectable } from "ngjs-core";

@Injectable()
export class UserService {}
`,
      "utf8",
    );
    await writeFile(
      join(dir, "highlight.directive.ts"),
      `import { Directive } from "ngjs-core";
import { UserService } from "./user.service.ts";

@Directive({ selector: "[appHighlight]", providers: [UserService] })
export class HighlightDirective {}
`,
      "utf8",
    );

    const withProviders = new ApplicationScanner();
    await withProviders.scan(dir);
    expect(withProviders.hasScopedProviders()).toBe(true);
  });

  it("dos clases decoradas con el mismo nombre en el proyecto es error (chocarían en el nombre de DI)", async () => {
    await mkdir(join(dir, "a"), { recursive: true });
    await mkdir(join(dir, "b"), { recursive: true });
    const service = `import { Injectable } from "ngjs-core";

@Injectable()
export class UserService {}
`;
    await writeFile(join(dir, "a", "user.service.ts"), service, "utf8");
    await writeFile(join(dir, "b", "user.service.ts"), service, "utf8");

    await expect(new ApplicationScanner().scan(dir)).rejects.toThrow(/"UserService" está declarada dos veces/);
  });
});
