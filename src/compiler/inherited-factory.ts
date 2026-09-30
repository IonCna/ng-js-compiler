/**
 * Una clase sin `constructor` cuya cadena termina en una base que NO está en el escaneo (otro paquete compilado con
 * ngjs): sus dependencias no se conocen en build — son las del `ɵfac` de esa base. La versión de
 * `ɵɵgetInheritedFactory` de Ivy: en runtime se busca el `ɵfac` de la base (sube `hops` prototipos) y se le pide que
 * construya ESTA clase (`this.ɵT`, el `t` del factory de Ivy); sus deps van delante de las propias.
 *
 * Lo propio de la subclase (sus `inject()` de construcción, el guard de tag, el wiring de host) lo sigue armando su
 * factory, que recibe `ɵsuper` como primer argumento: construye la instancia con el factory de la base. Sin `ɵfac`
 * en la base (una clase JS común), `new Clase()`.
 */
export class InheritedFactory {
  static readonly NAME = "ɵinheritedFactory";

  /** `Clase.ɵfac = ɵinheritedFactory(Clase, hops, [deps propias..., function (ɵsuper, ...) { ... }]);` */
  static statement(className: string, hops: number, ownFactory: string): string {
    return `${className}.ɵfac = ${InheritedFactory.NAME}(${className}, ${hops}, ${ownFactory});`;
  }

  /** El target con el que construye un factory: el que le pidió `ɵinheritedFactory`, o la propia clase. */
  static target(className: string): string {
    return `((this && this.ɵT) || ${className})`;
  }

  /** El helper — texto plano a nivel de archivo (una declaración de función: se eleva). */
  static helperSource(): string {
    return `function ${InheritedFactory.NAME}(type, hops, own) {
  var base = type;
  for (var i = 0; i < hops; i++) base = Object.getPrototypeOf(base);
  var parent = base && base.ɵfac;
  var parentDeps = parent ? parent.slice(0, -1) : [];
  var parentFactory = parent && parent[parent.length - 1];
  var ownFactory = own[own.length - 1];
  return parentDeps.concat(own.slice(0, -1), [function () {
    var values = Array.prototype.slice.call(arguments);
    var target = (this && this.ɵT) || type;
    var ɵsuper = function () {
      if (!parentFactory) return new target();
      var instance = parentFactory.apply({ ɵT: target }, values.slice(0, parentDeps.length));
      if (!(instance instanceof target)) throw new Error("\\"" + target.name + "\\" hereda el constructor de \\"" + base.name + "\\", pero su ɵfac no sabe construir subclases: recompilá ese paquete con esta versión de ng-js-compiler.");
      return instance;
    };
    return ownFactory.apply(this, [ɵsuper].concat(values.slice(parentDeps.length)));
  }]);
}`;
  }
}
