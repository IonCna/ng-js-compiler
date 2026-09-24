import { HOST_DATA_KEY } from "@/compiler/element-instances.ts";
import { ResolveDependency } from "@/compiler/resolve-dependency.ts";

/**
 * Injector jerárquico por elemento, emulado sobre `$controller`/jqLite — la versión "sin runtime propio"
 * de `ElementInjectorNode`/`scoped-injector-bridge.ts` de `ngjs-core` (ver CONCEPTOS "Inyector jerárquico"
 * ahí). No se importa nada de `ngjs-core`: `ModuleWriter` estampa este texto, plano, una sola vez por app,
 * en el mismo archivo del `@NgModule` raíz (el que tiene `bootstrap`) — antes de la cadena
 * `ɵangular.module(...)` de ese archivo, así el `.decorator("$controller", ...)` que arma esa cadena ya
 * encuentra `ɵscopedController` definido.
 *
 * También lo estampa cada `@NgModule` que declara un `@Component`/`@Directive` con `providers` (una librería
 * compilada aparte no sabe si la app va a tenerlo); se instala una sola vez por app (ver `ɵscopedController`).
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

    return `function ɵElementInjectorNode(providers, parent, $injector, element, boundary) {
  this.parent = parent;
  this.$injector = $injector;
  // El elemento donde está anclado y el límite de \`@Host\` de quien lo creó.
  this.element = element;
  this.boundary = boundary;
  this.singles = {};
  this.multis = {};
  this.cache = {};
  for (var i = 0; i < providers.length; i++) {
    var p = providers[i];
    if (p.multi) { (this.multis[p.token] = this.multis[p.token] || []).push(p); }
    else { this.singles[p.token] = p; }
  }
}
var ɵNOT_FOUND = {};
ɵElementInjectorNode.prototype.resolve = function (name) {
  if (name === ${JSON.stringify(ResolveDependency.TOKEN)}) return this.resolverFor(this.boundary);
  return this.resolveWith(name, {});
};
/** \`ɵresolve\` para quien pide desde un elemento cuyo límite de \`@Host\` es \`boundary\`. */
ɵElementInjectorNode.prototype.resolverFor = function (boundary) {
  var self = this;
  return function (token, flags) {
    flags = flags || {};
    return flags.host ? self.resolveHost(token, flags, boundary) : self.resolveWith(token, flags);
  };
};
// Misma semántica que \`ElementInjectorNode.resolve\` de ngjs-core: \`self\` = solo este nodo; \`skipSelf\` = arranca
// en el padre; al subir solo sigue valiendo \`optional\`.
ɵElementInjectorNode.prototype.resolveWith = function (name, flags) {
  if (flags.host) return this.resolveHost(name, flags, this.boundary);
  if (!flags.skipSelf) {
    var own = this.resolveOwn(name);
    if (own !== ɵNOT_FOUND) return own;
    if (flags.self) {
      if (flags.optional) return null;
      throw new Error("ɵElementInjectorNode: no hay provider para \\"" + name + "\\" con { self: true }.");
    }
  }
  if (this.parent) return this.parent.resolveWith(name, { optional: flags.optional });
  if (!flags.optional) return this.$injector.get(name);
  return this.$injector.has(name) ? this.$injector.get(name) : null;
};
// \`@Host\` como Angular (no como ngjs-core, que corta en el nodo propio y cae a la app): sube por los nodos mientras
// su elemento esté dentro del host (\`boundary\`, el elemento del componente dueño de la vista) y NO consulta la app.
ɵElementInjectorNode.prototype.resolveHost = function (name, flags, boundary) {
  var within = function (node) { return !boundary || !node.element || node.element === boundary || boundary.contains(node.element); };
  for (var node = flags.skipSelf ? this.parent : this; node && within(node); node = node.parent) {
    var own = node.resolveOwn(name);
    if (own !== ɵNOT_FOUND) return own;
  }
  if (flags.optional) return null;
  throw new Error("ɵElementInjectorNode: no hay provider para \\"" + name + "\\" con { host: true } (entre este elemento y su host).");
};
/** Algún nodo de la cadena (este o un ancestro) provee \`name\`. */
ɵElementInjectorNode.prototype.provides = function (name) {
  for (var node = this; node; node = node.parent) {
    if (Object.prototype.hasOwnProperty.call(node.singles, name) || Object.prototype.hasOwnProperty.call(node.multis, name)) return true;
  }
  return false;
};
ɵElementInjectorNode.prototype.resolveOwn = function (name) {
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
  return ɵNOT_FOUND;
};
ɵElementInjectorNode.prototype.instantiate = function (descriptor) {
  var self = this;
  var resolve = function (name) { return self.resolve(name); };
  if (descriptor.kind === "useValue") return descriptor.value;
  if (descriptor.kind === "useFactory") return descriptor.factory.apply(null, descriptor.deps.map(resolve));
  if (descriptor.kind === "useExisting") return resolve(descriptor.existing);
  if (descriptor.deps) return new (Function.prototype.bind.apply(descriptor.ctor, [null].concat(descriptor.deps.map(resolve))))();
  // Solo lo PROPIO de la clase: un \`ɵfac\` heredado construiría a la base (subclase provista sin \`@Injectable()\`).
  var ctor = descriptor.ctor;
  var own = Object.prototype.hasOwnProperty;
  var fac = (descriptor.kind === "class" && own.call(ctor, "ɵprov") && ctor.ɵprov.factory) || (own.call(ctor, "ɵfac") ? ctor.ɵfac : null);
  if (!fac && ctor.ɵfac) throw new Error("\\"" + ctor.name + "\\" hereda el factory de su clase padre — agregale @Injectable() (Angular también lo exige).");
  if (!fac) return new ctor();
  return fac[fac.length - 1].apply(null, fac.slice(0, -1).map(resolve));
};
// Como Angular al destruir el elemento: \`ngOnDestroy\` de cada instancia que creó este nodo (propias, no heredadas).
ɵElementInjectorNode.prototype.destroy = function () {
  var cache = this.cache;
  this.cache = {};
  for (var name in cache) {
    var values = Object.prototype.hasOwnProperty.call(this.multis, name) ? cache[name] : [cache[name]];
    for (var i = 0; i < values.length; i++) {
      var value = values[i];
      if (value && typeof value.ngOnDestroy === "function" && !this.isAlias(name)) value.ngOnDestroy();
    }
  }
};
/** \`useExisting\`/\`useValue\`: la instancia no es de este nodo (es otra, o un valor ajeno) — no se destruye acá. */
ɵElementInjectorNode.prototype.isAlias = function (name) {
  var single = this.singles[name];
  return Boolean(single && (single.kind === "useExisting" || single.kind === "useValue"));
};

function ɵscopedController($delegate, $injector) {
  // Una sola vez por app: cada \`@NgModule\` que declara elementos con \`providers\` trae este decorador (así una
  // librería compilada aparte funciona sola) — el primero que corre se instala y los demás devuelven \`$delegate\`.
  // La marca va en el \`$injector\` (uno por app), no en \`$delegate\`: entre dos de estos puede haber otros
  // decoradores de \`$controller\` que la taparían, y dos capas crearían dos nodos (dos instancias) por elemento.
  if ($injector.ɵngjsScopedController) return $delegate;
  $injector.ɵngjsScopedController = true;
  return function (expression, locals, later, ident) {
    var $element = locals && locals.$element;
    if (!$element) return $delegate(expression, locals, later, ident);

    // Límite de \`@Host\`: un componente es su propio host (su \`ɵfac\` marca el elemento para lo de adentro); una
    // directiva mira el componente ancestro más cercano — el dueño de la vista donde está.
    var isComponent = Boolean(expression && expression.ɵcomponent);
    var boundary = isComponent ? $element[0] : ($element.parent ? $element.parent().inheritedData(${JSON.stringify(HOST_DATA_KEY)}) : undefined);

    var ownProviders = expression && expression.ɵproviders;
    var node = $element.inheritedData(${key});
    if (ownProviders && ownProviders.length) {
      node = new ɵElementInjectorNode(ownProviders, node, $injector, $element[0], boundary);
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
      // Lo que ningún nodo provee sigue su camino normal (\`$controller\` de adentro: otros decoradores que agregan
      // \`locals\` por instancia, y después el \`$injector\`) — resolverlo acá contra el \`$injector\` lo taparía.
      if (name !== ${JSON.stringify(ResolveDependency.TOKEN)} && !node.provides(name)) continue;
      extra = extra || {};
      // \`ɵresolve\` con el límite de \`@Host\` de ESTE elemento (el nodo puede ser heredado de un ancestro).
      extra[name] = name === ${JSON.stringify(ResolveDependency.TOKEN)} ? node.resolverFor(boundary) : node.resolve(name);
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
