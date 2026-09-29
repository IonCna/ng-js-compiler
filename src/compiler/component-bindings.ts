export interface BindingDef {
  propName: string;
  bindingName: string;
  /** Solo inputs: `"@"` = `@Input({ binding: "@" })` (interpolación); sin valor, `<`. */
  mode?: "@";
}

/**
 * Traduce `inputs[]`/`outputs[]` (ya normalizados por `DecoratorReader`) al
 * objeto `bindings` de AngularJS. La clave es siempre la propiedad del
 * controller (`propName`); el valor es el modo (`<` para input, `&` para
 * output) + `?` (siempre opcional — `DecoratorReader` no distingue todavía
 * `@Input({ required: true })` ni bindings `@`/two-way, así que todos los
 * inputs salen `<?`) + el nombre del atributo si difiere de la propiedad.
 *
 *   `@Input() count`        → `{ count: '<?' }`
 *   `@Input('data') items`  → `{ items: '<?data' }`
 *   `@Output() closed`      → `{ closed: '&?' }`
 *   `@Input({ binding: "@" }) label` → `{ label: '@?' }`
 *   `@Input() disabled`     → `{ disabled: '<?ngDisabled' }` (ver `RESERVED_INPUTS`)
 */
export class ComponentBindings {
  /**
   * Inputs `<` con nombre de atributo nativo: el atributo es la directiva `ng-*` que lo enlaza — la de AngularJS
   * (`ng-disabled`, `ng-readonly`, …) o, si AngularJS no la trae, la de `ngjs-core` (`ng-hidden`, `ng-id`,
   * `ng-title`). Con el nombre nativo, AngularJS pisa el valor con `true` en `button`/`input`/`select`/… (un booleano
   * presente) y el browser aplica el efecto aunque la expresión dé `false`. Con `ng-disabled="x"` el input recibe `x`
   * y la directiva aplica el nativo. `ng-js-template-compiler` traduce `disabled="x"` si está en el pipeline.
   */
  static readonly RESERVED_INPUTS: Readonly<Record<string, string>> = {
    disabled: "ngDisabled",
    hidden: "ngHidden",
    readonly: "ngReadonly",
    required: "ngRequired",
    checked: "ngChecked",
    selected: "ngSelected",
    open: "ngOpen",
    id: "ngId",
    title: "ngTitle",
  };

  /**
   * Los de `RESERVED_INPUTS` que son booleanos: en un elemento nativo, `disabled` / `disabled="disabled"` es HTML
   * estático y `disabled="x"` un binding. Un `title="Cerrar"` en cambio es siempre texto.
   */
  static readonly BOOLEAN_ATTRIBUTES: ReadonlySet<string> = new Set(["disabled", "hidden", "readonly", "required", "checked", "selected", "open"]);

  /** El atributo de AngularJS de un input `<` reservado (`disabled` → `ngDisabled`), o `undefined`. */
  static reservedAttribute(bindingName: string): string | undefined {
    return Object.hasOwn(ComponentBindings.RESERVED_INPUTS, bindingName) ? ComponentBindings.RESERVED_INPUTS[bindingName] : undefined;
  }

  static from(inputs: BindingDef[], outputs: BindingDef[]): Record<string, string> {
    const bindings: Record<string, string> = {};
    for (const input of inputs) {
      const reserved = input.mode === undefined ? ComponentBindings.reservedAttribute(input.bindingName) : undefined;
      bindings[input.propName] = ComponentBindings.expr(input.mode ?? "<", reserved ? { ...input, bindingName: reserved } : input);
    }
    for (const output of outputs) bindings[output.propName] = ComponentBindings.expr("&", output);
    return bindings;
  }

  private static expr(mode: string, def: BindingDef): string {
    const alias = def.bindingName === def.propName ? "" : def.bindingName;
    return `${mode}?${alias}`;
  }
}
