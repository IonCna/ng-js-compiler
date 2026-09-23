import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentMetadata, DirectiveMetadata } from "@/metadata/decorator-metadata.ts";
import { MetadataStore } from "@/metadata/metadata-store.ts";
import { DecoratorWriter } from "@/compiler/decorator-writer.ts";

/** Corre el JS emitido y devuelve la clase con lo que se le estampó. */
function evaluate(output: string, className: string): Record<string, unknown> {
  // eslint-disable-next-line no-new-func
  return new Function(`${output}; return ${className};`)() as Record<string, unknown>;
}

function component(overrides: Partial<ComponentMetadata> = {}): ComponentMetadata {
  return {
    kind: "component",
    className: "CardComponent",
    options: { selector: "app-card" },
    constructorTokens: [], constructorImports: [],
    inputs: [],
    outputs: [],
    hostBindings: [],
    hostListeners: [],
    providers: [],
    lifecycleHooks: [],
    ...overrides,
  };
}

describe("DecoratorWriter", () => {
  afterEach(() => {
    MetadataStore.clear();
  });

  it("devuelve undefined si no hay metadata para el path", () => {
    expect(DecoratorWriter.write("class Foo {}", "foo.ts")).toBeUndefined();
  });

  it("ɵfac: factory con anotación en array — nombres de DI como strings, $element/$scope siempre al final antes del factory", () => {
    MetadataStore.set("card.ts", [component({ constructorTokens: ["UserService_1a2b3c4d", "$http"] })]);

    const output = DecoratorWriter.write("class CardComponent { constructor(u, h) { this.u = u; this.h = h; } }", "card.ts")!;

    expect(output).toContain(
      'CardComponent.ɵfac = ["UserService_1a2b3c4d", "$http", "$element", "$scope", function CardComponent_Factory(a0, a1, $element, $scope) { var instance = new CardComponent(a0, a1); return instance; }];',
    );
    const fac = evaluate(output, "CardComponent").ɵfac as [
      string,
      string,
      string,
      string,
      (a: unknown, b: unknown, element: unknown, scope: unknown) => { u: unknown; h: unknown },
    ];
    const instance = fac[4]("u", "h", {}, "the-scope");
    expect(instance).toMatchObject({ u: "u", h: "h" });
  });

  it("un import de efecto por cada archivo del que viene una dependencia del constructor (que se evalúe aunque solo se use como tipo)", () => {
    MetadataStore.set("card.ts", [component({ constructorTokens: ["UserService_1a2b3c4d"], constructorImports: ["./user.service"] })]);

    const output = DecoratorWriter.write("class CardComponent {}", "card.ts")!;

    expect(output).toContain('import "./user.service";');
  });

  it("ɵfac sin constructor: igual agrega $element/$scope (@Component/@Directive siempre los llevan)", () => {
    MetadataStore.set("card.ts", [component()]);

    const output = DecoratorWriter.write("class CardComponent {}", "card.ts")!;

    expect(output).toContain(
      'CardComponent.ɵfac = ["$element", "$scope", function CardComponent_Factory($element, $scope) { var instance = new CardComponent(); return instance; }];',
    );
  });

  it("ɵfac de @Injectable/@Pipe: sin $element/$scope — no son controllers de AngularJS", () => {
    MetadataStore.set("pipes.ts", [
      { kind: "pipe", className: "UpperPipe", options: { name: "upper" }, constructorTokens: [], constructorImports: [] },
    ]);

    const output = DecoratorWriter.write("class UpperPipe {}", "pipes.ts")!;

    expect(output).toContain("UpperPipe.ɵfac = [function UpperPipe_Factory() { return new UpperPipe(); }];");
    expect(output).not.toContain("$element");
  });

  it("ɵcmp con la forma de Ivy: selectors en arrays, inputs/outputs nombre público → propiedad, exportAs como array", () => {
    MetadataStore.set("card.ts", [
      component({
        options: { selector: "app-card", templateUrl: "./card.html", exportAs: "card" },
        inputs: [
          { propName: "title", bindingName: "title" },
          { propName: "alias", bindingName: "aka" },
        ],
        outputs: [{ propName: "closed", bindingName: "closed" }],
        hostBindings: [{ propName: "isOpen", hostProperty: "class.open" }],
        providers: [{ kind: "class", token: "SomeService_1a2b3c4d", classExpr: "SomeService" }],
      }),
    ]);

    const output = DecoratorWriter.write("class SomeService {}\nclass CardComponent {}", "card.ts")!;
    const CardComponent = evaluate(output, "CardComponent") as { ɵcmp: unknown; ɵfac: { ɵproviders?: unknown } };

    expect(CardComponent.ɵcmp).toEqual({
      selectors: [["app-card"]],
      inputs: { title: "title", aka: "alias" },
      outputs: { closed: "closed" },
      exportAs: ["card"],
    });
    expect(CardComponent.ɵfac.ɵproviders).toEqual([{ token: "SomeService_1a2b3c4d", kind: "class", ctor: expect.any(Function) }]);
    expect(output).not.toContain("$name");
    expect(output).not.toContain("$inject");
  });

  it("ɵdir para @Directive: selectores de atributo, compuestos y listas", () => {
    const directive: DirectiveMetadata = {
      ...component({ className: "HighlightDirective" }),
      kind: "directive",
      options: { selector: "[appHighlight], button[type=submit]" },
    };
    MetadataStore.set("highlight.ts", [directive]);

    const output = DecoratorWriter.write("class HighlightDirective {}", "highlight.ts")!;

    expect(output).not.toContain("ɵcmp");
    expect((evaluate(output, "HighlightDirective").ɵdir as { selectors: unknown }).selectors).toEqual([
      ["", "appHighlight", ""],
      ["button", "type", "submit"],
    ]);
  });

  it("selector compuesto (tag[atributo]): el factory guarda el tag, avisa en consola y devuelve un objeto vacío si no matchea — el constructor real nunca corre", () => {
    const directive: DirectiveMetadata = {
      ...component({ className: "ButtonLabel" }),
      kind: "directive",
      options: { selector: "button[ngbButtonLabel]" },
    };
    MetadataStore.set("button-label.ts", [directive]);

    const output = DecoratorWriter.write("class ButtonLabel {}", "button-label.ts")!;

    expect(output).toContain(
      'if (["button"].indexOf($element[0].tagName.toLowerCase()) === -1) { console.warn("ButtonLabel: este selector requiere <button>, no se aplica en <" + $element[0].tagName.toLowerCase() + ">."); return {}; }',
    );

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ButtonLabel = evaluate(output, "ButtonLabel") as unknown as new () => object;
    const fac = (ButtonLabel as unknown as { ɵfac: unknown }).ɵfac as [
      string,
      string,
      (element: unknown, scope: unknown) => Record<string, unknown>,
    ];

    // Tag equivocado: no construye la clase real, avisa, devuelve {} — bindToController pisaría props ahí sin romper nada.
    const mismatched = fac[2]({ 0: { tagName: "LABEL" } }, {});
    expect(mismatched).toEqual({});
    expect(mismatched).not.toBeInstanceOf(ButtonLabel);
    expect(warn).toHaveBeenCalledWith("ButtonLabel: este selector requiere <button>, no se aplica en <label>.");

    // Tag correcto: construye normal.
    const matched = fac[2]({ 0: { tagName: "BUTTON" } }, {});
    expect(matched).toBeInstanceOf(ButtonLabel);

    warn.mockRestore();
  });

  it("lista por coma, todas compuestas con el mismo atributo (\"button[x], label[x]\"): el guard acepta cualquiera de los tags", () => {
    const directive: DirectiveMetadata = {
      ...component({ className: "ButtonLabel" }),
      kind: "directive",
      options: { selector: "button[ngbButtonLabel], label[ngbButtonLabel]" },
    };
    MetadataStore.set("button-label.ts", [directive]);

    const output = DecoratorWriter.write("class ButtonLabel {}", "button-label.ts")!;

    expect(output).toContain('if (["button","label"].indexOf($element[0].tagName.toLowerCase()) === -1)');

    const ButtonLabel = evaluate(output, "ButtonLabel") as unknown as new () => object;
    const fac = (ButtonLabel as unknown as { ɵfac: unknown }).ɵfac as [
      string,
      string,
      (element: unknown, scope: unknown) => Record<string, unknown>,
    ];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(fac[2]({ 0: { tagName: "BUTTON" } }, {})).toBeInstanceOf(ButtonLabel);
    expect(fac[2]({ 0: { tagName: "LABEL" } }, {})).toBeInstanceOf(ButtonLabel);
    expect(fac[2]({ 0: { tagName: "SPAN" } }, {})).not.toBeInstanceOf(ButtonLabel);
    expect(warn).toHaveBeenCalledTimes(1);

    warn.mockRestore();
  });

  it("lista por coma mixta (una compuesta + una sin tag, \"[foo], button[bar]\"): sin guard — no se sabe cuál alternativa matcheó", () => {
    const directive: DirectiveMetadata = {
      ...component({ className: "Mixed" }),
      kind: "directive",
      options: { selector: "[foo], button[bar]" },
    };
    MetadataStore.set("mixed.ts", [directive]);

    const output = DecoratorWriter.write("class Mixed {}", "mixed.ts")!;

    expect(output).not.toContain("tagName");
    expect(output).not.toContain("console.warn");
  });

  it("selector simple ([atributo] o tag): sin guard de tag en el factory", () => {
    MetadataStore.set("card.ts", [component({ options: { selector: "app-card" } })]);

    const output = DecoratorWriter.write("class CardComponent {}", "card.ts")!;

    expect(output).not.toContain("tagName");
    expect(output).not.toContain("console.warn");
  });

  it("selector no soportado (clases) es error claro", () => {
    MetadataStore.set("card.ts", [component({ options: { selector: ".card" } })]);

    expect(() => DecoratorWriter.write("class CardComponent {}", "card.ts")).toThrow(/selector ".card" no soportado/);
  });

  it("ɵprov con el token resuelto en build; providedIn solo si es 'root'", () => {
    MetadataStore.set("foo.service.ts", [
      { kind: "injectable", className: "FooService", options: { providedIn: "root" }, constructorTokens: [], constructorImports: [], token: "FooService_1a2b3c4d" },
    ]);

    const output = DecoratorWriter.write("class FooService {}", "foo.service.ts")!;

    expect(evaluate(output, "FooService").ɵprov).toEqual({ token: "FooService_1a2b3c4d", providedIn: "root" });
    expect(output).not.toContain("$name");
  });

  it("providedIn root se anota en la cola de la plataforma; sin providedIn no", () => {
    MetadataStore.set("services.ts", [
      { kind: "injectable", className: "RootService", options: { providedIn: "root" }, constructorTokens: [], constructorImports: [], token: "RootService_1a2b3c4d" },
      { kind: "injectable", className: "LocalService", options: {}, constructorTokens: [], constructorImports: [], token: "LocalService_1a2b3c4d" },
    ]);

    const output = DecoratorWriter.write("class RootService {}\nclass LocalService {}", "services.ts")!;
    // eslint-disable-next-line no-new-func
    const queue = new Function(`const globalThis = {}; ${output}; return globalThis.ɵngjsRootProviders;`)() as [string, unknown[]][];

    expect(queue.map(([token]) => token)).toEqual(["RootService_1a2b3c4d"]);
    expect(queue[0]![1]).toEqual(["function RootService_Factory() { return new RootService(); }"].map(() => expect.any(Function)));
  });

  it("ɵpipe con name y pure (true por default, como Angular)", () => {
    MetadataStore.set("pipes.ts", [
      { kind: "pipe", className: "UpperPipe", options: { name: "upper" }, constructorTokens: [], constructorImports: [] },
      { kind: "pipe", className: "NowPipe", options: { name: "now", pure: false }, constructorTokens: [], constructorImports: [] },
    ]);

    const output = DecoratorWriter.write("class UpperPipe {}\nclass NowPipe {}", "pipes.ts")!;

    expect(output).toContain('UpperPipe.ɵpipe = { name: "upper", pure: true };');
    expect(output).toContain('NowPipe.ɵpipe = { name: "now", pure: false };');
  });

  it("con @HostBinding/@HostListener: el factory agrega $element/$scope, aplica el binding vía $watch, llama al listener dentro de $apply y limpia todo en $destroy", () => {
    MetadataStore.set("card.ts", [
      component({
        hostBindings: [{ propName: "isOpen", hostProperty: "class.open" }],
        hostListeners: [{ methodName: "onClick", eventName: "click", args: ["$event"] }],
      }),
    ]);

    const output = DecoratorWriter.write(
      "class CardComponent { isOpen = false; onClick(event) { this.lastEvent = event; } }",
      "card.ts",
    )!;

    expect(output).toContain('CardComponent.ɵfac = ["$element", "$scope", function CardComponent_Factory($element, $scope)');

    const fac = evaluate(output, "CardComponent").ɵfac as [string, string, (element: unknown, scope: unknown) => Record<string, unknown>];

    const addClass = vi.fn();
    const removeClass = vi.fn();
    const on = vi.fn();
    const off = vi.fn();
    const $element = { addClass, removeClass, on, off };

    const watches: { watchFn: () => unknown; listenerFn: (value: unknown) => void; unwatch: () => void }[] = [];
    let destroyHandler: (() => void) | undefined;
    const $scope = {
      $watch: (watchFn: () => unknown, listenerFn: (value: unknown) => void) => {
        const unwatch = vi.fn();
        watches.push({ watchFn, listenerFn, unwatch });
        return unwatch;
      },
      $on: (event: string, handler: () => void) => {
        if (event === "$destroy") destroyHandler = handler;
      },
      $apply: (fn: () => void) => fn(),
      $root: { $$phase: null as string | null },
    };

    const instance = fac[2]($element, $scope) as { isOpen: boolean; onClick(event: unknown): void; lastEvent?: unknown };

    // @HostBinding vía $watch: se aplica cuando el watcher dispara, no al construir.
    expect(watches).toHaveLength(1);
    expect(watches[0]!.watchFn()).toBe(false);
    watches[0]!.listenerFn(true);
    expect(addClass).toHaveBeenCalledWith("open");
    watches[0]!.listenerFn(false);
    expect(removeClass).toHaveBeenCalledWith("open");

    // @HostListener: $element.on con el nombre del evento, $event pasado tal cual, adentro de $scope.$apply.
    expect(on).toHaveBeenCalledWith("click", expect.any(Function));
    const handler = on.mock.calls[0]![1] as (event: unknown) => void;
    handler({ type: "click" });
    expect(instance.lastEvent).toEqual({ type: "click" });

    // Safe apply: si ya hay un digest en curso, no llama $apply (tiraría "digest already in progress") — llama directo.
    const apply = vi.spyOn($scope, "$apply");
    $scope.$root.$$phase = "$digest";
    handler({ type: "click", phase: "digest" });
    expect(instance.lastEvent).toEqual({ type: "click", phase: "digest" });
    expect(apply).not.toHaveBeenCalled();
    $scope.$root.$$phase = null;

    // $destroy: desregistra el watch y saca el listener.
    destroyHandler?.();
    expect(watches[0]!.unwatch).toHaveBeenCalled();
    expect(off).toHaveBeenCalledWith("click", handler);
  });

  it("ignora 'ngmodule' — eso lo procesa ModuleWriter, no acá", () => {
    MetadataStore.set("app.module.ts", [
      { kind: "ngmodule", className: "AppModule", declarations: [], imports: [], providers: [], bootstrap: [] },
    ]);

    expect(DecoratorWriter.write("class AppModule {}", "app.module.ts")).toBeUndefined();
  });
});
