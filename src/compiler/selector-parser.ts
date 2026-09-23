/**
 * Traduce un selector CSS simple (`@Component`/`@Directive`) a los nombres de
 * registro de AngularJS. Cubre lo que hoy generan los schematics: un tag
 * simple (`app-card`), un atributo simple (`[appHighlight]`), el compuesto
 * `tag[atributo]` (`button[ngbNavLink]`) — se registra bajo el atributo
 * (AngularJS no sabe matchear por tag+atributo a la vez), `requiredTag` queda
 * como dato para que `DecoratorWriter` arme el guard en runtime (ver ahí) — y
 * listas separadas por coma (`"button[ngbNavLink], a[ngbNavLink]"`), una
 * alternativa simple o compuesta por elemento de la lista. Con valor
 * (`tag[attr=value]`) o pseudo-clases (`:not(...)`) siguen sin soporte.
 */
export interface ParsedSelector {
  /** Nombre con que AngularJS registra la directiva (`.component()`/`.directive()`), en camelCase. */
  registrationName: string;
  /** `'A'` si dispara por atributo, `'E'` si dispara por tag. */
  restrict: "A" | "E";
  /** Solo en `tag[atributo]`: el tag que el selector exige — AngularJS no lo puede filtrar solo. */
  requiredTag?: string;
}

export class SelectorParser {
  static toCamelCase(value: string): string {
    return value.replace(/-([a-z0-9])/g, (_match, char: string) => char.toUpperCase());
  }

  /** Una entrada por alternativa — un selector sin coma da un array de un solo elemento. */
  static parse(selector: string): ParsedSelector[] {
    return selector.split(",").map((part) => SelectorParser.parseOne(part.trim()));
  }

  private static parseOne(trimmed: string): ParsedSelector {
    const tagMatch = trimmed.match(/^[A-Za-z][\w-]*$/);
    if (tagMatch) {
      return { registrationName: SelectorParser.toCamelCase(trimmed), restrict: "E" };
    }

    const attributeMatch = trimmed.match(/^([A-Za-z][\w-]*)?\[([A-Za-z_$][\w$-]*)\]$/);
    if (attributeMatch) {
      const [, tag, attr] = attributeMatch;
      return { registrationName: SelectorParser.toCamelCase(attr!), restrict: "A", requiredTag: tag };
    }

    throw new Error(`SelectorParser: "${trimmed}" no es un selector simple (tag, [atributo] o tag[atributo]) — no soportado todavía.`);
  }
}
