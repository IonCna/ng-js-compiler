import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { IAngularStatic, auto } from "angular";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { PlatformCode } from "@/compiler/platform-code.ts";

const ANGULAR = readFileSync(createRequire(import.meta.url).resolve("angular/angular.js"), "utf8");

type Initializer = (injector: auto.IInjectorService) => void | Promise<unknown>;

interface PlatformWindow {
  angular: IAngularStatic;
  document: Document;
  name: string;
  ɵngjsPlatform: { bootstrapModule(moduleType: unknown): Promise<auto.IInjectorService> };
  ɵngjsAppInitializers?: Initializer[];
  eval(code: string): unknown;
}

/**
 * La plataforma evaluada en una ventana jsdom con AngularJS real y un módulo `app` armado a mano: `<app-root>` anota en
 * `log` cuándo se construye. `moduleType` es lo mínimo que lee `bootstrapModule` de una clase compilada (`ɵmod`).
 */
function platform(): { win: PlatformWindow; log: string[]; moduleType: object } {
  const dom = new JSDOM("<!doctype html><body></body>", { runScripts: "outside-only", pretendToBeVisual: true });
  const win = dom.window as unknown as PlatformWindow;
  win.eval(ANGULAR);
  win.eval(PlatformCode.source());

  const log: string[] = [];
  win.angular
    .module("app", [])
    .run(() => log.push("run"))
    .component("appRoot", {
      template: "hola",
      controller: function AppRoot() {
        log.push("component");
      },
    });
  return { win, log, moduleType: { ɵmod: { id: "app", bootstrap: ["app-root"] } } };
}

describe("PlatformCode: bootstrapModule()", () => {
  it("los initializers corren con el injector creado y ANTES de compilar el host (como APP_INITIALIZER de Angular)", async () => {
    const { win, log, moduleType } = platform();
    let release!: () => void;
    win.ɵngjsAppInitializers = [
      (injector) => {
        log.push(`initializer:${injector.has("$rootElement")}`);
        return new Promise<void>((resolve) => {
          release = () => {
            log.push("initialized");
            resolve();
          };
        });
      },
    ];

    const ready = win.ɵngjsPlatform.bootstrapModule(moduleType);
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Injector listo (`.run` corrió, el host ya lo expone) pero ningún componente todavía.
    expect(log).toEqual(["run", "initializer:true"]);
    expect(win.document.querySelector("app-root")?.textContent).toBe("");

    release();
    const injector = await ready;

    expect(log).toEqual(["run", "initializer:true", "initialized", "component"]);
    expect(win.document.querySelector("app-root")?.textContent).toBe("hola");
    expect(win.angular.element(win.document.body).injector()).toBe(injector);
    expect(injector.get<{ 0: Element }>("$rootElement")[0]).toBe(win.document.body);
  });

  it("si un initializer falla, bootstrapModule() rechaza y no se monta ningún componente", async () => {
    const { win, log, moduleType } = platform();
    win.ɵngjsAppInitializers = [() => Promise.reject(new Error("sin sesión"))];

    await expect(win.ɵngjsPlatform.bootstrapModule(moduleType)).rejects.toThrow("sin sesión");
    expect(log).toEqual(["run"]);
  });

  it("sin initializers monta igual; un segundo bootstrap sobre el mismo host rechaza", async () => {
    const { win, log, moduleType } = platform();

    await win.ɵngjsPlatform.bootstrapModule(moduleType);
    expect(log).toEqual(["run", "component"]);

    await expect(win.ɵngjsPlatform.bootstrapModule(moduleType)).rejects.toThrow(/ya tiene una app arrancada/);
  });

  it("respeta la marca de angular.reloadWithDebugInfo() en window.name, como angular.bootstrap", async () => {
    const { win, moduleType } = platform();
    win.name = "NG_ENABLE_DEBUG_INFO!ventana";

    await win.ɵngjsPlatform.bootstrapModule(moduleType);

    expect(win.name).toBe("ventana");
  });
});
