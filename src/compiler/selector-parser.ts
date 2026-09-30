/**
 * Traduce el selector de un `@Component`/`@Directive` a cómo lo registra AngularJS. Angular acepta un selector
 * compuesto por alternativa (lista por coma): tag, `[atributo]`, `[atributo=valor]`, `.clase` y `:not(...)`.
 * AngularJS solo matchea por UN nombre (tag `E`, atributo `A` o clase `C`), así que se registra por el primer
 * atributo, si no hay por la primera clase, si no por el tag; el resto del selector (`guard`) lo valida
 * `DecoratorWriter` en el factory, al construir. `requiredTag` es el caso común de eso (`button[ngbNavLink]`).
 */
export interface CompoundSelector {
  tag?: string;
  attributes: { name: string; value?: string }[];
  classes: string[];
  not: CompoundSelector[];
}

export interface ParsedSelector {
  /** Nombre con que AngularJS registra la directiva (`.component()`/`.directive()`), en camelCase. */
  registrationName: string;
  /** `'E'` por tag, `'A'` por atributo, `'C'` por clase (`'AC'`: dos alternativas con el mismo nombre, al registrar). */
  restrict: "A" | "E" | "C" | "AC";
  /** El tag que el selector exige además de lo que registra — AngularJS no lo puede filtrar solo. */
  requiredTag?: string;
  /** Todo el selector de la alternativa (lo que registra incluido). */
  compound: CompoundSelector;
}

/** Lo que `matches` lee de un elemento (`ng-js-template-compiler` en build; el guard del factory hace lo mismo en JS). */
export interface SelectorTarget {
  tagName: string;
  /** Valor del atributo por su nombre normalizado como AngularJS (`ngbNavLink`, sin `data-`/`x-`), o `null`. */
  attribute(name: string): string | null;
  hasClass(name: string): boolean;
}

export class SelectorParser {
  static toCamelCase(value: string): string {
    return value.replace(/-([a-z0-9])/g, (_match, char: string) => char.toUpperCase());
  }

  /** Una entrada por alternativa — un selector sin coma da un array de un solo elemento. */
  static parse(selector: string): ParsedSelector[] {
    return SelectorParser.splitList(selector).map((part) => SelectorParser.parseOne(part.trim()));
  }

  /** Si `target` cumple la alternativa entera. */
  static matches(compound: CompoundSelector, target: SelectorTarget): boolean {
    if (compound.tag && target.tagName.toLowerCase() !== compound.tag.toLowerCase()) return false;
    for (const { name, value } of compound.attributes) {
      const actual = target.attribute(SelectorParser.toCamelCase(name));
      if (value === undefined ? actual === null : actual !== value) return false;
    }
    if (!compound.classes.every((name) => target.hasClass(name))) return false;
    return compound.not.every((negated) => !SelectorParser.matches(negated, target));
  }

  /** Comas de nivel superior (no las de adentro de un `:not(a, b)`). */
  private static splitList(selector: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < selector.length; i++) {
      const char = selector[i];
      if (char === "(" || char === "[") depth++;
      else if (char === ")" || char === "]") depth--;
      else if (char === "," && depth === 0) {
        parts.push(selector.slice(start, i));
        start = i + 1;
      }
    }
    parts.push(selector.slice(start));
    return parts;
  }

  private static parseOne(trimmed: string): ParsedSelector {
    const compound = SelectorParser.parseCompound(trimmed, trimmed);
    const [attribute] = compound.attributes;
    const [className] = compound.classes;
    let parsed: ParsedSelector;
    if (attribute) parsed = { registrationName: SelectorParser.toCamelCase(attribute.name), restrict: "A", compound };
    else if (className) parsed = { registrationName: SelectorParser.toCamelCase(className), restrict: "C", compound };
    else if (compound.tag) parsed = { registrationName: SelectorParser.toCamelCase(compound.tag), restrict: "E", compound };
    else throw new Error(`SelectorParser: "${trimmed}" no tiene tag, atributo ni clase por el que registrarse.`);
    if (compound.tag && parsed.restrict !== "E") parsed.requiredTag = compound.tag;
    return parsed;
  }

  /** `tag[a][b=c].d:not(...)` — sin combinadores (espacio, `>`, `+`, `~`): Angular tampoco los acepta. */
  private static parseCompound(text: string, whole: string): CompoundSelector {
    const fail = (): never => {
      throw new Error(`SelectorParser: "${whole}" no es un selector de Angular (tag, [atributo], [atributo=valor], .clase, :not(...)).`);
    };
    const compound: CompoundSelector = { attributes: [], classes: [], not: [] };
    let rest = text.trim();
    const tag = /^[A-Za-z][\w-]*/.exec(rest);
    if (tag) {
      compound.tag = tag[0];
      rest = rest.slice(tag[0].length);
    }
    while (rest.length) {
      const attribute = /^\[\s*([A-Za-z_$][\w$-]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]*))\s*)?\]/.exec(rest);
      if (attribute) {
        const value = attribute[2] ?? attribute[3] ?? attribute[4];
        compound.attributes.push({ name: attribute[1]!, ...(value !== undefined && { value }) });
        rest = rest.slice(attribute[0].length);
        continue;
      }
      const className = /^\.([A-Za-z_-][\w-]*)/.exec(rest);
      if (className) {
        compound.classes.push(className[1]!);
        rest = rest.slice(className[0].length);
        continue;
      }
      if (rest.startsWith(":not(")) {
        let depth = 0;
        let end = -1;
        for (let i = 4; i < rest.length; i++) {
          if (rest[i] === "(") depth++;
          else if (rest[i] === ")" && --depth === 0) {
            end = i;
            break;
          }
        }
        if (end === -1) fail();
        for (const negated of SelectorParser.splitList(rest.slice(5, end))) compound.not.push(SelectorParser.parseCompound(negated, whole));
        rest = rest.slice(end + 1);
        continue;
      }
      fail();
    }
    if (!compound.tag && !compound.attributes.length && !compound.classes.length && !compound.not.length) fail();
    return compound;
  }
}
