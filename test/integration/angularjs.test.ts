import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { IAngularStatic, auto } from "angular";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  it("imports con llamada: ModuleWithProviders importa ngModule y registra sus providers (los propios ganan); otra llamada es un módulo más", async () => {
    // Paquete ya compilado con ngjs: `forRoot()` devuelve `{ ngModule, providers }`, como en Angular.
    await mkdir(join(dir, "node_modules", "ext-config"), { recursive: true });
    await writeFile(join(dir, "node_modules", "ext-config", "package.json"), JSON.stringify({ name: "ext-config", main: "index.js" }), "utf8");
    await writeFile(
      join(dir, "node_modules", "ext-config", "index.js"),
      `export class ConfigService {
  constructor(entries) { this.entries = entries; }
}
ConfigService.ɵprov = { token: "ConfigService_ext" };
ConfigService.ɵfac = ["entries", function (entries) { return new ConfigService(entries); }];

export class ConfigModule {
  static forRoot(entries) {
    return {
      ngModule: ConfigModule,
      providers: [
        ConfigService,
        [{ provide: "entries", useValue: entries, multi: true }],
        { provide: "entryCount", useFactory: (config) => config.entries[0].length, deps: [ConfigService] },
        { provide: "api", useValue: "lib" },
      ],
    };
  }
}
ConfigModule.ɵmod = { id: "ConfigModule_ext" };
angular.module("ConfigModule_ext", []).value("configDeclarations", "registered");

export function legacyFeature() {
  return angular.module("legacy.feature", []).value("legacyFeature", "on");
}
`,
      "utf8",
    );
    await write(
      "app.module.ts",
      `import { NgModule } from "ngjs-core";
import { legacyFeature, ConfigModule } from "ext-config";

const entries = [{ key: "a" }, { key: "b" }];

@NgModule({ declarations: [], imports: [ConfigModule.forRoot(entries), legacyFeature()], providers: [{ provide: "api", useValue: "app" }] })
export class AppModule {}
`,
    );
    await write("main.ts", `import "./app.module";\n`);

    const { injector } = await bootstrap("");

    expect(injector.get("configDeclarations")).toBe("registered");
    expect(injector.get("entryCount")).toBe(2);
    expect(injector.get<{ entries: unknown[] }>("ConfigService_ext").entries).toEqual([[{ key: "a" }, { key: "b" }]]);
    expect(injector.get("api")).toBe("app");
    expect(injector.get("legacyFeature")).toBe("on");
  });

  it("ModuleWithProviders con InjectionToken: el ɵprov estampado en la declaración coincide con el nombre que usa quien lo inyecta", async () => {
    await write(
      "tokens.ts",
      `class InjectionToken<T> { constructor(readonly description: string) {} }
export const API_URL = new InjectionToken<string>("api.url");
`,
    );
    await write(
      "api.module.ts",
      `import { NgModule } from "ngjs-core";
import { API_URL } from "./tokens";

@NgModule({ declarations: [], imports: [] })
export class ApiModule {
  static forRoot(url: string) {
    return { ngModule: ApiModule, providers: [{ provide: API_URL, useValue: url }] };
  }
}
`,
    );
    await write(
      "api.service.ts",
      `import { Inject, Injectable } from "ngjs-core";
import { API_URL } from "./tokens";

@Injectable()
export class ApiService {
  constructor(@Inject(API_URL) readonly url: string) {}
}
`,
    );
    await write(
      "app.module.ts",
      `import { NgModule } from "ngjs-core";
import { ApiModule } from "./api.module";
import { ApiService } from "./api.service";

@NgModule({ declarations: [], imports: [ApiModule.forRoot("https://api")], providers: [ApiService] })
export class AppModule {}
`,
    );
    await write("main.ts", `import "./app.module";\n`);

    const { injector } = await bootstrap("");

    expect(injector.get<{ url: string }>(TokenName.of("ApiService", "test-app")).url).toBe("https://api");
  });

  it("@Optional(): sin provider llega null (no error); con provider, la instancia — también desde los providers de un @Component", async () => {
    await write(
      "services.ts",
      `import { Injectable } from "ngjs-core";

@Injectable()
export class Logger { name = "logger"; }

@Injectable()
export class Missing {}

@Injectable()
export class Theme { name = "theme"; }
`,
    );
    await write(
      "report.service.ts",
      `import { Injectable, Optional } from "ngjs-core";
import { Logger, Missing } from "./services";

@Injectable()
export class ReportService {
  constructor(@Optional() readonly logger: Logger | null, @Optional() readonly missing: Missing | null) {}
}
`,
    );
    await write(
      "card.component.ts",
      `import { Component, Optional } from "ngjs-core";
import { Theme } from "./services";

@Component({ selector: "app-card", template: "", providers: [Theme] })
export class CardComponent {
  constructor(@Optional() readonly theme: Theme | null) {}
}
`,
    );
    await write(
      "app.module.ts",
      `import { NgModule } from "ngjs-core";
import { CardComponent } from "./card.component";
import { ReportService } from "./report.service";
import { Logger } from "./services";

@NgModule({ declarations: [CardComponent], imports: [], providers: [ReportService, Logger], bootstrap: [CardComponent] })
export class AppModule {}
`,
    );
    await write("main.ts", `import "./app.module";\n`);

    const { dom, angular, injector } = await bootstrap("<app-card></app-card>");

    const report = injector.get<{ logger: { name: string } | null; missing: unknown }>(TokenName.of("ReportService", "test-app"));
    expect(report.logger?.name).toBe("logger");
    expect(report.missing).toBeNull();
    const card = angular.element(dom.window.document.querySelector("app-card")!).controller("appCard") as { theme: { name: string } | null };
    expect(card.theme?.name).toBe("theme");
  });

  it("inject() durante la construcción: campos y constructor de un servicio y de un @Component (también desde sus providers), optional incluido", async () => {
    await write(
      "services.ts",
      `import { Injectable } from "ngjs-core";

@Injectable()
export class Logger { name = "logger"; }

@Injectable()
export class Missing {}

@Injectable()
export class Theme { name = "theme"; }
`,
    );
    await write(
      "report.service.ts",
      `import { Injectable, inject } from "ngjs-core";
import { Logger, Missing } from "./services";

@Injectable()
export class ReportService {
  readonly logger = inject(Logger);
  readonly missing = inject(Missing, { optional: true });
  readonly label: string;
  constructor() { this.label = "report:" + inject(Logger).name; }
}
`,
    );
    await write(
      "card.component.ts",
      `import { Component, inject } from "ngjs-core";
import { ReportService } from "./report.service";
import { Theme } from "./services";

@Component({ selector: "app-card", template: "", providers: [Theme] })
export class CardComponent {
  readonly theme = inject(Theme);
  readonly report = inject(ReportService);
}
`,
    );
    await write(
      "app.module.ts",
      `import { NgModule } from "ngjs-core";
import { CardComponent } from "./card.component";
import { ReportService } from "./report.service";
import { Logger } from "./services";

@NgModule({ declarations: [CardComponent], imports: [], providers: [ReportService, Logger], bootstrap: [CardComponent] })
export class AppModule {}
`,
    );
    await write("main.ts", `import "./app.module";\n`);

    const { dom, angular, injector } = await bootstrap("<app-card></app-card>");

    const report = injector.get<{ logger: { name: string }; missing: unknown; label: string }>(TokenName.of("ReportService", "test-app"));
    expect(report.logger.name).toBe("logger");
    expect(report.missing).toBeNull();
    expect(report.label).toBe("report:logger");
    const card = angular.element(dom.window.document.querySelector("app-card")!).controller("appCard") as { theme: { name: string }; report: unknown };
    expect(card.theme.name).toBe("theme");
    expect(card.report).toBe(report);
  });

  it("@Self/@SkipSelf/@Host en componentes anidados con providers propios (@Host corta en el componente dueño de la vista, sin caer a la app), y @Self sin injector de elemento", async () => {
    await write(
      "theme.ts",
      `import { Injectable } from "ngjs-core";

@Injectable()
export class Theme { constructor() {} name = ""; }

@Injectable()
export class AppOnly { name = "app"; }
`,
    );
    await write(
      "outer.component.ts",
      `import { Component } from "ngjs-core";
import { Theme } from "./theme";

@Component({ selector: "app-outer", template: "<app-inner></app-inner><span app-probe></span>", providers: [{ provide: Theme, useValue: { name: "outer" } }] })
export class OuterComponent {}
`,
    );
    await write(
      "inner.component.ts",
      `import { Component, Host, Optional, Self, SkipSelf, inject } from "ngjs-core";
import { Theme } from "./theme";

@Component({ selector: "app-inner", template: "", providers: [{ provide: Theme, useValue: { name: "inner" } }] })
export class InnerComponent {
  readonly parent = inject(Theme, { skipSelf: true });
  constructor(@Self() readonly own: Theme, @Host() readonly host: Theme) {}
}
`,
    );
    await write(
      "probe.directive.ts",
      `import { Directive, Host, Optional } from "ngjs-core";
import { AppOnly, Theme } from "./theme";

@Directive({ selector: "[appProbe]" })
export class ProbeDirective {
  constructor(@Host() readonly theme: Theme, @Host() @Optional() readonly appOnly: AppOnly | null) {}
}
`,
    );
    await write(
      "plain.component.ts",
      `import { Component, Optional, Self } from "ngjs-core";
import { Theme } from "./theme";

@Component({ selector: "app-plain", template: "" })
export class PlainComponent {
  constructor(@Self() @Optional() readonly theme: Theme | null) {}
}
`,
    );
    await write(
      "app.module.ts",
      `import { NgModule } from "ngjs-core";
import { InnerComponent } from "./inner.component";
import { OuterComponent } from "./outer.component";
import { PlainComponent } from "./plain.component";
import { ProbeDirective } from "./probe.directive";
import { AppOnly, Theme } from "./theme";

@NgModule({ declarations: [OuterComponent, InnerComponent, PlainComponent, ProbeDirective], imports: [], providers: [Theme, AppOnly], bootstrap: [OuterComponent] })
export class AppModule {}
`,
    );
    await write("main.ts", `import "./app.module";\n`);

    const { dom, angular } = await bootstrap("<app-outer></app-outer><app-plain></app-plain>");

    const inner = angular.element(dom.window.document.querySelector("app-inner")!).controller("appInner") as Record<string, { name: string }>;
    expect(inner.own!.name).toBe("inner");
    expect(inner.parent!.name).toBe("outer");
    expect(inner.host!.name).toBe("inner");
    // Directiva en la vista de `outer`: `@Host` llega hasta `outer` (su host) y no consulta la app — como Angular.
    const probe = angular.element(dom.window.document.querySelector("[app-probe]")!).controller("appProbe") as { theme: { name: string }; appOnly: unknown };
    expect(probe.theme.name).toBe("outer");
    expect(probe.appOnly).toBeNull();
    // Sin providers en ningún ancestro no hay injector de elemento: `@Self()` no encuentra nada propio (el `Theme` de la app no cuenta).
    const plain = angular.element(dom.window.document.querySelector("app-plain")!).controller("appPlain") as { theme: unknown };
    expect(plain.theme).toBeNull();
  });

  it("inyectar una directiva/componente: se lee del elemento (como require), con flags, @Host y por clase base", async () => {
    await write(
      "base-tabs.ts",
      `import { Directive } from "ngjs-core";

@Directive()
export abstract class BaseTabs { kind = "tabs"; }
`,
    );
    await write(
      "tabs.component.ts",
      `import { Component } from "ngjs-core";
import { BaseTabs } from "./base-tabs";

@Component({ selector: "app-tabs", template: "<app-tab></app-tab><span app-tab-label></span>" })
export class TabsComponent extends BaseTabs { name = "tabs-1"; }
`,
    );
    await write(
      "other.component.ts",
      `import { Component } from "ngjs-core";

@Component({ selector: "app-other", template: "" })
export class OtherComponent {}
`,
    );
    await write(
      "tab.component.ts",
      `import { Component, Host, Optional, inject } from "ngjs-core";
import { BaseTabs } from "./base-tabs";
import { OtherComponent } from "./other.component";
import { TabsComponent } from "./tabs.component";

@Component({ selector: "app-tab", template: "" })
export class TabComponent {
  readonly base = inject(BaseTabs);
  constructor(
    readonly tabs: TabsComponent,
    @Host() @Optional() readonly hostTabs: TabsComponent | null,
    @Optional() readonly other: OtherComponent | null,
  ) {}
}
`,
    );
    await write(
      "tab-label.directive.ts",
      `import { Directive, Host } from "ngjs-core";
import { TabsComponent } from "./tabs.component";

@Directive({ selector: "[appTabLabel]" })
export class TabLabelDirective {
  constructor(@Host() readonly tabs: TabsComponent) {}
}
`,
    );
    await write(
      "app.module.ts",
      `import { NgModule } from "ngjs-core";
import { OtherComponent } from "./other.component";
import { TabComponent } from "./tab.component";
import { TabLabelDirective } from "./tab-label.directive";
import { TabsComponent } from "./tabs.component";

@NgModule({ declarations: [TabsComponent, TabComponent, TabLabelDirective, OtherComponent], imports: [] })
export class AppModule {}
`,
    );
    await write("main.ts", `import "./app.module";\n`);

    const { dom, angular } = await bootstrap("<app-tabs></app-tabs>");

    const tabs = angular.element(dom.window.document.querySelector("app-tabs")!).controller("appTabs");
    const tab = angular.element(dom.window.document.querySelector("app-tab")!).controller("appTab") as Record<string, unknown>;
    expect(tab.tabs).toBe(tabs);
    expect(tab.base).toBe(tabs); // `inject(BaseTabs)`: la subclase en un ancestro también cuenta
    expect(tab.hostTabs).toBeNull(); // un componente es su propio host: el padre queda afuera
    expect(tab.other).toBeNull();
    const label = angular.element(dom.window.document.querySelector("[app-tab-label]")!).controller("appTabLabel") as { tabs: unknown };
    expect(label.tabs).toBe(tabs); // una directiva en la vista de `app-tabs`: su host es `app-tabs`
  });

  describe("herencia entre clases del proyecto", () => {
    it("una subclase sin constructor usa el de la base; inject() de base y subclase (en archivos distintos); inputs, host y lifecycle heredados", async () => {
      await write(
        "services.ts",
        `import { Injectable } from "ngjs-core";

@Injectable()
export class Logger { name = "logger"; }

@Injectable()
export class Config { name = "config"; }

@Injectable()
export class Theme { name = "theme"; }
`,
      );
      await write(
        "base.ts",
        `import { Directive, HostBinding, Input, inject } from "ngjs-core";
import { Config, Logger } from "./services";

@Directive()
export abstract class BaseCard {
  @Input() label = "";
  @HostBinding("class.card") readonly isCard = true;
  readonly config = inject(Config);
  calls: string[] = [];
  constructor(readonly logger: Logger) {}
  ngOnInit(): void { this.calls.push("init:" + this.label); }
}
`,
      );
      await write(
        "card.component.ts",
        `import { Component, Input, inject } from "ngjs-core";
import { BaseCard } from "./base";
import { Theme } from "./services";

@Component({ selector: "app-card", template: "<span>{{ $ctrl.label }}/{{ $ctrl.size }}</span>" })
export class CardComponent extends BaseCard {
  @Input() size = "";
  readonly theme = inject(Theme);
}
`,
      );
      await write(
        "app.module.ts",
        `import { NgModule } from "ngjs-core";
import { CardComponent } from "./card.component";
import { Config, Logger, Theme } from "./services";

@NgModule({ declarations: [CardComponent], imports: [], providers: [Logger, Config, Theme] })
export class AppModule {}
`,
      );
      await write("main.ts", `import "./app.module";\n`);

      const { dom, angular } = await bootstrap(`<app-card label="'Hola'" size="'L'"></app-card>`);

      const element = dom.window.document.querySelector("app-card")!;
      const card = angular.element(element).controller("appCard") as Record<string, unknown> & { calls: string[] };
      expect((card.logger as { name: string }).name).toBe("logger");
      expect((card.config as { name: string }).name).toBe("config");
      expect((card.theme as { name: string }).name).toBe("theme");
      expect(element.textContent).toBe("Hola/L");
      expect(card.calls).toEqual(["init:Hola"]);
      expect(element.classList.contains("card")).toBe(true);
    });

    it("una subclase SIN decorador provista con DI heredada es error al registrar (Angular también pide @Injectable())", async () => {
      await write(
        "services.ts",
        `import { Injectable } from "ngjs-core";

@Injectable()
export class Logger {}

@Injectable()
export class BaseService { constructor(readonly logger: Logger) {} }

export class ChildService extends BaseService {}
`,
      );
      await write(
        "app.module.ts",
        `import { NgModule } from "ngjs-core";
import { ChildService, Logger } from "./services";

@NgModule({ declarations: [], imports: [], providers: [Logger, ChildService] })
export class AppModule {}
`,
      );
      await write("main.ts", `import "./app.module";\n`);

      await expect(bootstrap("")).rejects.toThrow(/"ChildService" hereda el factory de su clase padre — agregale @Injectable\(\)/);
    });
  });

  describe("multi-providers entre módulos", () => {
    async function hooksApp(featureHook: string): Promise<void> {
      await write(
        "tokens.ts",
        `class InjectionToken<T> { constructor(readonly description: string) {} }
export const HOOKS = new InjectionToken<string[]>("hooks");
`,
      );
      await write(
        "feature.module.ts",
        `import { NgModule } from "ngjs-core";
import { HOOKS } from "./tokens";

@NgModule({ declarations: [], imports: [], providers: [${featureHook}] })
export class FeatureModule {}
`,
      );
      await write(
        "hooks.module.ts",
        `import { NgModule } from "ngjs-core";
import { HOOKS } from "./tokens";

@NgModule({ declarations: [], imports: [] })
export class HooksModule {
  static forRoot() {
    return { ngModule: HooksModule, providers: [{ provide: HOOKS, useValue: "import", multi: true }] };
  }
}
`,
      );
      await write(
        "app.module.ts",
        `import { NgModule } from "ngjs-core";
import { FeatureModule } from "./feature.module";
import { HooksModule } from "./hooks.module";
import { HOOKS } from "./tokens";

@NgModule({
  declarations: [],
  imports: [FeatureModule, HooksModule.forRoot()],
  providers: [{ provide: HOOKS, useValue: "own", multi: true }],
})
export class AppModule {}
`,
      );
      await write("main.ts", `import "./app.module";\n`);
    }

    it("se juntan todos, en el orden de Angular: módulos importados → ModuleWithProviders → propios", async () => {
      await hooksApp(`{ provide: HOOKS, useValue: "feature", multi: true }`);

      const { injector } = await bootstrap("");

      expect(injector.get(TokenName.of("HOOKS", "test-app"))).toEqual(["feature", "import", "own"]);
    });

    const multi = (value: string) => `{ provide: HOOKS, useValue: "${value}", multi: true }`;
    const single = (value: string) => `{ provide: HOOKS, useValue: "${value}" }`;

    /** Mezclar multi y no-multi es error en Angular sin importar el orden de carga — acá igual. */
    it.each([
      ["hermanos, el no-multi antes", "SingleModule, MultiModule", "", ""],
      ["hermanos, el no-multi después", "MultiModule, SingleModule", "", ""],
      ["importado multi, propio no-multi", "MultiModule", single("own"), ""],
      ["importado no-multi, propio multi", "SingleModule", multi("own"), ""],
      ["forRoot no-multi, propio multi", "MixModule.forRoot()", multi("own"), single("import")],
      ["forRoot multi, propio no-multi", "MixModule.forRoot()", single("own"), multi("import")],
      ["importado multi, forRoot no-multi", "MultiModule, MixModule.forRoot()", "", single("import")],
    ])("mezclar multi y no-multi entre módulos es error: %s", async (_, imports, own, forRootProvider) => {
      const module = (name: string, provider: string) =>
        `import { NgModule } from "ngjs-core";
import { HOOKS } from "./tokens";

@NgModule({ declarations: [], imports: [], providers: [${provider}] })
export class ${name} {}
`;
      await write("tokens.ts", `class InjectionToken<T> { constructor(readonly description: string) {} }\nexport const HOOKS = new InjectionToken<string[]>("hooks");\n`);
      await write("multi.module.ts", module("MultiModule", multi("multi")));
      await write("single.module.ts", module("SingleModule", single("single")));
      await write(
        "mix.module.ts",
        `import { NgModule } from "ngjs-core";
import { HOOKS } from "./tokens";

@NgModule({ declarations: [], imports: [] })
export class MixModule {
  static forRoot() { return { ngModule: MixModule, providers: [${forRootProvider}] }; }
}
`,
      );
      await write(
        "app.module.ts",
        `import { NgModule } from "ngjs-core";
import { MixModule } from "./mix.module";
import { MultiModule } from "./multi.module";
import { SingleModule } from "./single.module";
import { HOOKS } from "./tokens";

@NgModule({ declarations: [], imports: [${imports}], providers: [${own}] })
export class AppModule {}
`,
      );
      await write("main.ts", `import "./app.module";\n`);

      await expect(bootstrap("")).rejects.toThrow(/mezcla providers multi y no-multi para el token ".*" entre módulos/);
    });
  });

  describe("ModuleWithProviders con una clase como token", () => {
    async function logModule(loggerDecorator: string): Promise<void> {
      await write(
        "logger.ts",
        `import { Injectable } from "ngjs-core";

${loggerDecorator}
export abstract class Logger { abstract log(message: string): string; }

@Injectable()
export class ConsoleLogger extends Logger {
  log(message: string): string { return "console:" + message; }
}
`,
      );
      await write(
        "log.module.ts",
        `import { NgModule } from "ngjs-core";
import { ConsoleLogger, Logger } from "./logger";

@NgModule({ declarations: [], imports: [] })
export class LogModule {
  static forRoot() {
    return { ngModule: LogModule, providers: [{ provide: Logger, useClass: ConsoleLogger }] };
  }
}
`,
      );
      await write(
        "app.module.ts",
        `import { NgModule } from "ngjs-core";
import { LogModule } from "./log.module";

@NgModule({ declarations: [], imports: [LogModule.forRoot()] })
export class AppModule {}
`,
      );
      await write("main.ts", `import "./app.module";\n`);
    }

    it("con @Injectable() (aunque sea abstracta) tiene nombre en runtime", async () => {
      await logModule("@Injectable()");

      const { injector } = await bootstrap("");

      expect(injector.get<{ log(message: string): string }>(TokenName.of("Logger", "test-app")).log("x")).toBe("console:x");
    });

    it("sin @Injectable() es error al correr, que dice qué agregar", async () => {
      await logModule("");

      await expect(bootstrap("")).rejects.toThrow(/el token Logger no tiene nombre de DI en runtime .* agregale @Injectable\(\)/);
    });
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

  it("providers de @Component: injector jerárquico por elemento — aísla instancias entre hermanos y las comparte con sus descendientes", async () => {
    await write(
      "logger.ts",
      `import { Injectable } from "ngjs-core";

@Injectable()
export class Logger {
  static count = 0;
  id: number;
  constructor() { this.id = ++Logger.count; }
}
`,
    );
    await write(
      "widget-child.component.ts",
      `import { Component } from "ngjs-core";
import { Logger } from "./logger";

@Component({ selector: "app-widget-child", template: "<span class=\\"child-id\\">{{ $ctrl.logger.id }}</span>" })
export class WidgetChildComponent {
  constructor(readonly logger: Logger) {}
}
`,
    );
    await write(
      "widget.component.ts",
      `import { Component } from "ngjs-core";
import { Logger } from "./logger";

@Component({
  selector: "app-widget",
  template: "<span class=\\"own-id\\">{{ $ctrl.logger.id }}</span><app-widget-child></app-widget-child>",
  providers: [Logger],
})
export class WidgetComponent {
  constructor(readonly logger: Logger) {}
}
`,
    );
    await write(
      "app.module.ts",
      `import { NgModule } from "ngjs-core";
import { WidgetChildComponent } from "./widget-child.component";
import { WidgetComponent } from "./widget.component";

@NgModule({ declarations: [WidgetComponent, WidgetChildComponent], imports: [], bootstrap: [WidgetComponent] })
export class AppModule {}
`,
    );
    await write("main.ts", `import "./app.module";\n`);

    // Nunca se registra `Logger` en ningún lado global (ni providedIn: "root", ni providers de @NgModule) —
    // si el injector jerárquico no aislara de verdad, esto ni siquiera arrancaría ($injector no lo conoce).
    const { dom } = await bootstrap(`<app-widget></app-widget><app-widget></app-widget>`);

    const widgets = dom.window.document.querySelectorAll("app-widget");
    expect(widgets).toHaveLength(2);

    const ownId = (widget: Element) => widget.querySelector(".own-id")!.textContent;
    const childId = (widget: Element) => widget.querySelector(".child-id")!.textContent;

    // Aislamiento: cada <app-widget> tiene su PROPIA instancia de Logger, no una compartida globalmente.
    expect(ownId(widgets[0]!)).not.toBe(ownId(widgets[1]!));
    // Herencia: el hijo anidado (sin providers propios) recibe la MISMA instancia que su padre, no otra.
    expect(childId(widgets[0]!)).toBe(ownId(widgets[0]!));
    expect(childId(widgets[1]!)).toBe(ownId(widgets[1]!));
  });

  it("lifecycle hooks: $onChanges/$onInit/$doCheck/$postLink/$onDestroy reales, content/view (init y checked) en el orden correcto", async () => {
    await write(
      "card.component.ts",
      `import { Component, Input } from "ngjs-core";

@Component({ selector: "app-card", template: "" })
export class CardComponent {
  @Input() label!: string;
  calls: string[] = [];

  ngOnChanges(changes: any): void { this.calls.push("onChanges:" + JSON.stringify({ ...changes.label, isFirstChange: changes.label.isFirstChange() })); }
  ngOnInit(): void { this.calls.push("onInit"); }
  ngDoCheck(): void { this.calls.push("doCheck"); }
  ngAfterContentInit(): void { this.calls.push("afterContentInit"); }
  ngAfterViewInit(): void { this.calls.push("afterViewInit"); }
  ngAfterContentChecked(): void { this.calls.push("afterContentChecked"); }
  ngAfterViewChecked(): void { this.calls.push("afterViewChecked"); }
  ngOnDestroy(): void { this.calls.push("onDestroy"); }
}
`,
    );
    await write(
      "app.module.ts",
      `import { NgModule } from "ngjs-core";
import { CardComponent } from "./card.component";

@NgModule({ declarations: [CardComponent], imports: [] })
export class AppModule {}
`,
    );
    await write("main.ts", `import "./app.module";\n`);

    const { dom, angular, injector } = await bootstrap(`<app-card label="theLabel"></app-card>`);
    const card = dom.window.document.querySelector("app-card")!;
    const controller = angular.element(card).controller("appCard") as { calls: string[] };
    const $rootScope = injector.get<{ $digest(): void; $destroy(): void; theLabel?: string }>("$rootScope");

    /** `$doCheck` puede correr más de una vez en un mismo digest (una vez por pasada interna) — cada
     * ocurrencia va seguida, sincrónico, de "afterContentChecked" y "afterViewChecked" en ese orden. */
    function assertDoCheckGroups(calls: string[]): void {
      const doCheckIndexes = calls.reduce<number[]>((acc, call, i) => (call === "doCheck" ? [...acc, i] : acc), []);
      expect(doCheckIndexes.length).toBeGreaterThan(0);
      for (const i of doCheckIndexes) {
        expect(calls[i + 1]).toBe("afterContentChecked");
        expect(calls[i + 2]).toBe("afterViewChecked");
      }
    }

    // onChanges y onInit corren una sola vez, antes que el primer doCheck. `previousValue: {}` es lo que
    // AngularJS 1.8.3 manda de verdad en el primer cambio (no `undefined`) — se pasa tal cual viene, sin
    // inventar un valor "más Angular real", `firstChange`/`isFirstChange` sí son el adaptador de LifecycleWiring.
    expect(controller.calls[0]).toBe(
      `onChanges:${JSON.stringify({ previousValue: {}, currentValue: undefined, firstChange: true, isFirstChange: true })}`,
    );
    expect(controller.calls[1]).toBe("onInit");
    expect(controller.calls.indexOf("doCheck")).toBe(2);
    assertDoCheckGroups(controller.calls);
    // $postLink: content antes que view, una sola vez (a diferencia de doCheck, no depende de pasadas del digest).
    expect(controller.calls.filter((c) => c === "afterContentInit" || c === "afterViewInit")).toEqual(["afterContentInit", "afterViewInit"]);

    controller.calls.length = 0;
    $rootScope.theLabel = "Ana";
    $rootScope.$digest();

    // Segundo digest con un cambio real: firstChange en false, previousValue/currentValue correctos. El orden
    // relativo entre $onChanges y $doCheck solo está garantizado en el digest inicial, no acá — se busca en
    // vez de asumir posición.
    expect(controller.calls).toContain(
      `onChanges:${JSON.stringify({ previousValue: undefined, currentValue: "Ana", firstChange: false, isFirstChange: false })}`,
    );
    assertDoCheckGroups(controller.calls);
    expect(controller.calls).not.toContain("onInit"); // $onInit no se repite.
    expect(controller.calls).not.toContain("afterContentInit"); // $postLink tampoco.

    controller.calls.length = 0;
    $rootScope.$destroy();
    expect(controller.calls).toEqual(["onDestroy"]);
  });

  it("selector compuesto (tag[atributo]): activa en el tag correcto, queda inerte (sin romper la página) en el equivocado", async () => {
    await write(
      "button-label.directive.ts",
      `import { Directive, Input } from "ngjs-core";

@Directive({ selector: "button[ngbButtonLabel]" })
export class ButtonLabelDirective {
  @Input() ngbButtonLabel!: string;
  applied = true;
}
`,
    );
    await write(
      "app.module.ts",
      `import { NgModule } from "ngjs-core";
import { ButtonLabelDirective } from "./button-label.directive";

@NgModule({ declarations: [ButtonLabelDirective], imports: [] })
export class AppModule {}
`,
    );
    await write("main.ts", `import "./app.module";\n`);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { dom, angular } = await bootstrap(
      `<button ngb-button-label="'ok'"></button><label ngb-button-label="'nope'"></label>`,
    );

    const button = dom.window.document.querySelector("button")!;
    const label = dom.window.document.querySelector("label")!;
    const buttonCtrl = angular.element(button).controller("ngbButtonLabel") as { applied?: boolean; ngbButtonLabel?: string };
    const labelCtrl = angular.element(label).controller("ngbButtonLabel") as { applied?: boolean };

    // Tag correcto: la clase real corrió, con su binding.
    expect(buttonCtrl.applied).toBe(true);
    expect(buttonCtrl.ngbButtonLabel).toBe("ok");
    // Tag equivocado: nunca se construyó la clase real — bindToController sigue pisando el binding
    // (inofensivo, nadie lo lee), pero "applied" (que solo pone el constructor real) nunca aparece.
    expect(labelCtrl.applied).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("ButtonLabelDirective: este selector requiere <button>"));
    // El resto de la página sigue viva — nada explotó por el <label> con el atributo puesto.
    expect(dom.window.document.querySelector("label")).not.toBeNull();

    warn.mockRestore();
  });

  it("lista de selectores por coma (\"button[x], label[x]\"): la misma clase activa en cualquiera de los tags permitidos", async () => {
    await write(
      "button-label.directive.ts",
      `import { Directive, Input } from "ngjs-core";

@Directive({ selector: "button[ngbButtonLabel], label[ngbButtonLabel]" })
export class ButtonLabelDirective {
  @Input() ngbButtonLabel!: string;
  applied = true;
}
`,
    );
    await write(
      "app.module.ts",
      `import { NgModule } from "ngjs-core";
import { ButtonLabelDirective } from "./button-label.directive";

@NgModule({ declarations: [ButtonLabelDirective], imports: [] })
export class AppModule {}
`,
    );
    await write("main.ts", `import "./app.module";\n`);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { dom, angular } = await bootstrap(
      `<button ngb-button-label="'ok'"></button><label ngb-button-label="'tambien-ok'"></label><span ngb-button-label="'nope'"></span>`,
    );

    const ctrlOf = (tag: string) =>
      angular.element(dom.window.document.querySelector(tag)!).controller("ngbButtonLabel") as {
        applied?: boolean;
        ngbButtonLabel?: string;
      };

    // Las dos alternativas de la lista activan la MISMA clase real.
    expect(ctrlOf("button").applied).toBe(true);
    expect(ctrlOf("label").applied).toBe(true);
    // Un tag que no está en ninguna alternativa de la lista: inerte, como el caso simple.
    expect(ctrlOf("span").applied).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("este selector requiere <button> o <label>"));

    warn.mockRestore();
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

  it("DI de Angular 16 por la plataforma: InjectionToken con factory, @Injectable con receta, useFactory con inject(), [new Optional(), X], @Attribute y forwardRef", async () => {
    await write(
      "tokens.ts",
      `import { InjectionToken, inject } from "ngjs-core";
import { Config } from "./services";

export const API_URL = new InjectionToken<string>("api.url", { factory: () => inject(Config).base + "/api" });
export const MISSING = new InjectionToken<string>("missing");
`,
    );
    await write(
      "services.ts",
      `import { Injectable } from "ngjs-core";

@Injectable({ providedIn: "root" })
export class Config { base = "https://host"; }

@Injectable({ providedIn: "root", useClass: forwardRef(() => ConsoleLogger) })
export abstract class Logger { abstract log(message: string): string; }

@Injectable()
export class ConsoleLogger extends Logger { log(message: string): string { return "console:" + message; } }

@Injectable({ providedIn: "root", useFactory: (logger: Logger) => ({ greet: () => logger.log("hola") }), deps: [Logger] })
export abstract class Greeter { abstract greet(): string; }

@Injectable()
export class Unprovided {}
`,
    );
    await write(
      "app.component.ts",
      `import { Attribute, Component, Inject } from "ngjs-core";
import { API_URL } from "./tokens";

@Component({ selector: "app-root", template: "<p>{{ $ctrl.kind }} {{ $ctrl.url }}</p>" })
export class AppComponent {
  constructor(@Attribute("kind") readonly kind: string, @Inject(API_URL) readonly url: string) {}
}
`,
    );
    await write(
      "app.module.ts",
      `import { NgModule, Optional, inject } from "ngjs-core";
import { AppComponent } from "./app.component";
import { API_URL, MISSING } from "./tokens";
import { Greeter, Unprovided } from "./services";

@NgModule({
  declarations: [AppComponent],
  imports: [],
  providers: [
    { provide: "report", useFactory: (greeter: Greeter, missing: unknown) => ({ greeting: greeter.greet(), missing, url: inject(API_URL), optional: inject(MISSING, { optional: true }) }), deps: [Greeter, [new Optional(), Unprovided]] },
  ],
  bootstrap: [AppComponent],
})
export class AppModule {}
`,
    );
    await mkdir(join(dir, "node_modules", "ngjs-core"), { recursive: true });
    await writeFile(join(dir, "node_modules", "ngjs-core", "package.json"), JSON.stringify({ name: "ngjs-core", main: "index.js" }), "utf8");
    await writeFile(
      join(dir, "node_modules", "ngjs-core", "index.js"),
      // `inject` existe (el factory original sigue en la declaración del usuario) pero no debería correr nunca:
      // el que se usa es el `ɵprov.factory` que armó el compilador, con los `inject()` ya resueltos.
      `export const platformBrowserDynamic = () => globalThis.ɵngjsPlatform;
export class InjectionToken { constructor(description) { this.description = description; } }
export function inject() { throw new Error("inject() de runtime no debería correr"); }
`,
      "utf8",
    );
    await write(
      "main.ts",
      `import { platformBrowserDynamic } from "ngjs-core";
import { AppModule } from "./app.module";

(window as unknown as { app: Promise<unknown> }).app = platformBrowserDynamic().bootstrapModule(AppModule);
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
    const dom = new JSDOM(`<body><app-root kind="card"></app-root></body>`, { runScripts: "outside-only" });
    dom.window.eval(result.outputFiles[0]!.text);
    const injector = await (dom.window as unknown as { app: Promise<auto.IInjectorService> }).app;

    expect(dom.window.document.querySelector("app-root")?.textContent).toBe("card https://host/api");
    expect(injector.get("report")).toEqual({ greeting: "console:hola", missing: null, url: "https://host/api", optional: null });
  });

  it("patches globales automáticos: async/await, setTimeout y un addEventListener nativo actualizan la vista solos, sin digest manual (sin NgZone — esa clase la provee ngjs-core, no este compilador)", async () => {
    await write(
      "counter.component.ts",
      `import { Component } from "ngjs-core";

@Component({ selector: "app-counter", template: "<span>{{ $ctrl.value }}</span>" })
export class CounterComponent {
  value = 0;

  async loadAsync(): Promise<void> {
    await Promise.resolve();
    this.value = 2;
  }

  afterTimeout(): void {
    setTimeout(() => { this.value = 3; }, 0);
  }

  wireNativeClick(el: Element): void {
    el.addEventListener("click", () => { this.value = 4; });
  }
}
`,
    );
    await write(
      "app.module.ts",
      `import { NgModule } from "ngjs-core";
import { CounterComponent } from "./counter.component";

@NgModule({ declarations: [CounterComponent], imports: [], bootstrap: [CounterComponent] })
export class AppModule {}
`,
    );
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

(window as unknown as { app: Promise<unknown> }).app = platformBrowserDynamic().bootstrapModule(AppModule);
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
    await (dom.window as unknown as { app: Promise<unknown> }).app;

    const el = dom.window.document.querySelector("app-counter")!;
    const controller = dom.window.angular.element(el).controller("appCounter") as {
      loadAsync(): Promise<void>;
      afterTimeout(): void;
      wireNativeClick(el: Element): void;
    };
    const text = () => el.querySelector("span")!.textContent;

    // async/await real (no un .then() escrito a mano) — depende de que esbuild haya bajado el target
    // a es2016 (helper basado en generadores que sí llama .then() por debajo) y de que Promise.prototype.then
    // esté parcheado. Sin esto, `value` cambiaría pero la vista NUNCA se enteraría.
    await controller.loadAsync();
    expect(text()).toBe("2");

    // setTimeout nativo.
    controller.afterTimeout();
    await new Promise((resolve) => dom.window.setTimeout(resolve, 10));
    expect(text()).toBe("3");

    // addEventListener nativo, sin ng-click ni nada de AngularJS de por medio.
    controller.wireNativeClick(el);
    el.dispatchEvent(new dom.window.Event("click"));
    expect(text()).toBe("4");
  });
});
