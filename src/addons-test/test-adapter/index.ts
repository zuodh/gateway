/**
 * test-adapter.ts - Adapter for testing portions of the the
 *                   AddonManager.loadAddons.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import {Adapter, AddonManagerProxy} from 'gateway-addon';

class TestAdapter extends Adapter {
  constructor(addonManager: AddonManagerProxy, packageName: string) {
    super(addonManager, packageName, packageName);
    addonManager.addAdapter(this);
  }
}

function loadTestAdapter(addonManager: AddonManagerProxy, manifest: any): void {
  new TestAdapter(addonManager, manifest.name);
}

export = loadTestAdapter;
