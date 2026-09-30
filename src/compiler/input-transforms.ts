import type { BindingsMetadata } from "@/metadata/decorator-metadata.ts";

type Inputs = BindingsMetadata["inputs"];

/**
 * `@Input({ transform })` (Angular 16.1): cada valor que llega por el binding pasa por `transform` antes de llegar a la
 * clase — el valor inicial del campo no. La función es una expresión del archivo que declara el input (un import, una
 * arrow), así que se estampa ahí, en la clase (`X.ɵinputTransforms`, getters: se resuelven al usarse), y quien la usa
 * (la clase o una subclase de otro archivo) la busca subiendo por la cadena de clases (`ɵinputTransform`).
 *
 * En la instancia, el input pasa a ser un accessor propio (`ɵtransformInput`): AngularJS asigna el binding
 * (`instance[prop] = valor`) después de construir, y el setter lo transforma. Si la clase tiene su propio accessor
 * (`@Input({ transform }) set x(v)`), recibe el valor ya transformado, como en Angular.
 */
export class InputTransforms {
  /** Los `transform` propios de la clase (no los heredados), o `undefined`. */
  static declarationStatement(className: string, inputs: Inputs): string | undefined {
    const own = inputs.filter((input) => input.transformExpr !== undefined);
    if (!own.length) return undefined;
    const getters = own.map((input) => `get ${JSON.stringify(input.propName)}() { return (${input.transformExpr}); }`);
    return `${className}.ɵinputTransforms = { ${getters.join(", ")} };`;
  }

  static hasAny(inputs: Inputs): boolean {
    return inputs.some((input) => input.transformExpr !== undefined);
  }

  /** Para el factory (después del `new`): convierte cada input con `transform` en un accessor de la instancia. */
  static wiringStatements(className: string, inputs: Inputs): string[] {
    return inputs
      .filter((input) => input.transformExpr !== undefined)
      .map((input) => `ɵtransformInput(instance, ${JSON.stringify(input.propName)}, ${InputTransforms.lookupExpr(className, input.propName)});`);
  }

  /** La función de `transform` de `propName`, buscada desde `className` hacia sus bases. */
  static lookupExpr(className: string, propName: string): string {
    return `ɵinputTransform(${className}, ${JSON.stringify(propName)})`;
  }

  /** Helpers por archivo (como `ElementInstances.helperSource`): se agregan si algún statement los usa. */
  static helperSource(): string {
    return [
      "function ɵinputTransform(type, name) {",
      "  for (var c = type; c; c = Object.getPrototypeOf(c)) {",
      '    if (Object.prototype.hasOwnProperty.call(c, "ɵinputTransforms") && Object.prototype.hasOwnProperty.call(c.ɵinputTransforms, name)) return c.ɵinputTransforms[name];',
      "  }",
      "  return function (value) { return value; };",
      "}",
      // El accessor de la clase se busca en cada acceso (no al construir): un bridge del runtime puede envolverlo después.
      "function ɵinputAccessor(instance, name) {",
      "  for (var o = Object.getPrototypeOf(instance); o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {",
      "    var d = Object.getOwnPropertyDescriptor(o, name);",
      "    if (d) return d.get || d.set ? d : undefined;",
      "  }",
      "}",
      "function ɵtransformInput(instance, name, transform) {",
      "  var own = Object.getOwnPropertyDescriptor(instance, name);",
      "  var value = own ? own.value : undefined;",
      "  Object.defineProperty(instance, name, {",
      "    configurable: true,",
      "    enumerable: true,",
      "    get: function () { var a = ɵinputAccessor(this, name); return a ? (a.get ? a.get.call(this) : undefined) : value; },",
      "    set: function (next) { next = transform(next); var a = ɵinputAccessor(this, name); if (!a) value = next; else if (a.set) a.set.call(this, next); },",
      "  });",
      "}",
    ].join("\n");
  }
}
