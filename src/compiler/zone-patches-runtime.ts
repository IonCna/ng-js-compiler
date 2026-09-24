/**
 * Ni una clase `NgZone` ni Zone.js real acá — solo parchea los globales para que cualquier trabajo async
 * termine disparando un digest solo, sin que el dev tenga que llamar `$apply`/`$digest` a mano. Mismo
 * espíritu que "Zone.js dispara `$digest`. No hay OnPush, ni CD por componente, ni scheduler propio", pero
 * logrado con monkey-patches puntuales en vez de la maquinaria completa de Zone.js. Se estampa una sola
 * vez, junto a `PlatformCode` (mismo gate: `projectType: "application"`).
 *
 * Necesita `globalThis.ɵngjsRootScope` — lo deja `PlatformCode.bootstrapModule()` cuando el bootstrap real
 * corrió (antes de eso no hay nada que hacer $apply, y el patch es un no-op seguro).
 *
 * Los tres puntos de entrada async que importan de verdad:
 * - `setTimeout`/`setInterval` nativos.
 * - `addEventListener` nativo (con `removeEventListener` parcheado en pareja — sin esto, sacar un listener
 *   agregado con `addEventListener` en `ngOnInit` dejaría de andar, porque compararía por identidad de
 *   función contra el wrapper, no el original — un patrón MUY común, `WeakMap` guarda la relación).
 * - `Promise.prototype.then` — cubre cadenas `.then()` explícitas, PERO NO `async/await` de verdad: se
 *   probó en el motor real (Node/V8 actual) y el patch de `.then` da CERO intercepciones en `await`
 *   (optimización interna de V8, no hay vuelta). Por eso el compilador baja SIEMPRE `async/await` a
 *   generadores (`decoratorMetadataTransform`, con SWC) y `pluginLoader` hace lo mismo con las dependencias
 *   (`supported` de esbuild, `AsyncDownlevel`) — el helper reanuda con `.then()`, así el patch los agarra igual,
 *   indirectamente, sin bajar el resto de la sintaxis (como Angular CLI con Zone.js).
 *
 * `NgZone.runOutsideAngular` (de `ngjs-core`) marca `globalThis.ɵngjsOutsideAngular` mientras corre: lo programado ahí
 * no dispara digest (se decide al programar, como la zona de Angular).
 *
 * Fuera de alcance a propósito (no es Zone.js completo): fetch/XHR nativos, MutationObserver,
 * requestAnimationFrame, WebSocket.
 */
export class ZonePatchesRuntime {
  static source(): string {
    return `(function () {
  if (globalThis.ɵngjsZonePatched) return;
  globalThis.ɵngjsZonePatched = true;

  function ɵsafeApply() {
    var scope = globalThis.ɵngjsRootScope;
    // Un \`$rootScope\` destruido (app destruida) queda con \`$root = null\`: un timer pendiente ya no tiene a quién aplicarle.
    if (!scope || !scope.$root || scope.$root.$$phase) return;
    scope.$apply();
  }

  // \`NgZone.runOutsideAngular(fn)\` sube \`globalThis.ɵngjsOutsideAngular\` mientras corre \`fn\`: lo que se programe ahí
  // (timer, listener, \`.then\`) no dispara digest al correr — se decide al PROGRAMARLO, como la zona de Angular.
  function ɵinside() {
    return !(globalThis.ɵngjsOutsideAngular > 0);
  }

  var ɵsetTimeout = window.setTimeout;
  window.setTimeout = function (fn, delay) {
    if (typeof fn !== "function") return ɵsetTimeout.apply(window, arguments);
    var extra = Array.prototype.slice.call(arguments, 2);
    var inside = ɵinside();
    return ɵsetTimeout.call(window, function () { fn.apply(null, extra); if (inside) ɵsafeApply(); }, delay);
  };

  var ɵsetInterval = window.setInterval;
  window.setInterval = function (fn, delay) {
    if (typeof fn !== "function") return ɵsetInterval.apply(window, arguments);
    var extra = Array.prototype.slice.call(arguments, 2);
    var inside = ɵinside();
    return ɵsetInterval.call(window, function () { fn.apply(null, extra); if (inside) ɵsafeApply(); }, delay);
  };

  var ɵthen = Promise.prototype.then;
  Promise.prototype.then = function (onFulfilled, onRejected) {
    var inside = ɵinside();
    var wrap = function (fn) {
      return typeof fn === "function" ? function (value) { var result = fn(value); if (inside) ɵsafeApply(); return result; } : fn;
    };
    return ɵthen.call(this, wrap(onFulfilled), wrap(onRejected));
  };

  // listener original -> [{ target, type, capture, wrapped }] — así \`removeEventListener\` encuentra el wrapper
  // real que quedó registrado EN ESE target (no el original, que nunca se le pasó al \`addEventListener\` nativo;
  // ni el de otro elemento que comparte el mismo handler).
  var ɵwrappers = new WeakMap();
  var ɵaddEventListener = EventTarget.prototype.addEventListener;
  var ɵremoveEventListener = EventTarget.prototype.removeEventListener;

  function ɵfindWrapper(entries, target, type, capture) {
    if (!entries) return -1;
    for (var i = 0; i < entries.length; i++) {
      if (entries[i].target === target && entries[i].type === type && entries[i].capture === capture) return i;
    }
    return -1;
  }

  EventTarget.prototype.addEventListener = function (type, listener, options) {
    if (typeof listener !== "function") return ɵaddEventListener.call(this, type, listener, options);
    var capture = typeof options === "boolean" ? options : !!(options && options.capture);
    var entries = ɵwrappers.get(listener);
    // Como el nativo: el mismo listener dos veces en el mismo target/tipo/fase se registra una sola vez.
    if (ɵfindWrapper(entries, this, type, capture) !== -1) return;
    var inside = ɵinside();
    var wrapped = function (event) { var result = listener.call(this, event); if (inside) ɵsafeApply(); return result; };
    if (!entries) { entries = []; ɵwrappers.set(listener, entries); }
    entries.push({ target: this, type: type, capture: capture, wrapped: wrapped });
    return ɵaddEventListener.call(this, type, wrapped, options);
  };

  EventTarget.prototype.removeEventListener = function (type, listener, options) {
    if (typeof listener !== "function") return ɵremoveEventListener.call(this, type, listener, options);
    var capture = typeof options === "boolean" ? options : !!(options && options.capture);
    var entries = ɵwrappers.get(listener);
    var index = ɵfindWrapper(entries, this, type, capture);
    var registered = listener;
    if (index !== -1) {
      registered = entries[index].wrapped;
      entries.splice(index, 1);
    }
    return ɵremoveEventListener.call(this, type, registered, options);
  };
})();`;
  }
}
