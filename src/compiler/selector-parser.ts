/**
 * Traduce un selector CSS simple (`@Component`/`@Directive`) al nombre de
 * registro de AngularJS. Cubre lo que hoy generan los schematics: un tag
 * simple (`app-card`) o un atributo simple (`[appHighlight]`). Selectores
 * compuestos (`button[ngbNavLink]`) o con pseudo-clases (`:not(...)`) no
 * están soportados todavía — quedan afuera de este alcance (a dónde se
 * registra), son refinamiento de `compile`/`link`, no de esto.
 */
export interface ParsedSelector {
  /** Nombre con que AngularJS registra la directiva (`.component()`/`.directive()`), en camelCase. */
  registrationName: string;
  /** `'A'` si dispara por atributo, `'E'` si dispara por tag. */
  restrict: "A" | "E";
}

export class SelectorParser {
  static toCamelCase(value: string): string {
    return value.replace(/-([a-z0-9])/g, (_match, char: string) => char.toUpperCase());
  }

  static parse(selector: string): ParsedSelector {
    const trimmed = selector.trim();

    const attributeMatch = trimmed.match(/^\[([A-Za-z_$][\w$-]*)\]$/);
    if (attributeMatch) {
      return { registrationName: SelectorParser.toCamelCase(attributeMatch[1]!), restrict: "A" };
    }

    const tagMatch = trimmed.match(/^[A-Za-z][\w-]*$/);
    if (tagMatch) {
      return { registrationName: SelectorParser.toCamelCase(trimmed), restrict: "E" };
    }

    throw new Error(`SelectorParser: "${selector}" no es un selector simple (tag o [atributo]) — no soportado todavía.`);
  }
}
