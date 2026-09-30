import remapping from "@ampproject/remapping";
import type { NgjsTransform, TransformOutput, TransformSourceMap } from "@/compiler/ngjs-transform.ts";

/**
 * Por partes: escrito entero, el `dist` de este paquete tendría una línea `//# sourceMappingURL=data:...${...}` y
 * Vite/esbuild la tomarían como el source map del propio archivo (base64 inválido).
 */
const SOURCE_MAPPING_URL = ["source", "MappingURL"].join("");

/**
 * Corre los transforms en orden sobre un archivo y junta sus source maps en uno solo, del código final al TypeScript
 * original (con su contenido en `sourcesContent`, para que el devtools lo muestre sin pedir el `.ts`). Lo comparten
 * `pluginLoader` (esbuild), `viteTransformPlugin` y el escaneo (que solo usa el código).
 *
 * `map` es `null` si algún paso cambió el código sin devolver su mapa (ver `NgjsTransform`).
 */
export class TransformChain {
  static async run(code: string, path: string, transforms: readonly NgjsTransform[]): Promise<Required<TransformOutput> | undefined> {
    let current = code;
    // Del último paso al primero, como los pide `remapping`.
    const maps: TransformSourceMap[] = [];
    let mapped = true;

    for (const step of transforms) {
      const result = await step.transform(current, path);
      if (result === undefined) continue;
      const output = typeof result === "string" ? { code: result, map: null } : result;
      if (output.code === current) continue;
      if (output.map) maps.unshift(output.map);
      else mapped = false;
      current = output.code;
    }

    if (current === code) return undefined;
    return { code: current, map: mapped ? TransformChain.compose(maps, path, code) : null };
  }

  /** El mapa como comentario al final del código (`sourceMappingURL` inline) — lo que esbuild lee de un `onLoad`. */
  static inline(code: string, map: TransformSourceMap): string {
    const encoded = Buffer.from(JSON.stringify(map), "utf8").toString("base64");
    return `${code}\n//# ${SOURCE_MAPPING_URL}=data:application/json;charset=utf-8;base64,${encoded}\n`;
  }

  private static compose(maps: TransformSourceMap[], path: string, original: string): TransformSourceMap {
    const composed = remapping(maps as Parameters<typeof remapping>[0], () => null);
    // Todos los pasos nombran al archivo por su path (un solo `source`): el contenido es el TypeScript que se leyó.
    if (composed.sources.length > 1) throw new Error(`TransformChain: "${path}" — un paso nombró otra fuente (${composed.sources.join(", ")}).`);
    return { version: 3, sources: [path], sourcesContent: [original], names: composed.names, mappings: composed.mappings as string };
  }
}
