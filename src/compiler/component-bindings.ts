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
 */
export class ComponentBindings {
  static from(inputs: BindingDef[], outputs: BindingDef[]): Record<string, string> {
    const bindings: Record<string, string> = {};
    for (const input of inputs) bindings[input.propName] = ComponentBindings.expr(input.mode ?? "<", input);
    for (const output of outputs) bindings[output.propName] = ComponentBindings.expr("&", output);
    return bindings;
  }

  private static expr(mode: string, def: BindingDef): string {
    const alias = def.bindingName === def.propName ? "" : def.bindingName;
    return `${mode}?${alias}`;
  }
}
