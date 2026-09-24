import { transform } from "@swc/core";
import { AsyncDownlevel } from "@/compiler/async-downlevel.ts";
import type { NgjsTransform } from "@/compiler/ngjs-transform.ts";

/**
 * Último paso de la cadena: SWC pasa TS → JS y transforma los decoradores que
 * `DecoratorReader` no reconoce (`legacyDecorator`, de otras librerías). SIN
 * `design:paramtypes`: los tokens de constructor ya salen resueltos en build
 * (`ɵfac`), no hay nada que los lea en runtime.
 *
 * Sintaxis ES2022 (Chrome 94), salvo `async/await` y `for await`, que SIEMPRE se bajan a generadores — como
 * Angular CLI con Zone.js: `ZonePatchesRuntime` parchea `Promise.prototype.then`, y V8 no pasa por `.then` al
 * reanudar un `await` nativo (cero intercepciones, probado); los helpers de SWC reanudan con
 * `Promise.resolve(x).then(...)`, así el digest se dispara. Se hace acá (no con el `target` de esbuild/Vite) para
 * que valga igual en build y en dev, y también para una librería compilada con esto (`ngjs-core`), que el
 * dev-server sirve sin transformar.
 */
export const decoratorMetadataTransform: NgjsTransform = {
  async transform(code, path) {
    const { code: output } = await transform(code, {
      filename: path,
      env: AsyncDownlevel.SWC_ENV,
      jsc: {
        parser: { syntax: "typescript", decorators: true },
        // `useDefineForClassFields: false` como Angular CLI: con campos nativos (`es2022`) un inicializador
        // (`projects = this.planning.getProjects()`) corre ANTES de asignar el parámetro-propiedad del constructor.
        transform: { legacyDecorator: true, decoratorMetadata: false, useDefineForClassFields: false },
      },
      module: { type: "es6" },
    });

    return output;
  },
};
