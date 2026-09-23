/**
 * Forma común de cada paso de transform (`decorator-reader.ts`,
 * `decorator-writer.ts`, `module-writer.ts`, `decorator-metadata-transform.ts`,
 * ...). No son `Plugin` de esbuild — esbuild solo deja que UN `onLoad` se
 * quede con cada archivo, así que el `pluginLoader` (adaptador de esbuild) es
 * el único que registra `onLoad`, y encadena estos transforms adentro. Lo
 * mismo del lado de Vite (`viteTransformPlugin`). `undefined` = "no aplica,
 * seguí de largo sin tocar".
 */
export interface NgjsTransform {
  transform(code: string, path: string): Promise<string | undefined>;
}
