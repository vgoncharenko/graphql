import gql from 'graphql-tag';
import {
    introspectSchema,
    makeRemoteExecutableSchema,
    makeExecutableSchema,
    mergeSchemas,
} from 'graphql-tools';
import fastify, { FastifyRequest } from 'fastify';
import fastifyGQL from 'fastify-gql';
import { getAllPackages, mergePackageConfigs } from './localPackages';
import { join } from 'path';
import { readVar, hasVar } from './env';
import {
    FunctionDirectiveVisitor,
    prependPkgNameToFunctionDirectives,
} from './FunctionDirectiveVisitor';
import { getAllRemoteGQLSchemas } from './adobe-io';
import { createMonolithFetcher } from './monolith-fetcher';
import fetch from 'node-fetch';
import { assert } from './assert';
import { GraphQLContext } from './types';

export async function main() {
    const localExtensions = await collectLocalExtensions();
    const schemas = [
        // schemas are last-in-wins
        localExtensions.executableSchema,
    ];
    if (hasVar('IO_PACKAGES')) {
        const packages = readVar('IO_PACKAGES').asArray();
        // remote extensions take precedence over local
        // extensions, to ensure remote extensions can
        // extend types when logic is moved from the monolith
        // to this server
        schemas.push(await prepareRemoteExtensionSchemas(packages));
    }

    if (hasVar('LEGACY_GRAPHQL_URL')) {
        // Monolith schema gets highest precedence. It's
        // intentional that you cannot override the monolith
        // schema (if you need to extend the monolith schema, it
        // should be done in the monolith)
        schemas.push(
            await prepareFallbackSchema(
                readVar('LEGACY_GRAPHQL_URL').asString(),
            ),
        );
    }

    const fastifyServer = fastify();
    fastifyServer.register(fastifyGQL, {
        schema: mergeSchemas({
            schemas,
            // The mergeSchemas function, by default, loses built-in
            // directives (even though they're required by the spec).
            mergeDirectives: true,
        }),
        graphiql: 'playground',
        path: '/graphql',
        jit: 10,
        context: (req: FastifyRequest): GraphQLContext => ({
            legacyToken: req.headers.authorization,
            currency: req.headers['Content-Currency'] as string | undefined,
            store: req.headers.Store as string | undefined,
        }),
    });

    await fastifyServer.listen(readVar('PORT').asNumber());
    const netAddress = fastifyServer.server.address();
    assert(
        netAddress && typeof netAddress === 'object',
        'Unexpected binding to pipe/socket',
    );
    const address = `http://${netAddress.address}:${netAddress.port}`;

    console.log(`Server listening: ${address}`);
    console.log(`graphiql UI: ${address}/playground`);
}

/**
 * @summary Find all local (in-process) Magento GraphQL extensions,
 *          and merge all schemas and data sources
 */
async function collectLocalExtensions() {
    const inProcessPkgsRoot = join(__dirname, 'packages');
    const mergedLocalPkgConfigs = mergePackageConfigs(
        await getAllPackages(inProcessPkgsRoot),
    );
    const count = mergedLocalPkgConfigs.names.length;
    const names = mergedLocalPkgConfigs.names.map(n => `  - ${n}`).join('\n');
    console.log(`Found ${count} local package(s):\n${names}`);

    const executableSchema = makeExecutableSchema({
        typeDefs: mergedLocalPkgConfigs.typeDefs,
        resolvers: mergedLocalPkgConfigs.resolvers,
    });

    return {
        executableSchema,
    };
}

async function prepareRemoteExtensionSchemas(packages: string[]) {
    const ioSchemaDefs = await getAllRemoteGQLSchemas(packages);
    const pkgNames = ioSchemaDefs.map(s => `  - ${s.pkg}`).join('\n');
    console.log(
        `Found ${ioSchemaDefs.length} remote I/O GraphQL package(s):\n${pkgNames}`,
    );
    ioSchemaDefs.forEach(({ schemaDef, pkg }) => {
        prependPkgNameToFunctionDirectives(schemaDef, pkg);
    });
    const ioSchema = makeExecutableSchema({
        typeDefs: [
            gql`
                type Query {
                    # The "ignoreMe" query is a temporary hack
                    # to give remote packages a "Query" root type to extend
                    ignoreMe: String
                }
                directive @function(name: String!) on FIELD_DEFINITION
            `,
            // all remote schemas merged in _after_ we've defined
            // both the @function directive and the root "Query" type
            ...ioSchemaDefs.map(io => io.schemaDef),
        ],
    });
    // Decorate @function directives with the proper Adobe I/O
    // package name
    // TODO: @function directive should not be visible in the public schema
    FunctionDirectiveVisitor.visitSchemaDirectives(ioSchema, {
        function: FunctionDirectiveVisitor,
    });

    return ioSchema;
}

/**
 * @summary Fetch the remote schema from the Magento monolith,
 *          and create an executable schema with resolvers that
 *          delegate queries back to the monolith
 */
async function prepareFallbackSchema(legacyURL: string) {
    const fetcher = createMonolithFetcher(
        legacyURL,
        (fetch as unknown) as WindowOrWorkerGlobalScope['fetch'],
    );

    let rawMonolithSchema;

    try {
        rawMonolithSchema = await introspectSchema(fetcher);
    } catch (err) {
        throw new Error(
            `Failed introspecting remote Magento schema at "${legacyURL}". ` +
                'Make sure that the LEGACY_GRAPHQL_URL variable has the ' +
                'correct value for your Magento instance',
        );
    }

    return makeRemoteExecutableSchema({
        schema: rawMonolithSchema,
        fetcher,
    });
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
