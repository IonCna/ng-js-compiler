import type { BindingsMetadata } from "@/metadata/decorator-metadata.ts";

type HostBinding = BindingsMetadata["hostBindings"][number];
type HostListener = BindingsMetadata["hostListeners"][number];
type ParsedHostProperty = { kind: "class" | "attr" | "style" | "prop"; name: string; unit?: string };
/** Dónde escucha un `@HostListener`: el host, o un target global (`"window:resize"`). */
type ListenerTarget = "host" | "window" | "document" | "body";

/**
 * Traduce `@HostBinding`/`@HostListener` (ya leídos por `DecoratorReader`) al cuerpo del factory
 * que arma `DecoratorWriter` — nada de esto corre si la clase no tiene ninguno de los dos.
 *
 * Los bindings se aplican vía `$scope.$watch`, no una vez al construir: así se actualizan solos en
 * cada `$digest` como cualquier binding de Angular real (mismo mecanismo que `ComponentBindings`
 * ya usa para `@Input`), y es el mismo punto donde después cuelga cualquier hook nuevo que necesite
 * `$element`/`$scope` (`afterNextRender` y similares).
 */
export class HostWiring {
  /** Deps extra que el factory necesita agregar (en ese orden) cuando hay algo que instalar. */
  static readonly FACTORY_DEPS = ["$element", "$scope"];

  static hasAny(metadata: BindingsMetadata): boolean {
    return metadata.hostBindings.length > 0 || metadata.hostListeners.length > 0;
  }

  /** Statements a insertar entre `var instance = new X(...);` y `return instance;`. */
  static statements(metadata: BindingsMetadata, owner: string): string[] {
    const watches = metadata.hostBindings.map((binding, index) => HostWiring.watchStatement(binding, index, owner));
    const listeners = metadata.hostListeners.map((listener, index) => HostWiring.listenerStatement(listener, index));

    if (!watches.length && !listeners.length) return [];

    const unwatchNames = metadata.hostBindings.map((_, index) => `ɵunwatch${index}`);
    const handlerNames = metadata.hostListeners.map((_, index) => `ɵhandler${index}`);
    const cleanup = HostWiring.destroyStatement(unwatchNames, metadata.hostListeners, handlerNames);

    return [...watches, ...listeners, cleanup];
  }

  private static watchStatement(binding: HostBinding, index: number, owner: string): string {
    const parsed = HostWiring.parseHostProperty(binding.hostProperty, owner, binding.propName);
    const apply = HostWiring.applyExpr(parsed, "v");
    return `var ɵunwatch${index} = $scope.$watch(function () { return instance.${binding.propName}; }, function (v) { ${apply}; });`;
  }

  /**
   * El listener nativo corre fuera del `$digest` — como `ng-click` internamente, envolvemos la
   * llamada en `$scope.$apply()` para que un cambio de estado adentro (por ejemplo, algo que un
   * `@HostBinding` esté mirando) se refleje sin depender de que algo más dispare el digest después.
   * "Safe apply": si ya hay un digest/apply en curso (`$root.$$phase`), `$apply()` tira
   * "$digest already in progress" — en ese caso se llama directo, el digest en curso ya lo recoge.
   */
  private static listenerStatement(listener: HostListener, index: number): string {
    const parsed = HostWiring.parseEventName(listener.eventName);
    const args = listener.args.map((arg) => arg.replace(/^\$event/, "event")).join(", ");
    const call = `instance.${listener.methodName}(${args});`;
    return [
      `var ɵhandler${index} = function (event) {`,
      parsed.key ? `  if (!${HostWiring.keyMatchExpr(parsed.key, parsed.modifiers)}) return;` : "",
      `  var ɵphase = $scope.$root.$$phase;`,
      `  if (ɵphase === "$apply" || ɵphase === "$digest") { ${call} }`,
      `  else { $scope.$apply(function () { ${call} }); }`,
      `};`,
      `${HostWiring.onExpr(parsed.target, "on")}(${JSON.stringify(parsed.event)}, ɵhandler${index});`,
    ]
      .filter(Boolean)
      .join("\n");
  }

  private static destroyStatement(unwatchNames: string[], listeners: HostListener[], handlerNames: string[]): string {
    const unwatchCalls = unwatchNames.map((name) => `${name}();`);
    const offCalls = listeners.map((listener, index) => {
      const parsed = HostWiring.parseEventName(listener.eventName);
      return `${HostWiring.onExpr(parsed.target, "off")}(${JSON.stringify(parsed.event)}, ${handlerNames[index]});`;
    });
    return `$scope.$on("$destroy", function () { ${[...unwatchCalls, ...offCalls].join(" ")} });`;
  }

  /**
   * Como Angular: `"window:resize"`/`"document:click"`/`"body:scroll"` escuchan en ese target global (y se sacan en
   * `$destroy`: si no, quedarían vivos después del elemento); `"keydown.enter"`/`"keyup.shift.tab"` filtran por tecla
   * y modificadores (solo en eventos de teclado). Sin prefijo, el propio host.
   */
  private static parseEventName(eventName: string): { target: ListenerTarget; event: string; key?: string; modifiers: string[] } {
    const targetMatch = /^(window|document|body):(.+)$/.exec(eventName);
    const target = (targetMatch?.[1] as ListenerTarget | undefined) ?? "host";
    const [event, ...parts] = (targetMatch?.[2] ?? eventName).split(".");
    if (!parts.length) return { target, event: event!, modifiers: [] };
    if (event !== "keydown" && event !== "keyup") {
      throw new Error(`HostWiring: @HostListener(${JSON.stringify(eventName)}) — el filtro por tecla solo existe en keydown/keyup.`);
    }
    const key = parts.pop()!.toLowerCase();
    const modifiers = parts.map((part) => (part.toLowerCase() === "ctrl" ? "control" : part.toLowerCase()));
    for (const modifier of modifiers) {
      if (!HostWiring.MODIFIERS.includes(modifier)) {
        throw new Error(`HostWiring: @HostListener(${JSON.stringify(eventName)}) — modificador "${modifier}" desconocido (alt/control/meta/shift).`);
      }
    }
    return { target, event: event!, key: HostWiring.KEY_ALIASES[key] ?? key, modifiers };
  }

  private static readonly MODIFIERS = ["alt", "control", "meta", "shift"];

  /** Nombres de Angular para teclas cuyo `event.key` no es la palabra (`"space"` → `" "`). */
  private static readonly KEY_ALIASES: Record<string, string> = {
    space: " ",
    dot: ".",
    esc: "escape",
    del: "delete",
    up: "arrowup",
    down: "arrowdown",
    left: "arrowleft",
    right: "arrowright",
  };

  /** La tecla (sin distinguir mayúsculas) con EXACTAMENTE esos modificadores apretados, como Angular. */
  private static keyMatchExpr(key: string, modifiers: string[]): string {
    const flags = HostWiring.MODIFIERS.map((modifier) => {
      const property = modifier === "control" ? "ctrlKey" : `${modifier}Key`;
      return `${modifiers.includes(modifier) ? "" : "!"}event.${property}`;
    });
    return `(String(event.key).toLowerCase() === ${JSON.stringify(key)} && ${flags.join(" && ")})`;
  }

  /** `$element.on`/`.off` en el host; `addEventListener`/`removeEventListener` nativo en un target global. */
  private static onExpr(target: ListenerTarget, action: "on" | "off"): string {
    if (target === "host") return `$element.${action}`;
    const object = target === "body" ? "document.body" : target;
    return `${object}.${action === "on" ? "addEventListener" : "removeEventListener"}`;
  }

  /**
   * `class.active` / `attr.aria-label` / `style.color` / `style.width.px` / `disabled` (sin prefijo,
   * propiedad DOM directa, como Ivy). Cualquier otra forma (`foo.bar.baz.qux`, prefijo desconocido)
   * no se puede traducir: error en build, no se descarta en silencio.
   */
  private static parseHostProperty(hostProperty: string, owner: string, propName: string): ParsedHostProperty {
    const parts = hostProperty.split(".");
    const fail = (): never => {
      throw new Error(`HostWiring: "${owner}.${propName}" — @HostBinding(${JSON.stringify(hostProperty)}) no soportado todavía.`);
    };

    if (parts.length === 1) return { kind: "prop", name: parts[0]! };
    if (parts.length === 2 && (parts[0] === "class" || parts[0] === "attr" || parts[0] === "style")) {
      return { kind: parts[0], name: parts[1]! };
    }
    if (parts.length === 3 && parts[0] === "style") return { kind: "style", name: parts[1]!, unit: parts[2] };
    return fail();
  }

  /**
   * Semántica de Angular real: `attr.X` con `null`/`undefined` quita el atributo; cualquier otro valor se escribe como
   * string (`false` → `"false"`, lo que necesita un `aria-expanded`).
   */
  private static applyExpr(parsed: ParsedHostProperty, valueVar: string): string {
    const name = JSON.stringify(parsed.name);

    switch (parsed.kind) {
      case "class":
        return `${valueVar} ? $element.addClass(${name}) : $element.removeClass(${name})`;
      case "attr":
        return `${valueVar} == null ? $element.removeAttr(${name}) : $element.attr(${name}, String(${valueVar}))`;
      case "style": {
        const unit = JSON.stringify(parsed.unit ?? "");
        return `${valueVar} == null ? $element.css(${name}, "") : $element.css(${name}, ${valueVar} + ${unit})`;
      }
      case "prop":
        return `$element.prop(${name}, ${valueVar})`;
    }
  }
}
