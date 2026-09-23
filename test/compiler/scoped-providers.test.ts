import { describe, expect, it } from "vitest";
import type { ProviderMetadata } from "@/metadata/decorator-metadata.ts";
import { ScopedProviders } from "@/compiler/scoped-providers.ts";

describe("ScopedProviders", () => {
  it("hasAny(): true con al menos un provider, false con la lista vacía", () => {
    expect(ScopedProviders.hasAny([])).toBe(false);
    expect(ScopedProviders.hasAny([{ kind: "class", token: "X", classExpr: "X" }])).toBe(true);
  });

  it("cada receta se traduce a un descriptor literal que ScopedInjectorRuntime puede interpretar", () => {
    const providers: ProviderMetadata[] = [
      { kind: "class", token: "UserService_1a2b3c4d", classExpr: "UserService" },
      { kind: "constructor", token: "Logger_1a2b3c4d", classExpr: "Logger", deps: ["$http"], multi: false },
      { kind: "useClass", token: "Logger_1a2b3c4d", classExpr: "ConsoleLogger", multi: false },
      { kind: "useValue", token: "api.url", valueExpr: '"https://api"', multi: false },
      { kind: "useFactory", token: "greeting", factoryExpr: "(url) => \"hola \" + url", deps: ["api.url"], multi: false },
      { kind: "useExisting", token: "legacyLogger", existingToken: "Logger_1a2b3c4d", multi: false },
    ];

    const statement = ScopedProviders.statement("CardComponent", providers);

    expect(statement).toBe(
      'CardComponent.ɵfac.ɵproviders = [' +
        '{ token: "UserService_1a2b3c4d", kind: "class", ctor: UserService }, ' +
        '{ token: "Logger_1a2b3c4d", kind: "constructor", ctor: Logger, deps: ["$http"] }, ' +
        '{ token: "Logger_1a2b3c4d", kind: "useClass", ctor: ConsoleLogger }, ' +
        '{ token: "api.url", kind: "useValue", value: "https://api" }, ' +
        '{ token: "greeting", kind: "useFactory", factory: (url) => "hola " + url, deps: ["api.url"] }, ' +
        '{ token: "legacyLogger", kind: "useExisting", existing: "Logger_1a2b3c4d" }' +
        '];',
    );
  });

  it("un provider multi se marca con multi: true en el descriptor", () => {
    const statement = ScopedProviders.statement("CardComponent", [
      { kind: "useValue", token: "HOOKS", valueExpr: '"a"', multi: true },
    ]);

    expect(statement).toBe('CardComponent.ɵfac.ɵproviders = [{ token: "HOOKS", kind: "useValue", value: "a", multi: true }];');
  });

  it("mezclar providers multi y no-multi para el mismo token es error, como en ModuleWriter", () => {
    const providers: ProviderMetadata[] = [
      { kind: "useValue", token: "HOOKS", valueExpr: '"a"', multi: true },
      { kind: "useValue", token: "HOOKS", valueExpr: '"b"', multi: false },
    ];

    expect(() => ScopedProviders.statement("CardComponent", providers)).toThrow(
      'ScopedProviders: "CardComponent" mezcla providers multi y no-multi para el token "HOOKS".',
    );
  });
});
