import assert from 'assert';
import { credentials } from 'grpc';
import { promisify } from 'util';
import { getFrameworkConfig } from '../../config';
import gql from 'graphql-tag';
import { Resolvers } from '../../../../generated/graphql';
import { ProductsGetRequest } from '../../../../generated/catalog_pb';
import { CatalogClient } from '../../../../generated/catalog_grpc_pb';

export async function createCatalogSchema() {
    const config = getFrameworkConfig();
    const host = config.get('CATALOG_STOREFRONT_HOST').asString();
    const port = config.get('CATALOG_STOREFRONT_PORT').asNumber();

    const client = new CatalogClient(
        `${host}:${port}`,
        credentials.createInsecure(),
    );
    const getProducts = promisify(client.getProducts.bind(client));

    const typeDefs = gql`
        extend type Query {
            productByID(id: ID!): CatalogServiceProduct
        }

        type CatalogServiceProduct {
            id: ID!
            name: String!
        }
    `;

    const resolvers: Resolvers = {
        Query: {
            async productByID(root, args) {
                const msg = new ProductsGetRequest();
                msg.setIdsList([args.id as string]);
                msg.setStore('default');

                const res = await getProducts(msg);
                assert(res, 'Did not receive a response from Catalog gRPC API');

                const [product] = res.getItemsList();

                return {
                    id: product.getSku(),
                    name: product.getName(),
                };
            },
        },
    };

    return { resolvers, typeDefs };
}
