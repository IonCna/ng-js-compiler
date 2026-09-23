/**
 * Multi-providers (`{ provide: HOOKS, useValue: "a", multi: true }`) entre módulos — AngularJS tiene UN
 * injector por app y no conoce `multi`: cada aporte se registra con un nombre único en toda la app
 * (`HOOKS#multi#<id del módulo>#i`, ver `ModuleWriter.providerCalls`/`ModuleWithProvidersRuntime`) y un `.config`
 * por módulo lo anota en una lista por token y vuelve a registrar `.factory(token)` con la lista hasta ahí.
 *
 * Los `.config` corren en orden de carga (módulos importados antes que el que importa), así que el último
 * registro tiene todos los aportes, en el orden de Angular: importados → `ModuleWithProviders` → propios. La
 * lista vive en el injector de providers (uno por `angular.bootstrap`), no en una global.
 *
 * Mezclar multi y no-multi entre módulos es error, como en Angular, sin importar el orden:
 * - no-multi ANTES: el token ya está registrado y no por esta lista.
 * - no-multi DESPUÉS (un módulo que carga más tarde, o su cola corre después de este `.config`): la primera vez
 *   se envuelven los métodos de registro de `$provide` — el objeto por el que pasa TODA la cola de registros de
 *   la app (`runInvokeQueue`), también la de un módulo lazy que se cargue después — y registrar un token multi
 *   es error. El `.factory` que junta la lista usa el método original.
 *
 * Texto plano a nivel de módulo, como `ScopedInjectorRuntime`.
 */
export class MultiProvidersRuntime {
  static source(): string {
    return `function ɵmultiMixError(token) {
  return new Error("Multi-providers: mezcla providers multi y no-multi para el token \\"" + token + "\\" entre módulos.");
}
function ɵmultiProviders($provide, providers, token, members) {
  var state = providers.ɵmulti;
  if (!state) {
    state = providers.ɵmulti = { tokens: {}, factory: $provide.factory };
    ["provider", "factory", "service", "value", "constant"].forEach(function (method) {
      var original = $provide[method];
      $provide[method] = function (name) {
        if (typeof name === "string" && Object.prototype.hasOwnProperty.call(state.tokens, name)) throw ɵmultiMixError(name);
        return original.apply(this, arguments);
      };
    });
  }
  if (!state.tokens[token] && providers.has(token + "Provider")) throw ɵmultiMixError(token);
  state.tokens[token] = (state.tokens[token] || []).concat(members);
  state.factory(token, state.tokens[token].concat([function () { return Array.prototype.slice.call(arguments); }]));
}
function ɵmultiConfig(token, members) {
  return ["$provide", "$injector", function ($provide, providers) { ɵmultiProviders($provide, providers, token, members); }];
}`;
  }

  /** Fragmento para la cadena `ɵangular.module(...)`: anota los aportes de este módulo a `token`. */
  static configFragment(token: string, members: string[]): string {
    return `.config(ɵmultiConfig(${JSON.stringify(token)}, ${JSON.stringify(members)}))`;
  }
}
