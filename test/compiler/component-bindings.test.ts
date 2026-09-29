import { describe, expect, it } from "vitest";
import { ComponentBindings } from "@/compiler/component-bindings.ts";

describe("ComponentBindings", () => {
  it("un input `<` con nombre de atributo booleano nativo se registra con su directiva ng-* de AngularJS", () => {
    const bindings = ComponentBindings.from(
      [
        { propName: "disabled", bindingName: "disabled" },
        { propName: "isHidden", bindingName: "hidden" },
        { propName: "readonly", bindingName: "readonly", mode: "@" },
        { propName: "rate", bindingName: "rate" },
        { propName: "id", bindingName: "id" },
      ],
      [{ propName: "closed", bindingName: "closed" }],
    );

    expect(bindings).toEqual({
      disabled: "<?ngDisabled",
      isHidden: "<?ngHidden",
      // `@` es un atributo estático (como en Angular): queda con su nombre.
      readonly: "@?",
      rate: "<?",
      id: "<?ngId",
      closed: "&?",
    });
  });
});
