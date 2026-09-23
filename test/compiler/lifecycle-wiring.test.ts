import { describe, expect, it } from "vitest";
import { LifecycleWiring } from "@/compiler/lifecycle-wiring.ts";

/** Corre los statements generados sobre una clase de prueba y devuelve su prototype. */
function evaluate(statements: string[], classBody: string): Record<string, (...a: unknown[]) => unknown> {
  const code = `class Card { ${classBody} }\n${statements.join("\n")}\nreturn Card.prototype;`;
  // eslint-disable-next-line no-new-func
  return new Function(code)();
}

describe("LifecycleWiring", () => {
  it("hasAny(): true con al menos un hook, false sin ninguno", () => {
    expect(LifecycleWiring.hasAny([])).toBe(false);
    expect(LifecycleWiring.hasAny(["ngOnInit"])).toBe(true);
  });

  it("ngOnInit/ngOnDestroy: rename directo a $onInit/$onDestroy", () => {
    const statements = LifecycleWiring.statements("Card", ["ngOnInit", "ngOnDestroy"], []);
    const proto = evaluate(statements, `
      calls = [];
      ngOnInit() { this.calls.push("init"); }
      ngOnDestroy() { this.calls.push("destroy"); }
    `);

    const instance: { calls: string[] } = Object.create(proto);
    instance.calls = [];
    proto.$onInit!.call(instance);
    proto.$onDestroy!.call(instance);

    expect(instance.calls).toEqual(["init", "destroy"]);
  });

  it("sin ngOnInit, no se estampa $onInit en absoluto", () => {
    const statements = LifecycleWiring.statements("Card", ["ngOnDestroy"], []);
    expect(statements.join("\n")).not.toContain("$onInit");
  });

  it("$postLink: ngAfterContentInit antes que ngAfterViewInit, como en Angular real", () => {
    const statements = LifecycleWiring.statements("Card", ["ngAfterViewInit", "ngAfterContentInit"], []);
    const proto = evaluate(statements, `
      calls = [];
      ngAfterContentInit() { this.calls.push("content"); }
      ngAfterViewInit() { this.calls.push("view"); }
    `);

    const instance: { calls: string[] } = Object.create(proto);
    instance.calls = [];
    proto.$postLink!.call(instance);

    expect(instance.calls).toEqual(["content", "view"]);
  });

  it("$postLink con un solo hook: llama solo ese", () => {
    const statements = LifecycleWiring.statements("Card", ["ngAfterViewInit"], []);
    const proto = evaluate(statements, `
      calls = [];
      ngAfterViewInit() { this.calls.push("view"); }
    `);

    const instance: { calls: string[] } = Object.create(proto);
    instance.calls = [];
    proto.$postLink!.call(instance);

    expect(instance.calls).toEqual(["view"]);
  });

  it("$onChanges: adapta por propName (no bindingName), con firstChange como propiedad Y como método", () => {
    const statements = LifecycleWiring.statements(
      "Card",
      ["ngOnChanges"],
      [
        { propName: "title", bindingName: "title" },
        { propName: "alias", bindingName: "aka" },
      ],
    );
    const proto = evaluate(statements, `
      received;
      ngOnChanges(changes) { this.received = changes; }
    `);

    const instance: { received?: unknown } = Object.create(proto);
    proto.$onChanges!.call(instance, {
      title: { previousValue: undefined, currentValue: "Hola", isFirstChange: () => true },
      aka: { previousValue: "a", currentValue: "b", isFirstChange: () => false },
      // Un binding que no está declarado en `inputs` (otro bridge, o ruido) se ignora sin romper nada.
      unrelated: { previousValue: 1, currentValue: 2, isFirstChange: () => true },
    });

    expect(instance.received).toEqual({
      title: { previousValue: undefined, currentValue: "Hola", firstChange: true, isFirstChange: expect.any(Function) },
      alias: { previousValue: "a", currentValue: "b", firstChange: false, isFirstChange: expect.any(Function) },
    });
    expect((instance.received as { title: { isFirstChange(): boolean } }).title.isFirstChange()).toBe(true);
  });

  it("$doCheck: ngDoCheck llama directo (sincrónico); sin AfterContentChecked/AfterViewChecked no hay $evalAsync", () => {
    const statements = LifecycleWiring.statements("Card", ["ngDoCheck"], []);
    const proto = evaluate(statements, `
      calls = [];
      ngDoCheck() { this.calls.push("doCheck"); }
    `);

    const instance: { calls: string[] } = Object.create(proto);
    instance.calls = [];
    proto.$doCheck!.call(instance);

    expect(instance.calls).toEqual(["doCheck"]);
  });

  it("$doCheck: AfterContentChecked/AfterViewChecked corren sincrónico, en orden, después de ngDoCheck", () => {
    // Nada de $evalAsync acá: $doCheck corre una vez por CADA pasada interna del digest (no una vez por
    // digest lógico) — encolar algo en $evalAsync desde ahí deja la cola async no vacía para siempre y
    // AngularJS aborta con "$digest() iterations reached" (probado con AngularJS real).
    const statements = LifecycleWiring.statements("Card", ["ngDoCheck", "ngAfterContentChecked", "ngAfterViewChecked"], []);
    const proto = evaluate(statements, `
      calls = [];
      ngDoCheck() { this.calls.push("doCheck"); }
      ngAfterContentChecked() { this.calls.push("content"); }
      ngAfterViewChecked() { this.calls.push("view"); }
    `);

    const instance: { calls: string[] } = Object.create(proto);
    instance.calls = [];
    proto.$doCheck!.call(instance);

    expect(instance.calls).toEqual(["doCheck", "content", "view"]);
  });

  it("$doCheck: solo AfterViewChecked (sin ContentChecked ni ngDoCheck) también corre sincrónico", () => {
    const statements = LifecycleWiring.statements("Card", ["ngAfterViewChecked"], []);
    const proto = evaluate(statements, `
      calls = [];
      ngAfterViewChecked() { this.calls.push("view"); }
    `);

    const instance: { calls: string[] } = Object.create(proto);
    instance.calls = [];
    proto.$doCheck!.call(instance);

    expect(instance.calls).toEqual(["view"]);
  });
});
