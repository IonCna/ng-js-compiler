/** Cómo registró `ModuleWriter` un `@Component`: nombre de la directiva y selector CSS de sus elementos en el DOM. */
export interface HmrRegistration {
  name: string;
  query: string;
}

/** jqLite `data()` con el elemento tal como estaba antes de compilarse (atributos de inputs/outputs incluidos). */
export const HMR_SOURCE_KEY = "ɵngjsHmrSource";

const HMR_GLOBAL = "ɵngjsHmr";

/**
 * Prioridad máxima de las directivas que se vuelven a aplicar en el host al recompilarlo: las del componente (`0`),
 * `ngModel` (`1`), `ngClass`/`ngShow`/eventos (`0`)… pero no las estructurales (`ngRepeat` 1000, `ngIf` 600,
 * `ngInclude` 400, `ngInit` 450): esas siguen vivas en el padre y el host es una de sus copias.
 */
const RECOMPILE_MAX_PRIORITY = 100;

/**
 * Un host que es él mismo la copia de una directiva estructural (`<app-x ng-repeat>`): esa directiva guarda la
 * referencia al elemento para moverlo o sacarlo; reemplazarlo la deja apuntando a uno que ya no está.
 */
const STRUCTURAL_ATTRIBUTE = /^(?:data-|x-)?ng[:_-](?:repeat|repeat-start|if|switch-when|switch-default|include)$/i;

/**
 * Hot reload de los `@Component` del proyecto en `ngjs serve` — solo lo que compila ngjs: un componente legacy de
 * AngularJS, un servicio o un `@NgModule` recargan la página (ver `HmrBoundary`).
 *
 * Al cambiar el archivo de un componente (o su template/estilos: `ngjs serve` lo da por cambiado), Vite vuelve a
 * evaluar ese módulo y su `accept` llama a `update` con las clases viejas y las nuevas:
 * - Lo que AngularJS ya registró no se puede volver a registrar, pero el DDO de cada directiva vive en el injector
 *   (`<nombre>Directive`) y `controller`/`template` se leen ahí cada vez que se compila o se instancia: se cambian
 *   por los de la clase nueva y se saca el `templateUrl` de `$templateCache`.
 * - Cada instancia en pantalla se recompila desde su elemento original (lo guarda `sourceDirective` al compilarse,
 *   antes de que AngularJS le ponga el template o le saque los atributos de outputs) contra el mismo scope padre:
 *   se pierde el estado de ese componente, no el de la app.
 * - Cambió algo que AngularJS fijó al registrar (selector, inputs/outputs, `controllerAs`, transclusión) o el
 *   archivo exporta algo que no es un componente: recarga completa.
 */
export class HmrRuntime {
  static source(): string {
    return `(function () {
  if (globalThis.${HMR_GLOBAL}) return;
  var SOURCE = ${JSON.stringify(HMR_SOURCE_KEY)};
  var STRUCTURAL = ${STRUCTURAL_ATTRIBUTE.toString()};
  function structural(element) {
    return Array.prototype.some.call(element.attributes, function (attribute) { return STRUCTURAL.test(attribute.name); });
  }
  /**
   * Qué recompilar para que una instancia quede al día: ella misma, salvo que entre ella y quien compiló su template
   * haya una directiva estructural (\`ng-repeat\`/\`ng-if\`/… en el propio host o en un ancestro). Esa directiva guarda el
   * template ya compilado para sus copias siguientes — las filas nuevas saldrían con el template viejo y la clase
   * nueva —, así que se sube al primer \`@Component\` del proyecto por encima: recompilarlo la rehace. Sin uno,
   * \`null\` (recarga).
   */
  function target(element) {
    var crossed = structural(element);
    for (var node = element.parentNode; node && node.nodeType === 1; node = node.parentNode) {
      if (crossed && angular.element(node).data(SOURCE)) return target(node);
      if (structural(node)) crossed = true;
    }
    return crossed || !angular.element(element).data(SOURCE) ? null : element;
  }
  function reload(reason) {
    console.info("[ngjs] recarga completa: " + reason);
    location.reload();
  }
  function shape(type) {
    var cmp = type && type.ɵcmp;
    if (!cmp) return undefined;
    var definition = {};
    Object.keys(cmp.definition || {}).forEach(function (key) { if (key !== "template") definition[key] = cmp.definition[key]; });
    return JSON.stringify([cmp.selectors, cmp.inputs, cmp.outputs, definition]);
  }
  // El host y su contenido sin compilar: la copia que hizo \`sourceDirective\`.
  function rerender(element, injector) {
    var host = angular.element(element);
    var source = host.data(SOURCE);
    var parentScope = host.scope();
    var parent = element.parentNode;
    var isolateScope = host.isolateScope();
    var copy = source.cloneNode(true);
    parent.insertBefore(copy, element);
    host.remove();
    if (isolateScope) isolateScope.$destroy();
    injector.get("$compile")(copy, undefined, ${RECOMPILE_MAX_PRIORITY})(parentScope);
  }
  globalThis.${HMR_GLOBAL} = {
    /** Directiva extra (prioridad 1, antes que el componente) por cada registro de un \`@Component\`. */
    sourceDirective: function (restrict) {
      return function () {
        return {
          restrict: restrict,
          priority: 1,
          compile: function (tElement) {
            var source = tElement[0].cloneNode(true);
            return { pre: function (scope, element) { element.data(SOURCE, source); } };
          },
        };
      };
    },
    /**
     * \`previous\`: las clases que exportaba el módulo; \`next\`: el módulo evaluado otra vez; \`registrations\`: por clase,
     * cómo la registró \`ModuleWriter\` (\`name\` de la directiva y \`query\` CSS de sus elementos).
     */
    update: function (previous, next, registrations) {
      try {
        if (!next) return reload("el módulo nuevo no se pudo evaluar");
        var injector = globalThis.ɵngjsInjector;
        if (!injector) return reload("la app todavía no arrancó");
        var names = Object.keys(previous);
        var exported = Object.keys(next);
        if (exported.length !== names.length || exported.some(function (name) { return names.indexOf(name) === -1; })) {
          return reload("cambiaron los exports del archivo");
        }

        var swaps = [];
        for (var i = 0; i < names.length; i++) {
          var oldType = previous[names[i]];
          var newType = next[names[i]];
          if (!newType || !newType.ɵfac || shape(oldType) === undefined || shape(oldType) !== shape(newType)) {
            return reload(names[i] + " cambió su selector, inputs/outputs o definición");
          }
          if (newType.ɵcmp.definition && newType.ɵcmp.definition.transclude) return reload(names[i] + " proyecta contenido (<ng-content>)");
          var ddos = [];
          (registrations[names[i]] || []).forEach(function (registration) {
            if (!injector.has(registration.name + "Directive")) return;
            injector.get(registration.name + "Directive").forEach(function (ddo) { if (ddo.controller === oldType.ɵfac) ddos.push(ddo); });
          });
          if (!ddos.length) return reload(names[i] + " no está registrado en ningún @NgModule cargado");
          swaps.push({ oldType: oldType, newType: newType, ddos: ddos, registrations: registrations[names[i]] });
        }

        // Qué recompilar por cada instancia en pantalla (ver \`target\`); solo los de más afuera (uno anidado en otro se
        // recrea con él).
        var hosts = [];
        for (var s = 0; s < swaps.length; s++) {
          for (var r = 0; r < swaps[s].registrations.length; r++) {
            var found = document.querySelectorAll(swaps[s].registrations[r].query);
            for (var e = 0; e < found.length; e++) {
              if (!angular.element(found[e]).isolateScope()) continue;
              var host = target(found[e]);
              if (!host) return reload("una instancia en pantalla depende de un ng-repeat/ng-if/ng-switch sin un @Component del proyecto que lo contenga");
              if (hosts.indexOf(host) === -1) hosts.push(host);
            }
          }
        }
        hosts = hosts.filter(function (element) { return !hosts.some(function (other) { return other !== element && other.contains(element); }); });
        if (hosts.some(function (element) { return !angular.element(element).scope(); })) {
          return reload("una instancia en pantalla no se puede recompilar");
        }

        var $templateCache = injector.get("$templateCache");
        swaps.forEach(function (swap) {
          var definition = swap.newType.ɵcmp.definition || {};
          swap.ddos.forEach(function (ddo) {
            ddo.controller = swap.newType.ɵfac;
            if (definition.template !== undefined) ddo.template = definition.template;
          });
          if (definition.templateUrl) $templateCache.remove(definition.templateUrl);
        });
        hosts.forEach(function (element) { rerender(element, injector); });

        var $rootScope = injector.get("$rootScope");
        if (!$rootScope.$$phase) $rootScope.$apply();
        console.info("[ngjs] hot update: " + names.join(", "));
      } catch (error) {
        console.error(error);
        reload("falló el hot update");
      }
    },
  };
})();`;
  }

  /** La directiva extra que \`ModuleWriter\` encadena (en \`ngjs serve\`) junto a cada registro de un \`@Component\`. */
  static sourceDirectiveCall(registrationName: string, restrict: string): string {
    return `.directive(${JSON.stringify(registrationName)}, globalThis.${HMR_GLOBAL}.sourceDirective(${JSON.stringify(restrict)}))`;
  }

  /** El `accept` que se agrega al final del archivo de un componente; `registrations`, por nombre de la clase exportada. */
  static acceptCode(registrations: Record<string, HmrRegistration[]>): string {
    const previous = `{ ${Object.keys(registrations).map((name) => `${JSON.stringify(name)}: ${name}`).join(", ")} }`;
    return `
if (import.meta.hot) {
  import.meta.hot.accept(function (next) { globalThis.${HMR_GLOBAL}.update(${previous}, next, ${JSON.stringify(registrations)}); });
}
`;
  }

  /** Vite: `<script>` clásico al principio del `<head>`, como la plataforma — antes que cualquier `@NgModule`. */
  static htmlTag(): { tag: "script"; children: string; injectTo: "head-prepend" } {
    return { tag: "script", children: HmrRuntime.source(), injectTo: "head-prepend" };
  }
}
