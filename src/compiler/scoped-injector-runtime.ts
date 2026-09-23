/**
 * Injector jerárquico por elemento, emulado sobre `$controller`/jqLite — la versión "sin runtime propio"
 * de `ElementInjectorNode`/`scoped-injector-bridge.ts` de `ngjs-core` (ver CONCEPTOS "Inyector jerárquico"
 * ahí). No se importa nada de `ngjs-core`: `ModuleWriter` estampa este texto, plano, una sola vez por app,
 * en el mismo archivo del `@NgModule` raíz (el que tiene `bootstrap`) — antes de la cadena
 * `ɵangular.module(...)` de ese archivo, así el `.decorator("$controller", ...)` que arma esa cadena ya
 * encuentra `ɵscopedController` definido.
 *
 * Diferencia clave con `ngjs-core`: ahí hace falta un `SelectorRegistry` por tagName porque `.component()`
 * invoca `$controller` con una `expression` genérica interna, no la clase. Acá no hace falta nada de eso:
 * `ModuleWriter` siempre pasa `controller: X.ɵfac` (el array de DI ya armado por `DecoratorWriter`), así que
 * `ɵproviders` se cuelga directo de esa MISMA referencia (`X.ɵfac.ɵproviders`, ver `ScopedProviders`) y
 * `expression` en la intercepción YA ES ese array — se lee tal cual, sin buscar nada por tagName.
 */
export class ScopedInjectorRuntime {
  private static readonly DATA_KEY = "$ngjsScopedInjector";

  /**
   * Texto plano (declaraciones de función/prototype a nivel de módulo, sin IIFE ni `globalThis`): al
   * evaluarse el archivo una sola vez (como cualquier import de ES module) quedan `ɵElementInjectorNode`/
   * `ɵscopedController` en el scope del archivo, listos para que la cadena del módulo los use.
   */
  static source(): string {
    const key = JSON.stringify(ScopedInjectorRuntime.DATA_KEY);

    return `function ɵElementInjectorNode(providers, parent, $injector) {
  this.parent = parent;
  this.$injector = $injector;
  this.singles = {};
  this.multis = {};
  this.cache = {};
  for (var i = 0; i < providers.length; i++) {
    var p = providers[i];
    if (p.multi) { (this.multis[p.token] = this.multis[p.token] || []).push(p); }
    else { this.singles[p.token] = p; }
  }
}
ɵElementInjectorNode.prototype.resolve = function (name) {
  if (Object.prototype.hasOwnProperty.call(this.cache, name)) return this.cache[name];
  if (Object.prototype.hasOwnProperty.call(this.multis, name)) {
    var resolved = this.multis[name].map(this.instantiate, this);
    this.cache[name] = resolved;
    return resolved;
  }
  if (Object.prototype.hasOwnProperty.call(this.singles, name)) {
    var resolved = this.instantiate(this.singles[name]);
    this.cache[name] = resolved;
    return resolved;
  }
  if (this.parent) return this.parent.resolve(name);
  return this.$injector.get(name);
};
ɵElementInjectorNode.prototype.instantiate = function (descriptor) {
  var self = this;
  var resolve = function (name) { return self.resolve(name); };
  if (descriptor.kind === "useValue") return descriptor.value;
  if (descriptor.kind === "useFactory") return descriptor.factory.apply(null, descriptor.deps.map(resolve));
  if (descriptor.kind === "useExisting") return resolve(descriptor.existing);
  if (descriptor.deps) return new (Function.prototype.bind.apply(descriptor.ctor, [null].concat(descriptor.deps.map(resolve))))();
  var fac = descriptor.ctor.ɵfac;
  if (!fac) return new descriptor.ctor();
  return fac[fac.length - 1].apply(null, fac.slice(0, -1).map(resolve));
};
ɵElementInjectorNode.prototype.destroy = function () { this.cache = {}; };

function ɵscopedController($delegate, $injector) {
  return function (expression, locals, later, ident) {
    var $element = locals && locals.$element;
    if (!$element) return $delegate(expression, locals, later, ident);

    var ownProviders = expression && expression.ɵproviders;
    var node = $element.inheritedData(${key});
    if (ownProviders && ownProviders.length) {
      node = new ɵElementInjectorNode(ownProviders, node, $injector);
      $element.data(${key}, node);
      var $scope = locals.$scope;
      if ($scope && $scope.$on) {
        (function (ownNode) { $scope.$on("$destroy", function () { ownNode.destroy(); }); })(node);
      }
    }
    if (!node) return $delegate(expression, locals, later, ident);

    var depNames = Array.isArray(expression) ? expression.slice(0, -1) : (expression && expression.$inject) || [];
    var extra;
    for (var i = 0; i < depNames.length; i++) {
      var name = depNames[i];
      if (locals && Object.prototype.hasOwnProperty.call(locals, name)) continue;
      extra = extra || {};
      extra[name] = node.resolve(name);
    }
    if (!extra) return $delegate(expression, locals, later, ident);

    var merged = {};
    for (var k in locals) merged[k] = locals[k];
    for (var k2 in extra) merged[k2] = extra[k2];
    return $delegate(expression, merged, later, ident);
  };
}`;
  }

  /** Fragmento para agregar a la cadena `ɵangular.module(...)` del módulo raíz — decora `$controller` una vez para toda la app. */
  static decoratorFragment(): string {
    return '.decorator("$controller", ["$delegate", "$injector", ɵscopedController])';
  }
}
