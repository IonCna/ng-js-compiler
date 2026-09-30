/** El mapa de un paso: del código que devuelve al que recibió (v3, `sources` = el path del archivo). */
export interface TransformSourceMap {
  version: number;
  file?: string;
  sourceRoot?: string;
  sources: string[];
  sourcesContent?: string[];
  names: string[];
  mappings: string;
}

/** El código transformado y, si el paso lo sabe armar, su source map. */
export interface TransformOutput {
  code: string;
  map?: TransformSourceMap | null;
}

/**
 * Forma común de cada paso de transform (`decorator-reader.ts`,
 * `decorator-writer.ts`, `module-writer.ts`, `decorator-metadata-transform.ts`,
 * ...). No son `Plugin` de esbuild — esbuild solo deja que UN `onLoad` se
 * quede con cada archivo, así que el `pluginLoader` (adaptador de esbuild) es
 * el único que registra `onLoad`, y encadena estos transforms adentro. Lo
 * mismo del lado de Vite (`viteTransformPlugin`). `undefined` = "no aplica,
 * seguí de largo sin tocar".
 *
 * Un paso que devuelve `{ code, map }` mantiene la correspondencia con el TypeScript original (`TransformChain` junta
 * los mapas, como Angular CLI encadena el de TypeScript con el de Babel). Un `string` a secas también vale, pero corta
 * el source map del archivo: sin saber qué movió, un mapa armado igual apuntaría a líneas equivocadas.
 */
export interface NgjsTransform {
  transform(code: string, path: string): Promise<string | TransformOutput | undefined>;
}
