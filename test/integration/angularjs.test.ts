import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { IAngularStatic, auto } from "angular";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HashId } from "@/compiler/hash-id.ts";
import { TokenName } from "@/compiler/token-name.ts";
import { pluginLoader } from "@/esbuild/plugin-loader.ts";
import { MetadataStore } from "@/metadata/metadata-store.ts";

const require = createRequire(import.meta.url);
/** El proyecto de prueba no tiene `angular` instalado: se resuelve desde el `node_modules` del compilador (va dentro del bundle). */
const NODE_MODULES = dirname(dirname(require.resolve("angular/package.json")));

/**
 * Compila un proyecto con la cadena completa (esbuild + `pluginLoader`) y lo corre sobre AngularJS 1.8 real
 * en jsdom — angular entra al bundle por el import que emite el compilado, nada más cargado aparte. Si el
 * compilado dependiera de algún runtime propio, esto falla.
 */
describe("compilado corriendo sobre AngularJS real", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ngjs-integration-test-"));
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "test-app" }), "utf8");
    MetadataStore.clear();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function write(file: string, code: string): Promise<void> {
    await writeFile(join(dir, file), code, "utf8");
  }

  /** Compila `main.ts` → corre el bundle en jsdom → bootstrap de `AppModule` (de `app.module.ts`). */
  async function bootstrap(html: string): Promise<{ dom: JSDOM; angular: IAngularStatic; injector: auto.IInjectorService }> {
    const result = await build({
      entryPoints: [join(dir, "main.ts")],
      bundle: true,
      write: false,
      format: "iife",
      logLevel: "silent",
      nodePaths: [NODE_MODULES],
      plugins: [pluginLoader(dir)],
    });

    const dom = new JSDOM(`<div id="app">${html}</div>`, { runScripts: "outside-only" });
    dom.window.eval(result.outputFiles[0]!.text);

    const angular = (dom.window as unknown as { angular: IAngularStatic }).angular;
    const appModuleId = HashId.readable("AppModule", join(dir, "app.module.ts"));
    const injector = angular.bootstrap(dom.window.document.getElementById("app")!, [appModuleId]);
    return { dom, angular, injector };
  }

  it("ɵfac con DI por nombre resuelto en build: component (con bindings), directive y pipe", async () => {
    await write(
      "user.service.ts",
      `import { Injectable } from "ngjs-core";

@Injectable()
export class UserService {
  name(): string { return "Ana"; }
}
`,
    );
    await write(
      "greet.pipe.ts",
      `import { Pipe } from "ngjs-core";
import { UserService } from "./user.service";

@Pipe({ name: "greet" })
export class GreetPipe {
  constructor(private users: UserService) {}
  transform(value: string): string { return value + " " + this.users.name(); }
}
`,
    );
    await write(
      "card.component.ts",
      `import { Component, Input } from "ngjs-core";
import { UserService as Users } from "./user.service";

@Component({ selector: "app-card", template: "<span>{{ $ctrl.label | greet }}</span>" })
export class CardComponent {
  @Input() label!: string;
  loaded = "";
  constructor(private users: Users) {}
  $onInit(): void { this.loaded = this.label + "/" + this.users.name(); }
}
`,
    );
    await write(
      "highlight.directive.ts",
      `import { Directive, Inject } from "ngjs-core";

@Directive({ selector: "[appHighlight]" })
export class HighlightDirective {
  constructor(@Inject("$element") private element: { attr(name: string, value: string): void }) {}
  $onInit(): void { this.element.attr("data-highlight", "on"); }
}
`,
    );
    await write(
      "app.module.ts",
      `import { NgModule } from "ngjs-core";
import { CardComponent } from "./card.component";
import { GreetPipe } from "./greet.pipe";
import { HighlightDirective } from "./highlight.directive";
import { UserService } from "./user.service";

@NgModule({ declarations: [CardComponent, HighlightDirective, GreetPipe], imports: [], providers: [UserService] })
export class AppModule {}
`,
    );
    await write("main.ts", `import "./app.module";\n`);

    const { dom, angular } = await bootstrap(`<app-card label="'Hola'"></app-card><p app-highlight></p>`);

    const card = dom.window.document.querySelector("app-card")!;
    const controller = angular.element(card).controller("appCard") as { loaded: string; label: string };
    expect(controller.label).toBe("Hola");
    expect(controller.loaded).toBe("Hola/Ana");
    expect(card.textContent).toBe("Hola Ana");
    expect(dom.window.document.querySelector("p")!.getAttribute("data-highlight")).toBe("on");
  });

  it("providers de @NgModule: clase, useValue con InjectionToken, useClass, useExisting, useFactory+deps y multi", async () => {
    // `InjectionToken` local: el compilado nunca lo lee (el nombre sale del import), solo tiene que existir el valor.
    await write(
      "tokens.ts",
      `class InjectionToken<T> { constructor(readonly description: string) {} }
export const API_URL = new InjectionToken<string>("api.url");
export const HOOKS = new InjectionToken<string[]>("hooks");
`,
    );
    await write(
      "logger.ts",
      `import { Injectable } from "ngjs-core";

export abstract class Logger { abstract log(message: string): string; }

@Injectable()
export class ConsoleLogger extends Logger {
  log(message: string): string { return "console:" + message; }
}
`,
    );
    await write(
      "config.service.ts",
      `import { Inject, Injectable } from "ngjs-core";
import { Logger } from "./logger";
import { API_URL } from "./tokens";

@Injectable()
export class ConfigService {
  constructor(@Inject(API_URL) readonly url: string, readonly logger: Logger) {}
}
`,
    );
    await write(
      "app.module.ts",
      `import { NgModule } from "ngjs-core";
import { ConfigService } from "./config.service";
import { ConsoleLogger, Logger } from "./logger";
import { API_URL, HOOKS } from "./tokens";

@NgModule({
  declarations: [],
  imports: [],
  providers: [
    ConfigService,
    { provide: API_URL, useValue: "https://api" },
    { provide: Logger, useClass: ConsoleLogger },
    { provide: "legacyLogger", useExisting: Logger },
    { provide: "greeting", useFactory: (url: string) => "hola " + url, deps: [API_URL] },
    { provide: HOOKS, useValue: "a", multi: true },
    { provide: HOOKS, useFactory: () => "b", multi: true },
  ],
})
export class AppModule {}
`,
    );
    await write("main.ts", `import "./app.module";\n`);

    const { injector } = await bootstrap("");
    const token = (symbol: string) => TokenName.of(symbol, "test-app");

    const config = injector.get<{ url: string; logger: { log(message: string): string } }>(token("ConfigService"));
    expect(config.url).toBe("https://api");
    expect(config.logger.log("x")).toBe("console:x");
    expect(injector.get("legacyLogger")).toBe(injector.get(token("Logger")));
    expect(injector.get("greeting")).toBe("hola https://api");
    expect(injector.get(token("HOOKS"))).toEqual(["a", "b"]);
  });

  it("imports de @NgModule: propio, de otro paquete (su ɵmod.id), IModule legacy y legacy por nombre", async () => {
    // Paquete ya compilado con ngjs: trae su `ɵmod` y registra su propio `angular.module`.
    await mkdir(join(dir, "node_modules", "ext-lib"), { recursive: true });
    await writeFile(join(dir, "node_modules", "ext-lib", "package.json"), JSON.stringify({ name: "ext-lib", main: "index.js" }), "utf8");
    await writeFile(
      join(dir, "node_modules", "ext-lib", "index.js"),
      `export class ExtModule {}
ExtModule.ɵmod = { id: "ExtModule_0000abcd" };
angular.module("ExtModule_0000abcd", []).value("ext", "from lib");
`,
      "utf8",
    );
    await write(
      "legacy.ts",
      `declare const angular: { module(name: string, requires: string[]): { value(name: string, value: unknown): { name: string } } };
export const legacyModule = angular.module("legacy.core", []).value("legacyGreeting", "hola");
angular.module("legacy.named", []).value("legacyTarget", "legacy");
`,
    );
    await write(
      "feature.module.ts",
      `import { NgModule } from "ngjs-core";

@NgModule({ declarations: [], imports: [], providers: [{ provide: "feature", useValue: "feature" }] })
export class FeatureModule {}
`,
    );
    await write(
      "greeter.service.ts",
      `import { Inject, Injectable } from "ngjs-core";

@Injectable()
export class GreeterService {
  constructor(@Inject("legacyGreeting") readonly greeting: string, @Inject("legacyTarget") readonly target: string) {}
  greet(): string { return this.greeting + " " + this.target; }
}
`,
    );
    await write(
      "app.module.ts",
      `import { NgModule } from "ngjs-core";
import { ExtModule } from "ext-lib";
import { FeatureModule } from "./feature.module";
import { GreeterService } from "./greeter.service";
import { legacyModule } from "./legacy";

@NgModule({ declarations: [], imports: [FeatureModule, ExtModule, legacyModule, "legacy.named"], providers: [GreeterService] })
export class AppModule {}
`,
    );
    await write("main.ts", `import "./app.module";\n`);

    const { injector } = await bootstrap("");

    expect(injector.get<{ greet(): string }>(TokenName.of("GreeterService", "test-app")).greet()).toBe("hola legacy");
    expect(injector.get("feature")).toBe("feature");
    expect(injector.get("ext")).toBe("from lib");
  });

  it("@HostBinding/@HostListener: $watch aplica la clase, $element.on corre dentro de $apply, $destroy limpia todo", async () => {
    await write(
      "toggle.component.ts",
      `import { Component, HostBinding, HostListener } from "ngjs-core";

@Component({ selector: "app-toggle", template: "" })
export class ToggleComponent {
  @HostBinding("class.active") active = false;
  clicks = 0;

  @HostListener("click", ["$event"])
  onClick(event: MouseEvent): void {
    this.clicks++;
    this.active = true;
  }
}
`,
    );
    await write(
      "app.module.ts",
      `import { NgModule } from "ngjs-core";
import { ToggleComponent } from "./toggle.component";

@NgModule({ declarations: [ToggleComponent], imports: [] })
export class AppModule {}
`,
    );
    await write("main.ts", `import "./app.module";\n`);

    const { dom, angular, injector } = await bootstrap(`<app-toggle></app-toggle>`);
    const el = dom.window.document.querySelector("app-toggle")!;
    const controller = angular.element(el).controller("appToggle") as { clicks: number; active: boolean };
    const rootScope = injector.get<{ $digest(): void; $destroy(): void }>("$rootScope");

    expect(el.classList.contains("active")).toBe(false);

    // El listener nativo corre fuera del digest de Angular — $apply adentro del handler es lo que hace
    // que el cambio de `active` (y el $watch del host binding) se refleje sin un $digest externo.
    el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    expect(controller.clicks).toBe(1);
    expect(el.classList.contains("active")).toBe(true);

    // $destroy (acá, de toda la app) desregistra el listener nativo: un click después no hace nada.
    rootScope.$destroy();
    el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    expect(controller.clicks).toBe(1);
  });

  it("platformBrowserDynamic().bootstrapModule(): función real, módulo raíz con providedIn root, providers del módulo pisan al root, monta <app-root>", async () => {
    await write(
      "logger.ts",
      `import { Injectable } from "ngjs-core";

@Injectable({ providedIn: "root" })
export class Logger {
  source(): string { return "root"; }
}

@Injectable()
export class ModuleLogger {
  source(): string { return "module"; }
}
`,
    );
    await write(
      "user.service.ts",
      `import { Injectable } from "ngjs-core";
import { Logger } from "./logger";

@Injectable({ providedIn: "root" })
export class UserService {
  constructor(private logger: Logger) {}
  name(): string { return "Ana (" + this.logger.source() + ")"; }
}
`,
    );
    await write(
      "app.component.ts",
      `import { Component } from "ngjs-core";
import { UserService } from "./user.service";

@Component({ selector: "app-root", template: "<p>{{ $ctrl.name }}</p>" })
export class AppComponent {
  name: string;
  constructor(users: UserService) { this.name = users.name(); }
}
`,
    );
    await write(
      "app.module.ts",
      `import { NgModule } from "ngjs-core";
import { AppComponent } from "./app.component";
import { Logger, ModuleLogger } from "./logger";

@NgModule({
  declarations: [AppComponent],
  imports: [],
  providers: [{ provide: Logger, useClass: ModuleLogger }],
  bootstrap: [AppComponent],
})
export class AppModule {}
`,
    );
    // La puerta: `platformBrowserDynamic` solo devuelve la plataforma que dejó el build (acá un ngjs-core falso
    // con exactamente eso). La llamada es una función de verdad — en variable y con el módulo elegido al correr.
    await mkdir(join(dir, "node_modules", "ngjs-core"), { recursive: true });
    await writeFile(join(dir, "node_modules", "ngjs-core", "package.json"), JSON.stringify({ name: "ngjs-core", main: "index.js" }), "utf8");
    await writeFile(
      join(dir, "node_modules", "ngjs-core", "index.js"),
      `export const platformBrowserDynamic = () => globalThis.ɵngjsPlatform;\n`,
      "utf8",
    );
    await write(
      "main.ts",
      `import { platformBrowserDynamic } from "ngjs-core";
import { AppModule } from "./app.module";

const platform = platformBrowserDynamic();
const modules: Record<string, unknown> = { app: AppModule };
(window as unknown as { app: Promise<unknown> }).app = platform.bootstrapModule(modules["app"]);
`,
    );

    const result = await build({
      entryPoints: [join(dir, "main.ts")],
      bundle: true,
      write: false,
      format: "iife",
      logLevel: "silent",
      nodePaths: [NODE_MODULES],
      plugins: [pluginLoader(dir)],
    });

    const dom = new JSDOM(`<body></body>`, { runScripts: "outside-only" });
    dom.window.eval(result.outputFiles[0]!.text);

    const injector = await (dom.window as unknown as { app: Promise<auto.IInjectorService> }).app;
    const appRoot = dom.window.document.querySelector("app-root");
    expect(appRoot?.textContent).toBe("Ana (module)");
    expect(injector.get<{ source(): string }>(TokenName.of("Logger", "test-app")).source()).toBe("module");
  });
});
