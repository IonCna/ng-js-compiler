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
 *   (optimización interna de V8, no hay vuelta). Por eso el build fuerza `target: "es2016"` en esbuild
 *   (ver `plugin-loader.ts`) y en Vite (`viteTransformPlugin`) — a ese target, `async/await` del proyecto
 *   se compila a un helper basado en generadores que SÍ llama `.then()` por debajo (confirmado con esbuild
 *   real), así el patch los agarra igual, indirectamente.
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
    if (!scope || scope.$root.$$phase) return;
    scope.$apply();
  }

  var ɵsetTimeout = window.setTimeout;
  window.setTimeout = function (fn, delay) {
    if (typeof fn !== "function") return ɵsetTimeout.apply(window, arguments);
    var extra = Array.prototype.slice.call(arguments, 2);
    return ɵsetTimeout.call(window, function () { fn.apply(null, extra); ɵsafeApply(); }, delay);
  };

  var ɵsetInterval = window.setInterval;
  window.setInterval = function (fn, delay) {
    if (typeof fn !== "function") return ɵsetInterval.apply(window, arguments);
    var extra = Array.prototype.slice.call(arguments, 2);
    return ɵsetInterval.call(window, function () { fn.apply(null, extra); ɵsafeApply(); }, delay);
  };

  var ɵthen = Promise.prototype.then;
  Promise.prototype.then = function (onFulfilled, onRejected) {
    var wrap = function (fn) {
      return typeof fn === "function" ? function (value) { var result = fn(value); ɵsafeApply(); return result; } : fn;
    };
    return ɵthen.call(this, wrap(onFulfilled), wrap(onRejected));
  };

  // listener original -> [{ type, capture, wrapped }] — así \`removeEventListener\` encuentra el wrapper
  // real que quedó registrado, no el original (que nunca se le pasó al \`addEventListener\` nativo).
  var ɵwrappers = new WeakMap();
  var ɵaddEventListener = EventTarget.prototype.addEventListener;
  var ɵremoveEventListener = EventTarget.prototype.removeEventListener;

  EventTarget.prototype.addEventListener = function (type, listener, options) {
    if (typeof listener !== "function") return ɵaddEventListener.call(this, type, listener, options);
    var capture = typeof options === "boolean" ? options : !!(options && options.capture);
    var wrapped = function (event) { listener.call(this, event); ɵsafeApply(); };
    var entries = ɵwrappers.get(listener);
    if (!entries) { entries = []; ɵwrappers.set(listener, entries); }
    entries.push({ type: type, capture: capture, wrapped: wrapped });
    return ɵaddEventListener.call(this, type, wrapped, options);
  };

  EventTarget.prototype.removeEventListener = function (type, listener, options) {
    if (typeof listener !== "function") return ɵremoveEventListener.call(this, type, listener, options);
    var capture = typeof options === "boolean" ? options : !!(options && options.capture);
    var entries = ɵwrappers.get(listener);
    var target = listener;
    if (entries) {
      for (var i = 0; i < entries.length; i++) {
        if (entries[i].type === type && entries[i].capture === capture) {
          target = entries[i].wrapped;
          entries.splice(i, 1);
          break;
        }
      }
    }
    return ɵremoveEventListener.call(this, type, target, options);
  };
})();`;
  }
}
