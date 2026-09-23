import { transform } from "@swc/core";
import type { NgjsTransform } from "@/compiler/ngjs-transform.ts";

/**
 * Último paso de la cadena: SWC pasa TS → JS y transforma los decoradores que
 * `DecoratorReader` no reconoce (`legacyDecorator`, de otras librerías). SIN
 * `design:paramtypes`: los tokens de constructor ya salen resueltos en build
 * (`ɵfac`), no hay nada que los lea en runtime.
 */
export const decoratorMetadataTransform: NgjsTransform = {
  async transform(code, path) {
    const { code: output } = await transform(code, {
      filename: path,
      jsc: {
        parser: { syntax: "typescript", decorators: true },
        target: "es2022",
        transform: { legacyDecorator: true, decoratorMetadata: false },
      },
      module: { type: "es6" },
    });

    return output;
  },
};
