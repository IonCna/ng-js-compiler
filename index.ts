export type {
  BindingsMetadata,
  ComponentMetadata,
  DecoratorMetadata,
  DirectiveMetadata,
  NgModuleMetadata,
  PipeMetadata,
  ServiceMetadata,
} from "@/metadata/decorator-metadata.ts";
export { MetadataStore } from "@/metadata/metadata-store.ts";
export { ApplicationNode, type DeclarationBuckets } from "@/compiler/application-node.ts";
export { ApplicationScanner } from "@/compiler/application-scanner.ts";
export { PlatformCode, type ProjectType } from "@/compiler/platform-code.ts";
export { ComponentBindings } from "@/compiler/component-bindings.ts";
export { decoratorMetadataTransform } from "@/compiler/decorator-metadata-transform.ts";
export { DecoratorReader, decoratorReaderTransform } from "@/compiler/decorator-reader.ts";
export { DecoratorWriter, decoratorWriterTransform } from "@/compiler/decorator-writer.ts";
export { HashId } from "@/compiler/hash-id.ts";
export { createModuleWriterTransform, ModuleWriter } from "@/compiler/module-writer.ts";
export { createNgjsCompilerTransforms } from "@/compiler/ngjs-compiler-transforms.ts";
export type { NgjsTransform } from "@/compiler/ngjs-transform.ts";
export { SelectorParser, type ParsedSelector } from "@/compiler/selector-parser.ts";
