/**
 *  Copyright (c) 2019 GraphQL Contributors
 *  All rights reserved.
 *
 *  This source code is licensed under the license found in the
 *  LICENSE file in the root directory of this source tree.
 *
 *  @flow
 */

import { expect } from 'chai';
import { GraphQLSchema } from 'graphql/type';
import { parse } from 'graphql/language';
import { getGraphQLConfig } from 'graphql-config';
import { beforeEach, afterEach, describe, it } from 'mocha';
import fetchMock from 'fetch-mock';

import { GraphQLCache } from '../GraphQLCache';
import { getQueryAndRange } from '../MessageProcessor';

function wihtoutASTNode(definition: object) {
  const result = { ...definition };
  delete result.astNode;
  return result;
}

describe('GraphQLCache', () => {
  let cache;
  let graphQLRC;

  beforeEach(async () => {
    const configDir = __dirname;
    graphQLRC = getGraphQLConfig(configDir);
    cache = new GraphQLCache(configDir, graphQLRC);
  });

  afterEach(() => {
    fetchMock.restore();
  });

  describe('getSchema', () => {
    it('generates the schema correctly for the test app config', async () => {
      const schema = await cache.getSchema('testWithSchema');
      expect(schema instanceof GraphQLSchema).to.equal(true);
    });

    it('generates the schema correctly from endpoint', async () => {
      const introspectionResult = await graphQLRC
        .getProjectConfig('testWithSchema')
        .resolveIntrospection();

      fetchMock.mock({
        matcher: '*',
        response: {
          headers: {
            'Content-Type': 'application/json',
          },
          body: introspectionResult,
        },
      });

      const schema = await cache.getSchema('testWithEndpoint');
      expect(fetchMock.called('*')).to.equal(true);
      expect(schema instanceof GraphQLSchema).to.equal(true);
    });

    it('falls through to schema on disk if endpoint fails', async () => {
      fetchMock.mock({
        matcher: '*',
        response: 500,
      });

      const schema = await cache.getSchema('testWithEndpointAndSchema');
      expect(fetchMock.called('*')).to.equal(true);
      expect(schema instanceof GraphQLSchema).to.equal(true);
    });

    it('does not generate a schema without a schema path or endpoint', async () => {
      const schema = await cache.getSchema('testWithoutSchema');
      expect(schema instanceof GraphQLSchema).to.equal(false);
    });

    it('extend the schema with appropriate custom directive', async () => {
      const schema = await cache.getSchema('testWithCustomDirectives');
      expect(
        wihtoutASTNode(schema.getDirective('customDirective')),
      ).to.deep.equal({
        args: [],
        description: undefined,
        locations: ['FIELD'],
        name: 'customDirective',
      });
    });

    it('extend the schema with appropriate custom directive 2', async () => {
      const schema = await cache.getSchema('testWithSchema');
      expect(
        wihtoutASTNode(schema.getDirective('customDirective')),
      ).to.deep.equal({
        args: [],
        description: undefined,
        locations: ['FRAGMENT_SPREAD'],
        name: 'customDirective',
      });
    });
  });

  describe('handleWatchmanSubscribeEvent', () => {
    it('handles invalidating the schema cache', async () => {
      const projectConfig = graphQLRC.getProjectConfig('testWithSchema');
      await cache.getSchema('testWithSchema');
      expect(cache._schemaMap.size).to.equal(1);
      const handler = cache.handleWatchmanSubscribeEvent(__dirname, projectConfig);
      const testResult = {
        root: __dirname,
        subscription: '',
        files: [{
          name: '__schema__/StarWarsSchema.graphql',
          exists: true,
          size: 5,
          is_fresh_instance: true,
          mtime: Date.now()
        }]
      }
      handler(testResult);
      expect(cache._schemaMap.size).to.equal(0);
    });

    it('handles invalidating the endpoint cache', async () => {
      const projectConfig = graphQLRC.getProjectConfig('testWithEndpointAndSchema');
      const introspectionResult = await graphQLRC
        .getProjectConfig('testWithSchema')
        .resolveIntrospection();

      fetchMock.mock({
        matcher: '*',
        response: {
          headers: {
            'Content-Type': 'application/json',
          },
          body: introspectionResult,
        },
      });

      await cache.getSchema('testWithEndpointAndSchema');
      expect(cache._schemaMap.size).to.equal(1);
      const handler = cache.handleWatchmanSubscribeEvent(__dirname, projectConfig);
      const testResult = {
        root: __dirname,
        subscription: '',
        files: [{
          name: '__schema__/StarWarsSchema.graphql',
          exists: true,
          size: 5,
          is_fresh_instance: true,
          mtime: Date.now()
        }]
      }
      handler(testResult);
      expect(cache._schemaMap.size).to.equal(0);
    });
  });

  describe('getFragmentDependencies', () => {
    const duckContent = `fragment Duck on Duck {
      cuack
    }`;
    const duckDefinition = parse(duckContent).definitions[0];

    const catContent = `fragment Cat on Cat {
      meow
    }`;

    const catDefinition = parse(catContent).definitions[0];

    const fragmentDefinitions = new Map();
    fragmentDefinitions.set('Duck', {
      file: 'someFilePath',
      content: duckContent,
      definition: duckDefinition,
    });
    fragmentDefinitions.set('Cat', {
      file: 'someOtherFilePath',
      content: catContent,
      definition: catDefinition,
    });

    it('finds fragments referenced in Relay queries', async () => {
      const text =
        'module.exports = Relay.createContainer(' +
        'DispatchResumeCard, {\n' +
        '  fragments: {\n' +
        '    candidate: () => graphql`\n' +
        '      query A { ...Duck ...Cat }\n' +
        '    `,\n' +
        '  },\n' +
        '});';
      const contents = getQueryAndRange(text, 'test.js');
      const result = await cache.getFragmentDependenciesForAST(
        parse(contents[0].query),
        fragmentDefinitions,
      );
      expect(result.length).to.equal(2);
    });

    it('finds fragments referenced from the query', async () => {
      const ast = parse('query A { ...Duck }');

      const result = await cache.getFragmentDependenciesForAST(
        ast,
        fragmentDefinitions,
      );
      expect(result.length).to.equal(1);
    });
  });

  describe('getFragmentDefinitions', () => {
    it('it caches fragments found through single glob in `includes`', async () => {
      const config = graphQLRC.getProjectConfig('testSingularIncludesGlob');
      const fragmentDefinitions = await cache.getFragmentDefinitions(config);
      expect(fragmentDefinitions.get('testFragment')).to.not.be.undefined;
    });

    it('it caches fragments found through multiple globs in `includes`', async () => {
      const config = graphQLRC.getProjectConfig('testMultipleIncludes');
      const fragmentDefinitions = await cache.getFragmentDefinitions(config);
      expect(fragmentDefinitions.get('testFragment')).to.not.be.undefined;
    });

    it('handles empty includes', async () => {
      const config = graphQLRC.getProjectConfig('testNoIncludes');
      const fragmentDefinitions = await cache.getFragmentDefinitions(config);
      expect(fragmentDefinitions.get('testFragment')).to.be.undefined;
    });

    it('handles non-existent includes', async () => {
      const config = graphQLRC.getProjectConfig('testBadIncludes');
      const fragmentDefinitions = await cache.getFragmentDefinitions(config);
      expect(fragmentDefinitions.get('testFragment')).to.be.undefined;
    });
  });

  describe('getNamedTypeDependencies', () => {
    const query = `type Query {
        hero(episode: Episode): Character
      }
      
      type Episode {
        id: ID!
      }
      `;
    const parsedQuery = parse(query);

    const namedTypeDefinitions = new Map();
    namedTypeDefinitions.set('Character', {
      file: 'someOtherFilePath',
      content: query,
      definition: {
        kind: 'ObjectTypeDefinition',
        name: {
          kind: 'Name',
          value: 'Character',
        },
        loc: {
          start: 0,
          end: 0,
        },
      },
    });

    it('finds named types referenced from the SDL', async () => {
      const result = await cache.getObjectTypeDependenciesForAST(
        parsedQuery,
        namedTypeDefinitions,
      );
      expect(result.length).to.equal(1);
    });
  });
});
