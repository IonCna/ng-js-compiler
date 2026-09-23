import { describe, expect, it } from "vitest";
import { SelectorParser } from "@/compiler/selector-parser.ts";

describe("SelectorParser", () => {
  it("tag simple → un elemento, restrict 'E', sin requiredTag", () => {
    expect(SelectorParser.parse("app-card")).toEqual([{ registrationName: "appCard", restrict: "E" }]);
  });

  it("[atributo] simple → un elemento, restrict 'A', sin requiredTag", () => {
    expect(SelectorParser.parse("[appHighlight]")).toEqual([{ registrationName: "appHighlight", restrict: "A", requiredTag: undefined }]);
  });

  it("tag[atributo] compuesto → un elemento, restrict 'A' bajo el atributo, con requiredTag", () => {
    expect(SelectorParser.parse("button[ngbButtonLabel]")).toEqual([
      { registrationName: "ngbButtonLabel", restrict: "A", requiredTag: "button" },
    ]);
  });

  it("toCamelCase se aplica igual al atributo de un selector compuesto", () => {
    expect(SelectorParser.parse("a[ngb-nav-link]")).toEqual([{ registrationName: "ngbNavLink", restrict: "A", requiredTag: "a" }]);
  });

  it("lista por coma: una entrada por alternativa, cada una parseada por su cuenta", () => {
    expect(SelectorParser.parse("button[ngbNavLink], a[ngbNavLink]")).toEqual([
      { registrationName: "ngbNavLink", restrict: "A", requiredTag: "button" },
      { registrationName: "ngbNavLink", restrict: "A", requiredTag: "a" },
    ]);
  });

  it("lista por coma con espacios variados", () => {
    expect(SelectorParser.parse("[foo] , [bar]")).toEqual([
      { registrationName: "foo", restrict: "A", requiredTag: undefined },
      { registrationName: "bar", restrict: "A", requiredTag: undefined },
    ]);
  });

  it("lista por coma: si una alternativa no es válida, el error señala esa alternativa puntual", () => {
    expect(() => SelectorParser.parse("[foo], .bar")).toThrow(/"\.bar" no es un selector simple/);
  });

  it("con valor (tag[attr=value]) no soportado todavía", () => {
    expect(() => SelectorParser.parse("button[type=submit]")).toThrow(/no es un selector simple/);
  });

  it("clases o pseudo-clases no soportadas", () => {
    expect(() => SelectorParser.parse(".card")).toThrow(/no es un selector simple/);
    expect(() => SelectorParser.parse("a:not(.disabled)")).toThrow(/no es un selector simple/);
  });
});
