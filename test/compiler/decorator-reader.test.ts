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
      export class HttpClient {}
      @Component({ selector: "app-card" })
      export class CardComponent {
        constructor(@Inject(SomeToken) private svc: SomeService, private http: HttpClient) {}
      }
    `;

    await decoratorReaderTransform.transform(code, "card.ts");
    const [metadata] = MetadataStore.get("card.ts") as [ComponentMetadata];

    expect(metadata.constructorTokens).toEqual([own("SomeToken"), own("HttpClient")]);
  });

  it("texto no ASCII antes del decorador (comentario con tildes): se saca el decorador justo, sin correr el corte", async () => {
    const code = `// configuración del módulo — ñandú\n@Injectable()\nexport class FooService {\n  constructor(@Inject("$http") private http: unknown) {}\n}\n`;

    const result = await decoratorReaderTransform.transform(code, "foo.service.ts");

    expect(result).toBe(`// configuración del módulo — ñandú\n\nexport class FooService {\n  constructor( private http: unknown) {}\n}\n`);
  });

  describe("DI de Angular 16 resuelta en build", () => {
    it("forwardRef(() => X) se desenvuelve en providers, deps, useClass, @Inject() e inject()", async () => {
      const code = `
        @Component({
          selector: "app-card",
          providers: [forwardRef(() => Logger), { provide: forwardRef(() => Base), useClass: forwardRef(() => Impl), deps: [forwardRef(() => Http)] }],
        })
        export class CardComponent {
          private later = inject(forwardRef(() => Later));
          constructor(@Inject(forwardRef(() => Config)) config: unknown) {}
        }
      `;

      await decoratorReaderTransform.transform(code, "card.ts");
      const [metadata] = MetadataStore.get("card.ts") as [ComponentMetadata];

      expect(metadata.providers).toEqual([
        { kind: "class", token: own("Logger"), classExpr: "Logger" },
        { kind: "useClass", token: own("Base"), classExpr: "Impl", deps: [own("Http")], multi: false },
      ]);
      expect(metadata.constructorTokens).toEqual([own("Config")]);
      expect(metadata.injectTokens).toEqual([{ token: own("Later"), flags: {} }]);
    });

    it("@Attribute('x'): no es DI, queda el nombre del atributo; en un servicio es error en build", async () => {
      await decoratorReaderTransform.transform(
        `export class HttpClient {} @Directive({ selector: "[appBtn]" }) export class BtnDirective { constructor(@Attribute("type") type: string, http: HttpClient) {} }`,
        "btn.ts",
      );
      const [metadata] = MetadataStore.get("btn.ts") as [ComponentMetadata];

      expect(metadata.constructorAttributes).toEqual(["type", null]);
      expect(metadata.constructorTokens).toEqual(["", own("HttpClient")]);
      await expect(
        decoratorReaderTransform.transform(`@Injectable() export class Foo { constructor(@Attribute("type") type: string) {} }`, "foo.ts"),
      ).rejects.toThrow(/@Attribute\(\) solo existe en @Component\/@Directive/);
    });

    it("deps con [new Optional(), X] y useFactory con inject() en el cuerpo (no en funciones anidadas)", async () => {
      const code = `
        @NgModule({
          declarations: [],
          imports: [],
          providers: [
            { provide: "report", useFactory: (http: unknown, logger: unknown) => ({ http, logger, cfg: inject(Config), later: () => inject(Later) }), deps: [Http, [new Optional(), Logger]] },
          ],
        })
        export class AppModule {}
      `;

      await decoratorReaderTransform.transform(code, "app.module.ts");
      const [metadata] = MetadataStore.get("app.module.ts") as [NgModuleMetadata];

      expect(metadata.providers).toEqual([
        {
          kind: "useFactory",
          token: "report",
          factoryExpr: '(http: unknown, logger: unknown) => ({ http, logger, cfg: globalThis.ɵngjsInjected["ɵfactory"][0], later: () => inject(Later) })',
          deps: [own("Http"), own("Logger")],
          depFlags: [{}, { optional: true }],
          injectTokens: [{ token: own("Config"), flags: {} }],
          multi: false,
        },
      ]);
    });

    it("@Injectable con receta: queda como recipe (el token es la propia clase)", async () => {
      await decoratorReaderTransform.transform(
        `@Injectable({ providedIn: "root", useFactory: (http: unknown) => new Impl(http), deps: [Http] }) export abstract class Api {}`,
        "api.ts",
      );
      const [metadata] = MetadataStore.get("api.ts") as [ServiceMetadata];

      expect(metadata.recipe).toEqual({ kind: "useFactory", token: own("Api"), factoryExpr: "(http: unknown) => new Impl(http)", deps: [own("Http")], multi: false });
    });
  });

  describe("queries y hostDirectives (solo la definición)", () => {
    it("lee @ViewChild/@ViewChildren/@ContentChild/@ContentChildren (también en un setter) y los saca del código", async () => {
      const code = `
        @Component({ selector: "app-tabs" })
        export class TabsComponent {
          @ViewChild(TabComponent) first!: TabComponent;
          @ViewChildren("a, b") refs!: unknown;
          @ContentChild(forwardRef(() => Label), { read: ElementRef, static: true }) label!: unknown;
          @ContentChildren(TabComponent, { descendants: true }) tabs!: unknown;
          @ContentChildren(Pane) panes!: unknown;
          @ViewChild("box") set box(value: unknown) {}
        }
      `;

      const result = await decoratorReaderTransform.transform(code, "tabs.ts");
      const [metadata] = MetadataStore.get("tabs.ts") as [ComponentMetadata];

      for (const decorator of ["@ViewChild", "@ViewChildren", "@ContentChild", "@ContentChildren"]) expect(result).not.toContain(decorator);
      expect(metadata.queries).toEqual([
        { kind: "view", propertyName: "first", first: true, predicate: { kind: "type", expr: "TabComponent" }, descendants: true, static: false },
        { kind: "view", propertyName: "refs", first: false, predicate: { kind: "names", names: ["a", "b"] }, descendants: true, static: false },
        { kind: "content", propertyName: "label", first: true, predicate: { kind: "type", expr: "Label" }, descendants: true, static: true, readExpr: "ElementRef" },
        { kind: "content", propertyName: "tabs", first: false, predicate: { kind: "type", expr: "TabComponent" }, descendants: true, static: false },
        { kind: "content", propertyName: "panes", first: false, predicate: { kind: "type", expr: "Pane" }, descendants: false, static: false },
        { kind: "view", propertyName: "box", first: true, predicate: { kind: "names", names: ["box"] }, descendants: true, static: false },
      ]);
    });

    it("lee hostDirectives en forma corta y larga (forwardRef desenvuelto)", async () => {
      const code = `
        @Directive({ selector: "[appMenu]", hostDirectives: [Focusable, { directive: forwardRef(() => Tooltip), inputs: ["text: tooltip"], outputs: ["shown"] }] })
        export class MenuDirective {}
      `;

      await decoratorReaderTransform.transform(code, "menu.ts");
      const [metadata] = MetadataStore.get("menu.ts") as [ComponentMetadata];

      expect(metadata.hostDirectives).toEqual([
        { directiveExpr: "Focusable" },
        { directiveExpr: "Tooltip", inputs: ["text: tooltip"], outputs: ["shown"] },
      ]);
    });

    it("una opción desconocida en una query es error en build", async () => {
      const code = `@Component({ selector: "app-x" }) export class X { @ViewChild(Y, { lazy: true }) y!: unknown; }`;

      await expect(decoratorReaderTransform.transform(code, "x.ts")).rejects.toThrow(/"X.y" — @ViewChild: opción "lazy" desconocida/);
    });
  });

  describe("herencia", () => {
    it("registra la base (nombre exportado, también con alias) y si la clase declara constructor propio", async () => {
      const code = `
        import { BaseCard as Base } from "./base";
        @Component({ selector: "app-card" }) export class CardComponent extends Base {}
        export class HttpClient {}
        @Injectable() export class FooService { constructor(http: HttpClient) {} }
      `;

      await decoratorReaderTransform.transform(code, "card.ts");
      const [card, foo] = MetadataStore.get("card.ts") as [ComponentMetadata, ServiceMetadata];

      expect(card).toMatchObject({ superClass: "BaseCard", hasConstructor: false });
      expect(foo.superClass).toBeUndefined();
      expect(foo.hasConstructor).toBe(true);
    });

    it("una clase SIN decorador que usa features de Angular es error en build (como Angular desde v10)", async () => {
      const code = `@Component({ selector: "app-card" }) export class CardComponent {}\nexport abstract class Base { @Input() label = ""; }`;

      await expect(decoratorReaderTransform.transform(code, "card.ts")).rejects.toThrow(
        /"Base" usa @Input pero no tiene decorador de clase — agregale @Directive\(\)\/@Injectable\(\)/,
      );
    });
  });

  describe("inject() durante la construcción", () => {
    it("en campos de instancia y en el constructor: se reemplaza por el valor inyectado (por clase) y queda como dependencia (también con alias y optional)", async () => {
      const code = `
        import { inject as di } from "ngjs-core";
        import { HttpClient } from "ngjs-core/http";
        @Injectable()
        export class FooService {
          private http = inject(HttpClient);
          private logger = di(Logger, { optional: true });
          private label: string;
          constructor() { this.label = inject("$locale").id; }
        }
      `;

      const result = await decoratorReaderTransform.transform(code, "foo.service.ts");
      const [metadata] = MetadataStore.get("foo.service.ts") as [ServiceMetadata];

      expect(result).toContain('private http = globalThis.ɵngjsInjected["FooService"][0];');
      expect(result).toContain('private logger = globalThis.ɵngjsInjected["FooService"][1];');
      expect(result).toContain('this.label = globalThis.ɵngjsInjected["FooService"][2].id;');
      expect(metadata.injectTokens).toEqual([
        { token: TokenName.of("HttpClient", "ngjs-core"), flags: {} },
        { token: own("Logger"), flags: { optional: true } },
        { token: "$locale", flags: {} },
      ]);
      expect(metadata.constructorImports).toEqual(["ngjs-core/http"]);
    });

    it("lo que no corre durante la construcción queda intacto: función anidada, método, campo static", async () => {
      const code = `
        @Injectable()
        export class FooService {
          static shared = inject(Config);
          onClick = () => inject(Router);
          constructor() { setTimeout(function () { inject(Later); }); }
          load() { return inject(Http); }
        }
      `;

      const result = await decoratorReaderTransform.transform(code, "foo.service.ts");
      const [metadata] = MetadataStore.get("foo.service.ts") as [ServiceMetadata];

      expect(metadata.injectTokens).toEqual([]);
      for (const call of ["inject(Config)", "inject(Router)", "inject(Later)", "inject(Http)"]) expect(result).toContain(call);
    });

    it.each([
      ["opción desconocida", "inject(Logger, { lazy: true })", /opción desconocida \(solo `optional`\/`self`\/`skipSelf`\/`host`\)/],
      ["token que no es clase/InjectionToken/string", "inject(tokens.logger)", /el token tiene que ser una clase, un InjectionToken o un string/],
      ["opciones no literales", "inject(Logger, flags)", /las opciones tienen que ser un objeto literal/],
    ])("%s es error en build", async (_, call, message) => {
      const code = `@Injectable() export class FooService { private logger = ${call}; }`;

      await expect(decoratorReaderTransform.transform(code, "foo.service.ts")).rejects.toThrow(message);
    });
  });

  it("flags de DI: @Self/@SkipSelf/@Host/@Optional en el constructor, en inject() y como new X() en deps", async () => {
    const code = `
      export class Local {} export class Parent {} export class HostThing {}
      @Component({ selector: "app-card", providers: [{ provide: "report", useFactory: (a: unknown) => a, deps: [[new SkipSelf(), new Optional(), Parent]] }] })
      export class CardComponent {
        private own = inject(Theme, { self: true, optional: false });
        constructor(@Self() a: Local, @SkipSelf() @Optional() b: Parent | null, @Host() c: HostThing) {}
      }
    `;

    const result = await decoratorReaderTransform.transform(code, "card.ts");
    const [metadata] = MetadataStore.get("card.ts") as [ComponentMetadata];

    for (const decorator of ["@Self", "@SkipSelf", "@Optional", "@Host"]) expect(result).not.toContain(decorator);
    expect(metadata.constructorFlags).toEqual([{ self: true }, { skipSelf: true, optional: true }, { host: true }]);
    expect(metadata.injectTokens).toEqual([{ token: own("Theme"), flags: { self: true } }]);
    expect(metadata.providers[0]).toMatchObject({ deps: [own("Parent")], depFlags: [{ skipSelf: true, optional: true }] });
  });

  it("@Optional(): marca el parámetro, se saca del código y acepta `Tipo | null` como token", async () => {
    const code = `
      export class HttpClient {} export class Logger {}
      @Injectable()
      export class FooService {
        constructor(private http: HttpClient, @Optional() private logger: Logger | null, @Optional() @Inject(CONFIG) private config?: unknown) {}
      }
    `;

    const result = await decoratorReaderTransform.transform(code, "foo.service.ts");
    const [metadata] = MetadataStore.get("foo.service.ts") as [ServiceMetadata];

    expect(result).not.toContain("@Optional");
    expect(metadata.constructorTokens).toEqual([own("HttpClient"), own("Logger"), own("CONFIG")]);
    expect(metadata.constructorFlags).toEqual([{}, { optional: true }, { optional: true }]);
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
      export class HttpClient {}
      @Component({ selector: "app-card" })
      export class CardComponent {
        constructor(private http: HttpClient, private untyped) {}
      }
    `;

    await expect(decoratorReaderTransform.transform(code, "card.ts")).rejects.toThrow(
      /"CardComponent" — el parámetro 1 del constructor no tiene tipo de clase ni @Inject()/,
    );
  });

  it("un tipo global (ni importado ni declarado en el archivo, ej. Window) no es token: error en build que pide @Inject", async () => {
    const code = `
      @Injectable()
      export class ScrollService {
        constructor(private win: Window) {}
      }
    `;

    await expect(decoratorReaderTransform.transform(code, "scroll.ts")).rejects.toThrow(/el tipo "Window" .* usá @Inject\(TOKEN\)/);
  });

  it("resuelve el nombre de DI por el import: paquete del specifier, símbolo exportado (no el alias), import type incluido", async () => {
    const code = `
      import { HttpClient as Http } from "ngjs-core/http";
      import type { Store } from "@acme/store/core";
      import { UserService } from "./user.service";
      export class LocalThing {}
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

  it("un import por alias de tsconfig (@/x, @app/x de compilerOptions.paths) es del mismo paquete, no un paquete npm con scope", async () => {
    const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "token-alias-"));
    try {
      await writeFile(join(dir, "package.json"), JSON.stringify({ name: "my-lib" }));
      // Con comentarios y "/*" dentro de strings, como un tsconfig real.
      await writeFile(join(dir, "tsconfig.json"), `{ /* opciones */ "compilerOptions": { "paths": { "@app/*": ["./src/*"], "@/*": ["./src/*"] } } // fin
}`);
      const code = `
        import { Logger } from "@/core/logger";
        import { Http } from "@app/http";
        import { Store } from "@acme/store";
        @Injectable()
        export class Svc { constructor(a: Logger, b: Http, c: Store) {} }
      `;
      const path = join(dir, "svc.ts");
      await decoratorReaderTransform.transform(code, path);
      const [metadata] = MetadataStore.get(path) as [ServiceMetadata];

      expect(metadata.constructorTokens).toEqual([TokenName.of("Logger", "my-lib"), TokenName.of("Http", "my-lib"), TokenName.of("Store", "@acme/store")]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("un servicio lleva su propio nombre de DI (token) — el mismo que calcula quien lo importa", async () => {
    await decoratorReaderTransform.transform(`@Injectable() export class UserService {}`, "user.service.ts");
    const [metadata] = MetadataStore.get("user.service.ts") as [ServiceMetadata];

    expect(metadata.token).toBe(own("UserService"));
  });

  it("lee un template escrito como template literal (backticks) sin interpolaciones; con `${}` no lo resuelve", async () => {
    const code = [
      '@Component({ selector: "app-a", template: `<a href="x">\n  \'b\'</a>` }) export class A {}',
      "@Component({ selector: \"app-b\", template: `<b>${name}</b>` }) export class B {}",
    ].join("\n");
    await decoratorReaderTransform.transform(code, "tpl.ts");

    const [a, b] = MetadataStore.get("tpl.ts") as [ComponentMetadata, ComponentMetadata];
    expect(a.options).toEqual({ selector: "app-a", template: "<a href=\"x\">\n  'b'</a>" });
    expect(b.options).toEqual({ selector: "app-b", template: undefined });
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
    expect(metadata.hostListeners).toEqual([{ methodName: "onClick", eventName: "click", args: ["$event"] }]);
  });

  it("@Input/@HostBinding sobre accessors (setter/getter) y @Input/@Output con objeto de opciones", async () => {
    const code = `
      @Directive({ selector: "[appX]" })
      export class XDirective {
        @Input() set value(v: string) {}
        @Input({ alias: "aka", required: true }) named!: string;
        @Input({ binding: "@" }) label!: string;
        @Output({ alias: "changed" }) change = new EventEmitter();
        @HostBinding("class.active") get active(): boolean { return true; }
      }
    `;

    const result = await decoratorReaderTransform.transform(code, "x.ts");
    const [metadata] = MetadataStore.get("x.ts") as [ComponentMetadata];

    expect(metadata.inputs).toEqual([
      { propName: "value", bindingName: "value" },
      { propName: "named", bindingName: "aka" },
      { propName: "label", bindingName: "label", mode: "@" },
    ]);
    expect(metadata.outputs).toEqual([{ propName: "change", bindingName: "changed" }]);
    expect(metadata.hostBindings).toEqual([{ propName: "active", hostProperty: "class.active" }]);
    expect(result).not.toMatch(/@(Input|Output|HostBinding)/);
  });

  it("@Input({ transform }) o una opción desconocida es error en build (no se ignora)", async () => {
    await expect(
      decoratorReaderTransform.transform(`@Directive({ selector: "[a]" }) export class A { @Input({ transform: booleanAttribute }) on!: boolean; }`, "a.ts"),
    ).rejects.toThrow("`transform` no está soportado");
    await expect(
      decoratorReaderTransform.transform(`@Directive({ selector: "[b]" }) export class B { @Output({ foo: 1 }) done = 1; }`, "b.ts"),
    ).rejects.toThrow('opción "foo" desconocida');
  });

  it("detecta métodos de lifecycle por nombre (sin decorador) y NO los toca en el código", async () => {
    const code = `
      @Component({ selector: "app-card" })
      export class CardComponent {
        ngOnChanges(changes: unknown) {}
        ngOnInit() {}
        ngDoCheck() {}
        ngAfterContentInit() {}
        ngAfterViewInit() {}
        ngOnDestroy() {}
        notALifecycleHook() {}
      }
    `;

    const result = await decoratorReaderTransform.transform(code, "card.ts");
    // Ninguno se saca del código — a diferencia de los decoradores, son métodos comunes.
    expect(result).toContain("ngOnChanges(changes: unknown) {}");
    expect(result).toContain("ngOnInit() {}");
    expect(result).toContain("ngDoCheck() {}");
    expect(result).toContain("ngAfterContentInit() {}");
    expect(result).toContain("ngAfterViewInit() {}");
    expect(result).toContain("ngOnDestroy() {}");

    const [metadata] = MetadataStore.get("card.ts") as [ComponentMetadata];
    expect(metadata.lifecycleHooks).toEqual([
      "ngOnChanges",
      "ngOnInit",
      "ngDoCheck",
      "ngAfterContentInit",
      "ngAfterViewInit",
      "ngOnDestroy",
    ]);
  });

  it("sin ningún método de lifecycle, lifecycleHooks queda vacío", async () => {
    await decoratorReaderTransform.transform(`@Component({ selector: "app-card" }) export class CardComponent {}`, "card.ts");
    const [metadata] = MetadataStore.get("card.ts") as [ComponentMetadata];

    expect(metadata.lifecycleHooks).toEqual([]);
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

    it("cualquier otra llamada queda para evaluarse al correr (ModuleWithProviders), sin mirar el nombre del método", async () => {
      const imports = await importsOf(`[ConfigModule.forRoot(options, withDebug()), configure({ debug: true })]`);

      expect(imports).toEqual([
        { kind: "call", expr: "ConfigModule.forRoot(options, withDebug())" },
        { kind: "call", expr: "configure({ debug: true })" },
      ]);
    });

    it.each([
      ["imports que no es array literal", "SHARED_IMPORTS", /`imports` tiene que ser un array literal/],
      ["spread", "[...SHARED_IMPORTS]", /`imports` no admite huecos ni `...spread`/],
      ["condicional", "[debug ? DebugModule : ProdModule]", /import `debug \? DebugModule : ProdModule` no soportado/],
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
      ["deps con una clase que no es flag de DI", "[{ provide: Logger, deps: [[new Lazy(), HttpClient]] }]", /`new Lazy\(\)` en `deps` no es un flag de DI/],
      ["deps con flags y sin token", "[{ provide: Logger, deps: [[new Optional()]] }]", /cada elemento de `deps`/],
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

  it("@NgModule: lee su constructor (DI, flags, inject()), su base y su token — Angular instancia la clase del módulo", async () => {
    const code = `
      import { Logger } from "./logger";
      import { BaseModule } from "./base.module";
      @NgModule({ declarations: [], imports: [] })
      export class AppModule extends BaseModule {
        readonly config = inject(Config);
        constructor(@Optional() logger: Logger) { super(); }
      }
    `;

    const result = await decoratorReaderTransform.transform(code, "app.module.ts");
    const [metadata] = MetadataStore.get("app.module.ts") as [NgModuleMetadata];

    expect(metadata.token).toBe(own("AppModule"));
    expect(metadata.superClass).toBe("BaseModule");
    expect(metadata.hasConstructor).toBe(true);
    expect(metadata.constructorTokens).toEqual([own("Logger")]);
    expect(metadata.constructorFlags).toEqual([{ optional: true }]);
    expect(metadata.injectTokens).toEqual([{ token: own("Config"), flags: {} }]);
    expect(metadata.constructorImports).toEqual(["./logger"]);
    expect(result).not.toContain("@Optional");
  });

  it("@NgModule: @Attribute() en el constructor es error (no hay host)", async () => {
    const code = `
      @NgModule({ declarations: [], imports: [] })
      export class AppModule { constructor(@Attribute("x") x: string) {} }
    `;

    await expect(decoratorReaderTransform.transform(code, "app.module.ts")).rejects.toThrow(/@Attribute\(\) solo existe en @Component\/@Directive/);
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
