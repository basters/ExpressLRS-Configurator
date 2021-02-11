import { ApolloServer, PubSub } from 'apollo-server-express';
import express, { Express } from 'express';
import * as http from 'http';
import getPort from 'get-port';
import { buildSchema } from 'type-graphql';
import { Container } from 'typedi';
import { ConfigToken, IConfig } from './src/config';
import FirmwareService from './src/services/Firmware';
import Platformio from './src/library/Platformio';
import FirmwareBuilder from './src/library/FirmwareBuilder';
import PubSubToken from './src/pubsub/PubSubToken';
import { LoggerService } from './src/logger';
import LoggerToken from './src/logger/LoggerToken';

// importing for side effects
// eslint-disable-next-line import/extensions
import './src/graphql/enum/DeviceTarget';
// eslint-disable-next-line import/extensions
import './src/graphql/enum/UserDefineKey';

export default class ApiServer {
  app: Express | undefined;

  server: http.Server | undefined;

  static async getPort(port: number | undefined): Promise<number> {
    return getPort({ port });
  }

  async start(
    config: IConfig,
    logger: LoggerService,
    port: number
  ): Promise<http.Server> {
    const pubSub = new PubSub();
    Container.set([{ id: ConfigToken, value: config }]);
    Container.set([{ id: PubSubToken, value: pubSub }]);
    Container.set([{ id: LoggerToken, value: logger }]);

    const platformio = new Platformio(config.env);
    Container.set(
      FirmwareService,
      new FirmwareService(
        config.PATH,
        config.firmwaresPath,
        platformio,
        new FirmwareBuilder(platformio),
        pubSub,
        logger
      )
    );

    const schema = await buildSchema({
      resolvers: [`${__dirname}/src/**/*.resolver.ts`],
      container: Container,
      pubSub,
    });
    const server = new ApolloServer({
      schema,
      debug: true,
      context: () => ({ config }),
    });
    this.app = express();
    server.applyMiddleware({
      app: this.app,
    });

    this.server = this.app.listen({ port });
    server.installSubscriptionHandlers(this.server);

    return this.server;
  }

  async stop(): Promise<void> {
    if (this.server === undefined) {
      throw new Error('server was not started');
    }
    return new Promise((resolve, reject) => {
      this.server?.close((err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }
}
