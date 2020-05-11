import { IFetcherOperation } from 'graphql-tools';
import { print } from 'graphql';
import { GraphQLContext } from '../../types';
import { default as nodeFetch } from 'node-fetch';

/**
 * @summary Create a custom "Fetcher" for makeRemoteExecutableSchema to use
 *          when calling the Monolith/Legacy Magento GraphQL API (PHP).
 *          Ensures required Magento headers are passed along
 *
 * @see https://devdocs.magento.com/guides/v2.3/graphql/send-request.html#request-headers
 * @see https://www.apollographql.com/docs/graphql-tools/remote-schemas/#fetcher-api
 */
export function createMonolithApolloFetcher(
    monolithGraphQLUrl: string,
    fetch: WindowOrWorkerGlobalScope['fetch'] | typeof nodeFetch = nodeFetch,
) {
    return async (opts: IFetcherOperation) => {
        const headers = {
            'Content-Type': 'application/json',
        };
        if (opts.context) {
            const context: GraphQLContext = opts.context.graphqlContext;
            Object.assign(
                headers,
                filterUndefinedEntries({
                    Authorization: `Bearer ${context.legacyToken}`,
                    'Content-Currency': context.currency,
                    Store: context.store,
                }),
            );
        }

        const result = await fetch(monolithGraphQLUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                query: print(opts.query),
                variables: opts.variables,
                operationName: opts.operationName,
            }),
        });

        return result.json();
    };
}

/**
 * @summary Create a new object based on an existing one,
 *          excluding entries with an undefined value
 */
const filterUndefinedEntries = <K extends string, V>(obj: Record<K, V>) => {
    return Object.fromEntries(
        Object.entries(obj).filter(o => o[1] !== undefined),
    );
};
