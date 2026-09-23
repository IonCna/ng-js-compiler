/**
 * Dónde leen su valor los `inject()` reemplazados en build: `globalThis.ɵngjsInjected[clave][i]`, puesto por el
 * factory SOLO mientras construye (se guarda y se restaura el anterior — una construcción anidada no pisa a la de
 * afuera). La clave es la clase dueña del `inject()` (su nombre, único en el proyecto): así en una subclase los
 * campos de la base leen lo suyo y los de la subclase lo suyo, aunque vivan en archivos distintos (una variable por
 * archivo no alcanzaría). Los factories (`useFactory`, `InjectionToken`) usan la clave `FACTORY`.
 */
export class InjectedValues {
  static readonly FACTORY = "ɵfactory";
  private static readonly GLOBAL = "globalThis.ɵngjsInjected";

  /** El texto que reemplaza al `inject()` número `index` de `owner`. */
  static ref(owner: string, index: number): string {
    return `${InjectedValues.GLOBAL}[${JSON.stringify(owner)}][${index}]`;
  }

  /** `statement` corriendo con `values` (`{ dueño: [valores...] }`) expuestos; se restaura lo anterior al terminar. */
  static around(values: Record<string, string[]>, statement: string): string {
    const object = Object.entries(values)
      .map(([owner, list]) => `${JSON.stringify(owner)}: [${list.join(", ")}]`)
      .join(", ");
    return `var ɵprevious = ${InjectedValues.GLOBAL}; ${InjectedValues.GLOBAL} = { ${object} }; try { ${statement} } finally { ${InjectedValues.GLOBAL} = ɵprevious; }`;
  }
}
