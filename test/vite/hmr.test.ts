import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IAngularStatic, auto } from "angular";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApplicationScanner } from "@/compiler/application-scanner.ts";
import { ModuleWriter } from "@/compiler/module-writer.ts";
import { MetadataStore } from "@/metadata/metadata-store.ts";
import { HmrBoundary } from "@/vite/hmr-boundary.ts";
import { HmrRuntime } from "@/vite/hmr-runtime.ts";

const require = createRequire(import.meta.url);
const ANGULAR_SOURCE = readFileSync(require.resolve("angular/angular.js"), "utf8");

describe("HmrBoundary + ModuleWriter (hmr)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ngjs-hmr-test-"));
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "test-app" }), "utf8");
    MetadataStore.clear();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function scan(files: Record<string, string>): Promise<ApplicationScanner> {
    for (const [file, code] of Object.entries(files)) await writeFile(join(dir, file), code, "utf8");
    const scanner = new ApplicationScanner();
    await scanner.scan(dir);
    return scanner;
  }

  it("solo un archivo de @Component exportados es límite de hot reload; servicios, módulos y mezclas no", async () => {
    const scanner = await scan({
      "card.component.ts": `import { Component } from "ngjs-core";
@Component({ selector: "app-card", template: "<p></p>" })
export class CardComponent {}
`,
      "user.service.ts": `import { Injectable } from "ngjs-core";
@Injectable({ providedIn: "root" })
export class UserService {}
`,
      "mixed.ts": `import { Component, Injectable } from "ngjs-core";
@Injectable()
export class Helper {}
@Component({ selector: "app-mixed", template: "" })
export class MixedComponent {}
`,
      "legacy.ts": "export class LegacyComponent { static get $factory() { return {}; } }\n",
    });

    scanner.within(() => {
      expect(HmrBoundary.isComponentFile(join(dir, "card.component.ts"))).toBe(true);
      expect(HmrBoundary.isComponentFile(join(dir, "user.service.ts"))).toBe(false);
      expect(HmrBoundary.isComponentFile(join(dir, "mixed.ts"))).toBe(false);
      expect(HmrBoundary.isComponentFile(join(dir, "legacy.ts"))).toBe(false);
    });
  });

  it("acceptCode: las clases del archivo y cómo encontrar sus elementos en el DOM", async () => {
    const scanner = await scan({
      "card.component.ts": `import { Component } from "ngjs-core";
@Component({ selector: "app-card, button[appCard]", template: "" })
export class CardComponent {}
`,
    });
    const code = scanner.within(() => HmrBoundary.acceptCode(join(dir, "card.component.ts")))!;

    expect(code).toContain("import.meta.hot.accept(");
    expect(code).toContain('{ "CardComponent": CardComponent }');
    expect(code).toContain('{"CardComponent":[{"name":"appCard","query":"app-card, button[app-card]"}]}');
    expect(scanner.within(() => HmrBoundary.acceptCode(join(dir, "missing.ts")))).toBeUndefined();
  });

  it("con hmr, ModuleWriter registra la directiva que guarda el elemento original de cada @Component (sin hmr, no)", async () => {
    const scanner = await scan({
      "card.component.ts": `import { Component } from "ngjs-core";
@Component({ selector: "app-card", template: "" })
export class CardComponent {}
`,
      "app.module.ts": `import { NgModule } from "ngjs-core";
import { CardComponent } from "./card.component";
@NgModule({ declarations: [CardComponent] })
export class AppModule {}
`,
    });
    const modulePath = join(dir, "app.module.ts");
    const source = readFileSync(modulePath, "utf8");

    expect(new ModuleWriter(scanner, { hmr: true }).write(source, modulePath)).toContain(
      '.directive("appCard", globalThis.ɵngjsHmr.sourceDirective("E"))',
    );
    expect(new ModuleWriter(scanner).write(source, modulePath)).not.toContain("ɵngjsHmr");
  });
});

/**
 * El runtime sobre AngularJS 1.8 real: "componentes compilados" a mano con la forma que emite ngjs (`ɵfac` con
 * `$element`/`$scope`, `ɵcmp.definition`) registrados como lo hace `ModuleWriter` con hmr: `app-hello` y `app-shell`
 * (un contenedor con su propio `ng-repeat` de `app-hello`).
 */
describe("HmrRuntime (AngularJS real en jsdom)", () => {
  type Win = Window &
    typeof globalThis & {
      angular: IAngularStatic;
      ɵngjsInjector: auto.IInjectorService;
      ɵngjsHmr: { update(previous: object, next: object | undefined, registrations: object): void };
      makeType(template: string, label: string, bindings?: Record<string, string>): unknown;
      V1: unknown;
    };
  type Scope = { $apply(): void } & Record<string, unknown>;
  const registrations = { Hello: [{ name: "appHello", query: "app-hello" }] };

  function setup(html: string): { win: Win; info: ReturnType<typeof vi.fn>; V1: unknown } {
    const dom = new JSDOM(`<!doctype html><body><div id="app">${html}</div></body>`, { runScripts: "outside-only" });
    const win = dom.window as unknown as Win;
    win.eval(ANGULAR_SOURCE);
    win.eval(HmrRuntime.source());
    const info = vi.fn();
    win.console.info = info;
    win.eval(`
      window.makeType = function (template, label, bindings) {
        function Hello() { this.label = label; this.count = 0; }
        Hello.ɵfac = ["$element", "$scope", function ($element, $scope) { return new Hello(); }];
        Hello.ɵcmp = {
          selectors: [["app-hello"]], inputs: { name: "name" }, outputs: { done: "done" },
          definition: { template: template, controllerAs: "$ctrl", bindings: bindings || { name: "<", done: "&" } },
        };
        return Hello;
      };
      window.V1 = makeType('<b>{{$ctrl.label}} {{$ctrl.name}} {{$ctrl.count}}</b><i ng-click="$ctrl.done()"></i>', "v1");
      function Shell() { this.items = [1, 2]; }
      Shell.ɵfac = ["$element", "$scope", function () { return new Shell(); }];
      angular.module("app", [])
        .component("appHello", { controller: V1.ɵfac, template: V1.ɵcmp.definition.template, controllerAs: "$ctrl", bindings: { name: "<", done: "&" } })
        // Como \`outputAttributesCall\`: el atributo del output desaparece del DOM al linkear.
        .directive("appHello", function () { return { restrict: "E", link: { pre: function (s, element) { element[0].removeAttribute("done"); } } }; })
        .directive("appHello", ɵngjsHmr.sourceDirective("E"))
        .component("appShell", { controller: Shell.ɵfac, controllerAs: "$ctrl", template: '<div ng-repeat="i in $ctrl.items"><app-hello name="&quot;r&quot; + i"></app-hello></div>' })
        .directive("appShell", ɵngjsHmr.sourceDirective("E"));
      window.ɵngjsInjector = angular.bootstrap(document.getElementById("app"), ["app"]);
    `);
    return { win, info, V1: win.V1 };
  }

  const text = (win: Win) => [...win.document.querySelectorAll("app-hello b")].map((b) => b.textContent);
  const scopeOf = (win: Win, selector: string) => win.angular.element(win.document.querySelector(selector)!).scope() as unknown as Scope;

  it("cambia template y clase de las instancias en pantalla; el estado de la página, los inputs y outputs siguen", () => {
    const { win, info, V1 } = setup(`
      <div ng-init="who = 'Max'; finished = 0">
        <app-hello name="who" done="finished = finished + 1"></app-hello>
        <app-shell></app-shell>
      </div>`);
    const page = scopeOf(win, "[ng-init]");
    page.who = "Ana";
    page.$apply();
    expect(text(win)).toEqual(["v1 Ana 0", "v1 r1 0", "v1 r2 0"]);

    const V2 = win.makeType('<b>{{$ctrl.label}}! {{$ctrl.name}}</b><i ng-click="$ctrl.done()"></i>', "v2");
    win.ɵngjsHmr.update({ Hello: V1 }, { Hello: V2 }, registrations);

    expect(info).toHaveBeenCalledWith("[ngjs] hot update: Hello");
    expect(text(win)).toEqual(["v2! Ana", "v2! r1", "v2! r2"]);
    expect(win.document.querySelectorAll("app-hello")).toHaveLength(3);

    (win.document.querySelector("app-hello i") as HTMLElement).click();
    expect(page.finished).toBe(1);

    // Un segundo cambio parte de la clase nueva.
    win.ɵngjsHmr.update({ Hello: V2 }, { Hello: win.makeType("<b>{{$ctrl.label}}</b>", "v3") }, registrations);
    expect(text(win)).toEqual(["v3", "v3", "v3"]);
  });

  it("dentro de un ng-repeat recompila el @Component que lo contiene: las filas nuevas también salen con la versión nueva", () => {
    const { win, V1 } = setup("<app-shell></app-shell>");
    win.ɵngjsHmr.update({ Hello: V1 }, { Hello: win.makeType("<b>new {{$ctrl.label}} {{$ctrl.name}}</b>", "v2") }, registrations);

    const shell = win.angular.element(win.document.querySelector("app-shell")!).isolateScope() as unknown as Scope & { $ctrl: { items: number[] } };
    shell.$ctrl.items.push(3);
    shell.$apply();
    expect(text(win)).toEqual(["new v2 r1", "new v2 r2", "new v2 r3"]);
  });

  it("recarga si una instancia depende de un ng-repeat sin @Component del proyecto que lo contenga", () => {
    for (const html of [
      `<div ng-init="items = [1]"><app-hello ng-repeat="i in items" name="i"></app-hello></div>`,
      `<div ng-init="items = [1]"><div ng-repeat="i in items"><app-hello name="i"></app-hello></div></div>`,
    ]) {
      const { win, info, V1 } = setup(html);
      win.ɵngjsHmr.update({ Hello: V1 }, { Hello: win.makeType("<b>new</b>", "v2") }, registrations);

      expect(info).toHaveBeenLastCalledWith(
        "[ngjs] recarga completa: una instancia en pantalla depende de un ng-repeat/ng-if/ng-switch sin un @Component del proyecto que lo contenga",
      );
      expect(text(win)).toEqual(["v1 1 0"]);
    }
  });

  it("recarga si cambia lo que AngularJS fijó al registrar, o los exports del archivo", () => {
    const { win, info, V1 } = setup(`<app-hello name="'x'"></app-hello>`);

    win.ɵngjsHmr.update({ Hello: V1 }, { Hello: win.makeType("<b></b>", "v2", { name: "@" }) }, registrations);
    expect(info).toHaveBeenLastCalledWith("[ngjs] recarga completa: Hello cambió su selector, inputs/outputs o definición");

    win.ɵngjsHmr.update({ Hello: V1 }, { Hello: V1, helper: () => 1 }, registrations);
    expect(info).toHaveBeenLastCalledWith("[ngjs] recarga completa: cambiaron los exports del archivo");

    win.ɵngjsHmr.update({ Hello: V1 }, undefined, registrations);
    expect(info).toHaveBeenLastCalledWith("[ngjs] recarga completa: el módulo nuevo no se pudo evaluar");
    expect(text(win)).toEqual(["v1 x 0"]);
  });
});
