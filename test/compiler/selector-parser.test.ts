import { describe, expect, it } from "vitest";
import { type SelectorTarget, SelectorParser } from "@/compiler/selector-parser.ts";

/** Registro de cada alternativa, sin el selector compuesto. */
const registrations = (selector: string) =>
  SelectorParser.parse(selector).map(({ registrationName, restrict, requiredTag }) => ({ registrationName, restrict, requiredTag }));

describe("SelectorParser", () => {
  it("tag simple → un elemento, restrict 'E', sin requiredTag", () => {
    expect(registrations("app-card")).toEqual([{ registrationName: "appCard", restrict: "E", requiredTag: undefined }]);
  });

  it("[atributo] simple → un elemento, restrict 'A', sin requiredTag", () => {
    expect(registrations("[appHighlight]")).toEqual([{ registrationName: "appHighlight", restrict: "A", requiredTag: undefined }]);
  });

  it("tag[atributo] compuesto → un elemento, restrict 'A' bajo el atributo, con requiredTag", () => {
    expect(registrations("button[ngbButtonLabel]")).toEqual([{ registrationName: "ngbButtonLabel", restrict: "A", requiredTag: "button" }]);
  });

  it("toCamelCase se aplica igual al atributo de un selector compuesto", () => {
    expect(registrations("a[ngb-nav-link]")).toEqual([{ registrationName: "ngbNavLink", restrict: "A", requiredTag: "a" }]);
  });

  it("lista por coma: una entrada por alternativa, cada una parseada por su cuenta", () => {
    expect(registrations("button[ngbNavLink], a[ngbNavLink]")).toEqual([
      { registrationName: "ngbNavLink", restrict: "A", requiredTag: "button" },
      { registrationName: "ngbNavLink", restrict: "A", requiredTag: "a" },
    ]);
  });

  it("lista por coma con espacios variados", () => {
    expect(registrations("[foo] , [bar]")).toEqual([
      { registrationName: "foo", restrict: "A", requiredTag: undefined },
      { registrationName: "bar", restrict: "A", requiredTag: undefined },
    ]);
  });

  it("[atributo=valor]: se registra por el atributo y el valor queda en el selector compuesto", () => {
    const [parsed] = SelectorParser.parse('button[type="submit"]');
    expect(parsed).toMatchObject({ registrationName: "type", restrict: "A", requiredTag: "button" });
    expect(parsed!.compound).toEqual({ tag: "button", attributes: [{ name: "type", value: "submit" }], classes: [], not: [] });
  });

  it(".clase: restrict 'C' si no hay atributo; con atributo, se registra por el atributo", () => {
    expect(registrations(".card-body")).toEqual([{ registrationName: "cardBody", restrict: "C", requiredTag: undefined }]);
    expect(registrations("div.card[appCard]")).toEqual([{ registrationName: "appCard", restrict: "A", requiredTag: "div" }]);
  });

  it(":not(...) — también con lista adentro — queda en el selector compuesto", () => {
    const [parsed] = SelectorParser.parse("input[ngModel]:not([type=checkbox], [formControl])");
    expect(parsed).toMatchObject({ registrationName: "ngModel", restrict: "A", requiredTag: "input" });
    expect(parsed!.compound.not).toEqual([
      { attributes: [{ name: "type", value: "checkbox" }], classes: [], not: [] },
      { attributes: [{ name: "formControl" }], classes: [], not: [] },
    ]);
    expect(SelectorParser.parse("a:not(.disabled), button")).toHaveLength(2);
  });

  it("matches: la alternativa entera contra un elemento (atributos normalizados como AngularJS)", () => {
    const target = (tagName: string, attributes: Record<string, string>, classes: string[] = []): SelectorTarget => ({
      tagName,
      attribute: (name) => attributes[name] ?? null,
      hasClass: (name) => classes.includes(name),
    });
    const { compound } = SelectorParser.parse("input[ngModel].x:not([type=checkbox])")[0]!;
    expect(SelectorParser.matches(compound, target("input", { ngModel: "" }, ["x"]))).toBe(true);
    expect(SelectorParser.matches(compound, target("input", { ngModel: "", type: "checkbox" }, ["x"]))).toBe(false);
    expect(SelectorParser.matches(compound, target("input", { ngModel: "" }))).toBe(false);
    expect(SelectorParser.matches(compound, target("select", { ngModel: "" }, ["x"]))).toBe(false);
  });

  it("lo que no es un selector de Angular es error y señala la alternativa", () => {
    expect(() => SelectorParser.parse("[foo], div > span")).toThrow(/"div > span" no es un selector de Angular/);
    expect(() => SelectorParser.parse(":not(.x)")).toThrow(/no tiene tag, atributo ni clase/);
    expect(() => SelectorParser.parse("a:not(.x")).toThrow(/no es un selector de Angular/);
  });
});
