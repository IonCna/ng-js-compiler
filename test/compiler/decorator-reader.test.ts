import { afterEach, describe, expect, it } from "vitest";
import type { ComponentMetadata, NgModuleMetadata, PipeMetadata, ServiceMetadata } from "@/metadata/decorator-metadata.ts";
import { MetadataStore } from "@/metadata/metadata-store.ts";
import { decoratorReaderTransform } from "@/compiler/decorator-reader.ts";
import { TokenName } from "@/compiler/token-name.ts";

/** Paquete de los archivos de test (`card.ts` relativo al cwd → el `package.json` del compilador). */
const own = (symbol: string) => TokenName.of(symbol, "ng-js-compiler");

describe("decoratorReaderTransform", () => {
  afterEach(() => {
    MetadataStore.clear();
  });

  it("devuelve undefined si no hay decoradores conocidos (no toca nada)", async () => {
    const result = await decoratorReaderTransform.transform("export class Plain {}", "plain.ts");
    expect(result).toBeUndefined();
  });

  it("saca el decorador de clase reconocido del código — no debe seguir ejecutándose en runtime", async () => {
    const code = `@Component({ selector: "app-card" }) export class CardComponent {}`;
    const result = await decoratorReaderTransform.transform(code, "card.ts");

    expect(result).not.toContain("@Component");
    expect(result).toContain("export class CardComponent {}");
  });

  it("no guarda nada si no hay decoradores conocidos", async () => {
    await decoratorReaderTransform.transform("export class Plain {}", "plain.ts");
    expect(MetadataStore.get("plain.ts")).toEqual([]);
  });

  it("lee constructorTokens: @Inject(Token) tiene prioridad, sin decorador cae al tipo (como Angular real)", async () => {
    const code = `
      @Component({ selector: "app-card" })
      export class CardComponent {
        constructor(@Inject(SomeToken) private svc: SomeService, private http: HttpClient) {}
      }
    `;

    await decoratorReaderTransform.transform(code, "card.ts");
    const [metadata] = MetadataStore.get("card.ts") as [ComponentMetadata];

    expect(metadata.constructorTokens).toEqual([own("SomeToken"), own("HttpClient")]);
  });

  it("@Inject('$http') (string literal) queda como literal, no identifier — es el nombre real de AngularJS", async () => {
    const code = `
      @Service()
      export class FooService {
        constructor(@Inject("$http") private http: unknown) {}
      }
    `;

    await decoratorReaderTransform.transform(code, "foo.service.ts");
    const [metadata] = MetadataStore.get("foo.service.ts") as [ServiceMetadata];

    expect(metadata.constructorTokens).toEqual(["$http"]);
  });

  it("un parámetro sin @Inject ni tipo de clase es error en build", async () => {
    const code = `
      @Component({ selector: "app-card" })
      export class CardComponent {
        constructor(private http: HttpClient, private untyped) {}
      }
    `;

    await expect(decoratorReaderTransform.transform(code, "card.ts")).rejects.toThrow(
      /"CardComponent" — el parámetro 1 del constructor no tiene tipo de clase ni @Inject()/,
    );
  });

  it("resuelve el nombre de DI por el import: paquete del specifier, símbolo exportado (no el alias), import type incluido", async () => {
    const code = `
      import { HttpClient as Http } from "ngjs-core/http";
      import type { Store } from "@acme/store/core";
      import { UserService } from "./user.service";
      @Component({ selector: "app-card" })
      export class CardComponent {
        constructor(private http: Http, private store: Store, private users: UserService, private local: LocalThing) {}
      }
    `;

    await decoratorReaderTransform.transform(code, "card.ts");
    const [metadata] = MetadataStore.get("card.ts") as [ComponentMetadata];

    expect(metadata.constructorTokens).toEqual([
      TokenName.of("HttpClient", "ngjs-core"),
      TokenName.of("Store", "@acme/store"),
      own("UserService"),
      own("LocalThing"),
    ]);
    // de qué archivos vienen (sin repetir); `LocalThing` es del mismo archivo, no hace falta importarlo
    expect(metadata.constructorImports).toEqual(["ngjs-core/http", "@acme/store/core", "./user.service"]);
  });

  it("un servicio lleva su propio nombre de DI (token) — el mismo que calcula quien lo importa", async () => {
    await decoratorReaderTransform.transform(`@Injectable() export class UserService {}`, "user.service.ts");
    const [metadata] = MetadataStore.get("user.service.ts") as [ServiceMetadata];

    expect(metadata.token).toBe(own("UserService"));
  });

  it("lee @Component con selector, inputs, outputs, host binding y host listener — y saca TODOS los decoradores reconocidos del código", async () => {
    const code = `
      @Component({ selector: "app-card", templateUrl: "./card.html" })
      export class CardComponent {
        @Input() title!: string;
        @Input("aka") alias!: string;
        @Output() closed = new EventEmitter<void>();

        @HostBinding("class.open") isOpen = false;

        constructor(@Inject(SomeService) private svc: SomeService) {}

        @HostListener("click", ["$event"])
        onClick(event: unknown) {}
      }
    `;

    const result = await decoratorReaderTransform.transform(code, "card.ts");
    for (const decorator of ["@Component", "@Input", "@Output", "@HostBinding", "@HostListener", "@Inject"]) {
      expect(result).not.toContain(decorator);
    }
    expect(result).toContain("export class CardComponent {");
    expect(result).toContain("title!: string;");
    expect(result).toContain("onClick(event: unknown) {}");

    const [metadata] = MetadataStore.get("card.ts") as [ComponentMetadata];

    expect(metadata.kind).toBe("component");
    expect(metadata.className).toBe("CardComponent");
    expect(metadata.options).toEqual({ selector: "app-card", templateUrl: "./card.html" });
    expect(metadata.inputs).toEqual([
      { propName: "title", bindingName: "title" },
      { propName: "alias", bindingName: "aka" },
    ]);
    expect(metadata.outputs).toEqual([{ propName: "closed", bindingName: "closed" }]);
    expect(metadata.hostBindings).toEqual([{ propName: "isOpen", hostProperty: "class.open" }]);
    expect(metadata.hostListeners).toEqual([{ methodName: "onClick", eventName: "click" }]);
  });

  it("lee providers de @Component/@Directive (clase suelta, token por su import)", async () => {
    const code = `
      import { OtherService } from "some-lib";
      @Component({ selector: "app-card", providers: [SomeService, OtherService] }) export class CardComponent {}
    `;

    await decoratorReaderTransform.transform(code, "card.ts");
    const [metadata] = MetadataStore.get("card.ts") as [ComponentMetadata];

    expect(metadata.providers).toEqual([
      { kind: "class", token: own("SomeService"), classExpr: "SomeService" },
      { kind: "class", token: TokenName.of("OtherService", "some-lib"), classExpr: "OtherService" },
    ]);
  });

  describe("imports de @NgModule", () => {
    async function importsOf(imports: string): Promise<NgModuleMetadata["imports"]> {
      const code = `@NgModule({ declarations: [], imports: ${imports} }) export class AppModule {}`;
      await decoratorReaderTransform.transform(code, "app.module.ts");
      return (MetadataStore.get("app.module.ts") as [NgModuleMetadata])[0].imports;
    }

    it("lee módulos por nombre, referencias (se resuelven en el scanner) e IModule legacy, aplanando anidados", async () => {
      const imports = await importsOf(`[FeatureModule, "ngAnimate", [legacy.module, angular.module("legacy.core")]]`);

      expect(imports).toEqual([
        { kind: "reference", identifier: "FeatureModule" },
        { kind: "name", name: "ngAnimate" },
        { kind: "expression", expr: "legacy.module" },
        { kind: "angularModule", expr: 'angular.module("legacy.core")' },
      ]);
    });

    it.each([
      ["imports que no es array literal", "SHARED_IMPORTS", /`imports` tiene que ser un array literal/],
      ["spread", "[...SHARED_IMPORTS]", /`imports` no admite huecos ni `...spread`/],
      ["ModuleWithProviders (forRoot)", "[RouterModule.forRoot(routes)]", /import `RouterModule.forRoot\(routes\)` no soportado/],
    ])("%s es error en build", async (_, imports, message) => {
      await expect(importsOf(imports)).rejects.toThrow(message);
    });
  });

  describe("providers de @NgModule", () => {
    async function providersOf(providers: string): Promise<NgModuleMetadata["providers"]> {
      const code = `
        import { environment } from "./environments/environment";
        import { API_URL, Logger, ConsoleLogger, HttpClient } from "./tokens";
        @NgModule({ declarations: [], imports: [], providers: ${providers} }) export class AppModule {}
      `;
      await decoratorReaderTransform.transform(code, "app.module.ts");
      return (MetadataStore.get("app.module.ts") as [NgModuleMetadata])[0].providers;
    }

    it("clasifica cada receta, con tokens/deps resueltos y los valores como texto fuente", async () => {
      const providers = await providersOf(`[
        { provide: API_URL, useValue: environment.apiUrl },
        { provide: Logger, useClass: ConsoleLogger },
        { provide: "config", useFactory: (url: string) => ({ url }), deps: [API_URL] },
        { provide: "log", useExisting: Logger },
        { provide: Logger, deps: [HttpClient, "$http"] },
        { provide: Logger },
        { provide: "HOOKS", useValue: 1, multi: true },
      ]`);

      expect(providers).toEqual([
        { kind: "useValue", token: own("API_URL"), valueExpr: "environment.apiUrl", multi: false },
        { kind: "useClass", token: own("Logger"), classExpr: "ConsoleLogger", deps: undefined, multi: false },
        { kind: "useFactory", token: "config", factoryExpr: "(url: string) => ({ url })", deps: [own("API_URL")], multi: false },
        { kind: "useExisting", token: "log", existingToken: own("Logger"), multi: false },
        { kind: "constructor", token: own("Logger"), classExpr: "Logger", deps: [own("HttpClient"), "$http"], multi: false },
        { kind: "constructor", token: own("Logger"), classExpr: "Logger", deps: undefined, multi: false },
        { kind: "useValue", token: "HOOKS", valueExpr: "1", multi: true },
      ]);
    });

    it("aplana arrays anidados, como Angular", async () => {
      const providers = await providersOf(`[Logger, [ConsoleLogger, [HttpClient]]]`);
      expect(providers.map((provider) => provider.kind === "class" && provider.classExpr)).toEqual(["Logger", "ConsoleLogger", "HttpClient"]);
    });

    it.each([
      ["providers que no es array literal", "APP_PROVIDERS", /`providers` tiene que ser un array literal/],
      ["spread", "[...APP_PROVIDERS]", /no admite huecos ni `...spread`/],
      ["llamada provideX()", "[provideHttp()]", /provider `provideHttp\(\)` no soportado/],
      ["objeto sin provide", "[{ useValue: 1 }]", /falta `provide`/],
      ["clave desconocida", "[{ provide: Logger, useKlass: ConsoleLogger }]", /clave "useKlass" desconocida/],
      ["dos recetas", "[{ provide: Logger, useClass: ConsoleLogger, useValue: 1 }]", /solo una receta a la vez \(useClass, useValue\)/],
      ["multi no literal", "[{ provide: Logger, useValue: 1, multi: flag }]", /`multi` tiene que ser true\/false literal/],
      ["deps con flags", "[{ provide: Logger, deps: [[new Optional(), HttpClient]] }]", /cada elemento de `deps`/],
      ["sin receta y provide string", '[{ provide: "logger" }]', /sin receta, `provide` tiene que ser una clase/],
    ])("%s es error en build, no se descarta en silencio", async (_, providers, message) => {
      await expect(providersOf(providers)).rejects.toThrow(message);
    });
  });

  it("lee @Pipe sin bindings", async () => {
    const code = `@Pipe({ name: "truncate" }) export class TruncatePipe { transform(v: unknown) { return v; } }`;
    await decoratorReaderTransform.transform(code, "truncate.ts");

    const [metadata] = MetadataStore.get("truncate.ts") as [PipeMetadata];
    expect(metadata.kind).toBe("pipe");
    expect(metadata.options).toEqual({ name: "truncate" });
  });

  it("lee @Service y @Injectable como kinds distintos", async () => {
    await decoratorReaderTransform.transform(`@Service() export class FooService {}`, "foo.service.ts");
    await decoratorReaderTransform.transform(`@Injectable() export class BarService {}`, "bar.service.ts");

    const [foo] = MetadataStore.get("foo.service.ts") as [ServiceMetadata];
    const [bar] = MetadataStore.get("bar.service.ts") as [ServiceMetadata];
    expect(foo.kind).toBe("service");
    expect(bar.kind).toBe("injectable");
  });

  it("lee @NgModule con declarations/imports como identificadores, no literales", async () => {
    const code = `
      import { CardComponent } from "./card.component.ts";
      @NgModule({ declarations: [CardComponent], imports: [] })
      export class AppModule {}
    `;

    await decoratorReaderTransform.transform(code, "app.module.ts");
    const [metadata] = MetadataStore.get("app.module.ts") as [NgModuleMetadata];

    expect(metadata.kind).toBe("ngmodule");
    expect(metadata.className).toBe("AppModule");
    expect(metadata.declarations).toEqual(["CardComponent"]);
    expect(metadata.imports).toEqual([]);
  });

  it("lee bootstrap (identificadores) y controllerAs (string) de @NgModule", async () => {
    const code = `
      import { AppComponent } from "./app.component.ts";
      @NgModule({ declarations: [AppComponent], imports: [], bootstrap: [AppComponent], controllerAs: "vm" })
      export class AppModule {}
    `;

    await decoratorReaderTransform.transform(code, "app.module.ts");
    const [metadata] = MetadataStore.get("app.module.ts") as [NgModuleMetadata];

    expect(metadata.bootstrap).toEqual(["AppComponent"]);
    expect(metadata.controllerAs).toBe("vm");
  });

  it("lee más de una clase decorada por archivo", async () => {
    const code = `
      @Injectable() export class AService {}
      @Injectable() export class BService {}
    `;
    await decoratorReaderTransform.transform(code, "multi.ts");
    expect(MetadataStore.get("multi.ts")).toHaveLength(2);
  });
});
