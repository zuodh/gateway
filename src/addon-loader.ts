/*
 * Add-on Loader app.
 *
 * This app will load an add-on as a standalone process.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import {loadManifest} from './addon-utils';
import config from 'config';
import Getopt from 'node-getopt';
import {AddonManagerProxy, Constants, PluginClient} from 'gateway-addon';
import Database from './db';
import * as Settings from './models/settings';
import sleep from './sleep';
import path from 'path';
import {spawnSync} from 'child_process';
import fs from 'fs';

// Open the database.
if (process.env.NODE_ENV !== 'test') {
  // In test mode, we have a flag set to remove the database when it's opened.
  // Therefore, we need to manually load settings and such, rather than using
  // the normal db functions, in order to prevent removing the already open
  // database.
  Database.open();
}

async function loadAddon(addonPath: string, verbose: boolean): Promise<void> {
  const packageName = path.basename(addonPath);

  // Get any saved settings for this add-on.
  const key = `addons.${packageName}`;
  const configKey = `addons.config.${packageName}`;

  let obj: any, savedConfig: any;
  if (process.env.NODE_ENV === 'test') {
    [obj, savedConfig] = loadManifest(addonPath.split('/').pop()!);
  } else {
    obj = await Settings.getSetting(key);
  }

  const newSettings: any = {
    name: obj.id,
    display_name: obj.name,
    moziot: {
      exec: obj.exec,
    },
  };

  if (obj.schema) {
    newSettings.moziot.schema = obj.schema;
  }

  if (process.env.NODE_ENV !== 'test') {
    savedConfig = await Settings.getSetting(configKey);
  }

  if (savedConfig) {
    newSettings.moziot.config = savedConfig;
  } else {
    newSettings.moziot.config = {};
  }

  const pluginClient = new PluginClient(
    packageName,
    {verbose}
  );

  return pluginClient.register(config.get('ports.ipc'))
    .catch((e) => {
      throw new Error(
        `Failed to register add-on ${packageName} with gateway: ${e}`
      );
    })
    .then((addonManagerProxy) => {
      if (!(addonManagerProxy instanceof AddonManagerProxy)) {
        console.error(`Failed to load add-on ${packageName}`);
        process.exit(Constants.DONT_RESTART_EXIT_CODE);
      }

      console.log(`Loading add-on ${packageName} from ${addonPath}`);
      try {
        // we try to link to a global gateway-addon module, because in some
        // cases, NODE_PATH seems to not work
        const modulePath = path.join(
          addonPath,
          'node_modules',
          'gateway-addon'
        );
        if (!fs.existsSync(modulePath) && process.env.NODE_ENV !== 'test') {
          const link = spawnSync(
            'npm',
            ['link', 'gateway-addon'],
            {
              cwd: addonPath,
            }
          );

          if (link.error) {
            console.log(`Failed to npm-link the gateway-addon package: ${link.error}`);
          }
        }

        const addonLoader = require(addonPath);
        addonLoader(addonManagerProxy, newSettings, (packageName: string, err: any) => {
          console.error(`Failed to start add-on ${packageName}:`, err);
          fail(
            addonManagerProxy,
            `Failed to start add-on ${obj.name}: ${err}`
          );
        });

        pluginClient.on('unloaded', () => {
          sleep(500).then(() => process.exit(0));
        });
      } catch (e) {
        console.error(e);
        const message = `Failed to start add-on ${obj.name}: ${
          e.toString().replace(/^Error:\s+/, '')}`;
        fail(addonManagerProxy, message);
      }
    });
}

async function fail(addonManagerProxy: AddonManagerProxy, message: string): Promise<void> {
  addonManagerProxy.sendError(message);
  await sleep(200);
  addonManagerProxy.unloadPlugin();
  await sleep(200);
  process.exit(Constants.DONT_RESTART_EXIT_CODE);
}

// Get some decent error messages for unhandled rejections. This is
// often just errors in the code.
process.on('unhandledRejection', (reason) => {
  console.log('Unhandled Rejection');
  console.error(reason);
});

// Command line arguments
const getopt = new Getopt([
  ['h', 'help', 'Display help' ],
  ['v', 'verbose', 'Show verbose output'],
]);

const opt = getopt.parseSystem();

if (opt.options.verbose) {
  console.log(opt);
}

if (opt.options.help) {
  getopt.showHelp();
  process.exit(Constants.DONT_RESTART_EXIT_CODE);
}

if (opt.argv.length != 1) {
  console.error('Expecting a single package to load');
  process.exit(Constants.DONT_RESTART_EXIT_CODE);
}
const addonPath = opt.argv[0];

loadAddon(addonPath, !!opt.options.verbose).catch((err) => {
  console.error(err);
  process.exit(Constants.DONT_RESTART_EXIT_CODE);
});
