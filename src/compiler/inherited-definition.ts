/**
 * Un `@Component`/`@Directive` cuya cadena termina en una base que NO está en el escaneo (otro paquete compilado con
 * ngjs): sus `inputs`/`outputs`/queries/`hostDirectives` no se conocen en build — son los de la definición que esa
 * base trae estampada. La versión de `ɵɵInheritDefinitionFeature` de Ivy: al evaluarse el archivo, la definición de
 * la clase (`ɵcmp`/`ɵdir`) suma la de su base (lo propio pisa), también los `bindings` de AngularJS de
 * `definition` — de ahí los lee la registración (`ModuleWriter.bindingsExpr`), que corre después (el `@NgModule`
 * importa la clase por referencia).
 */
export class InheritedDefinition {
  static readonly NAME = "ɵinheritDefinition";

  /** `ɵinheritDefinition(Clase, hops, "ɵcmp");` — después de estampar la definición propia. */
  static statement(className: string, hops: number, field: "ɵcmp" | "ɵdir"): string {
    return `${InheritedDefinition.NAME}(${className}, ${hops}, ${JSON.stringify(field)});`;
  }

  /** Los bindings de AngularJS de la clase, ya sumados con los de su base (para `bindings`/`bindToController`). */
  static bindingsExpr(className: string, field: "ɵcmp" | "ɵdir"): string {
    return `(${className}.${field}.definition && ${className}.${field}.definition.bindings) || {}`;
  }

  /** El helper — texto plano a nivel de archivo (una declaración de función: se eleva). */
  static helperSource(): string {
    return `function ${InheritedDefinition.NAME}(type, hops, field) {
  var own = Object.prototype.hasOwnProperty;
  var def = type[field];
  var parent = null;
  var base = type;
  for (var i = 0; i < hops; i++) base = Object.getPrototypeOf(base);
  for (; base && base !== Function.prototype && !parent; base = Object.getPrototypeOf(base)) {
    parent = own.call(base, "ɵcmp") ? base.ɵcmp : own.call(base, "ɵdir") ? base.ɵdir : null;
  }
  if (!parent || !def) return;
  def.inputs = Object.assign({}, parent.inputs, def.inputs);
  def.outputs = Object.assign({}, parent.outputs, def.outputs);
  ["queries", "viewQueries"].forEach(function (key) {
    var mine = def[key] || [];
    var names = mine.map(function (query) { return query.propertyName; });
    var merged = (parent[key] || []).filter(function (query) { return names.indexOf(query.propertyName) === -1; }).concat(mine);
    if (merged.length) def[key] = merged;
  });
  if (parent.hostDirectives && parent.hostDirectives.length) def.hostDirectives = parent.hostDirectives.concat(def.hostDirectives || []);
  var inherited = parent.definition && (parent.definition.bindings || parent.definition.bindToController);
  if (inherited && typeof inherited === "object") {
    def.definition = def.definition || {};
    def.definition.bindings = Object.assign({}, inherited, def.definition.bindings);
  }
}`;
  }
}
