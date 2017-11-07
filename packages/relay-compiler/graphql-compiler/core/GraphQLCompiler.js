/**
 * Copyright (c) 2013-present, Facebook, Inc.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 * @providesModule GraphQLCompiler
 * @format
 */

'use strict';

const GraphQLIRPrinter = require('./GraphQLIRPrinter');

const filterContextForNode = require('./filterContextForNode');

import type {GraphQLReporter} from '../reporters/GraphQLReporter';
import type GraphQLCompilerContext from './GraphQLCompilerContext';
import type {Batch, Fragment, Root} from './GraphQLIR';
import type {IRTransform} from './GraphQLIRTransforms';
import type {GraphQLSchema} from 'graphql';

export type CompiledDocumentMap<CodegenNode> = Map<string, CodegenNode>;

export interface Compiler<CodegenNode> {
  add(text: string): Array<Root | Fragment>,
  compile(): CompiledDocumentMap<CodegenNode>,
}

export type CompilerTransforms = {
  codegenTransforms: Array<IRTransform>,
  fragmentTransforms: Array<IRTransform>,
  printTransforms: Array<IRTransform>,
  queryTransforms: Array<IRTransform>,
};

/**
 * A utility class for parsing a corpus of GraphQL documents, transforming them
 * with a standardized set of transforms, and generating runtime representations
 * of each definition.
 */
class GraphQLCompiler<CodegenNode> {
  _context: GraphQLCompilerContext;
  _schema: GraphQLSchema;
  _transformedQueryContext: ?GraphQLCompilerContext;
  _transforms: CompilerTransforms;
  _codeGenerator: (node: Batch | Fragment) => CodegenNode;
  _reporter: GraphQLReporter;

  // The context passed in must already have any Relay-specific schema extensions
  constructor(
    schema: GraphQLSchema,
    context: GraphQLCompilerContext,
    transforms: CompilerTransforms,
    codeGenerator: (node: Batch | Fragment) => CodegenNode,
    reporter: GraphQLReporter,
  ) {
    this._context = context;
    // some transforms depend on this being the original schema,
    // not the transformed schema/context's schema
    this._schema = schema;
    this._transforms = transforms;
    this._codeGenerator = codeGenerator;
    this._reporter = reporter;
  }

  clone(): GraphQLCompiler<CodegenNode> {
    return new GraphQLCompiler(
      this._schema,
      this._context,
      this._transforms,
      this._codeGenerator,
      this._reporter,
    );
  }

  context(): GraphQLCompilerContext {
    return this._context;
  }

  addDefinitions(definitions: Array<Fragment | Root>): Array<Root | Fragment> {
    this._context = this._context.addAll(definitions);
    return this._context.documents();
  }

  // Can only be called once per compiler. Once run, will use cached context
  // To re-run, clone the compiler.
  transformedQueryContext(): GraphQLCompilerContext {
    if (this._transformedQueryContext) {
      return this._transformedQueryContext;
    }
    this._transformedQueryContext = this._context.applyTransforms(
      this._transforms.queryTransforms,
      this._schema,
      this._reporter,
    );
    return this._transformedQueryContext;
  }

  compile(): CompiledDocumentMap<CodegenNode> {
    const fragmentContext = this._context.applyTransforms(
      this._transforms.fragmentTransforms,
      this._schema,
      this._reporter,
    );
    const queryContext = this.transformedQueryContext();
    const printContext = queryContext.applyTransforms(
      this._transforms.printTransforms,
      this._schema,
      this._reporter,
    );
    const codeGenContext = queryContext.applyTransforms(
      this._transforms.codegenTransforms,
      this._schema,
      this._reporter,
    );

    const compiledDocuments: CompiledDocumentMap<CodegenNode> = new Map();
    fragmentContext.documents().forEach(node => {
      if (node.kind !== 'Fragment') {
        return;
      }
      const generatedFragment = this._codeGenerator(node);
      compiledDocuments.set(node.name, generatedFragment);
    });
    queryContext.documents().forEach(node => {
      if (node.kind !== 'Root') {
        return;
      }
      const {name} = node;
      // The unflattened query is used for printing, since flattening creates an
      // invalid query.
      const text = filterContextForNode(
        printContext.getRoot(name),
        printContext,
      )
        .documents()
        .map(GraphQLIRPrinter.print)
        .join('\n');
      // The original query (with fragment spreads) is converted to a fragment
      // for reading out the root data.
      const sourceNode = fragmentContext.getRoot(name);
      const rootFragment = buildFragmentForRoot(sourceNode);
      // The flattened query is used for codegen in order to reduce the number of
      // duplicate fields that must be processed during response normalization.
      const codeGenNode = codeGenContext.getRoot(name);

      const batchQuery = {
        fragment: rootFragment,
        id: null,
        kind: 'Batch',
        metadata: node.metadata || {},
        name,
        operation: codeGenNode,
        text,
      };
      const generatedDocument = this._codeGenerator(batchQuery);
      compiledDocuments.set(name, generatedDocument);
    });
    return compiledDocuments;
  }
}

/**
 * Construct the fragment equivalent of a root node.
 */
function buildFragmentForRoot(root: Root): Fragment {
  return {
    argumentDefinitions: (root.argumentDefinitions: $FlowIssue),
    directives: root.directives,
    kind: 'Fragment',
    metadata: null,
    name: root.name,
    selections: root.selections,
    type: root.type,
  };
}

module.exports = GraphQLCompiler;
