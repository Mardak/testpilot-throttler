/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const {Cc,Ci,Cm,Cr,Cu} = require("chrome");
Cu.import("resource://gre/modules/AddonManager.jsm");
Cu.import("resource://gre/modules/Services.jsm");

const {defer} = require("sdk/core/promise");
const Prefs = require("sdk/preferences/service");
const {Request} = require("sdk/request");
const {setTimeout} = require("sdk/timers");
const {storage} = require("sdk/simple-storage");

const CACHE_DURATION = 1000 * 60 * 60 * 24;
const HOSTED_TEST_PARAMS = "https://people.mozilla.org/~elee/testpilot-throttler.json";
const IDLE_NOTIFICATION = "idle-daily";
const LOCALE_PREF = "general.useragent.locale";
const REQUIRED_PARAMS = ["distribution", "hash", "localeRegex", "threshold"];

// Hardcoded URLs of add-on XPIs must end with a ?query param to append "-#"
const ADDONS_TO_INSTALL = {
  "jid1-b6xdDZ3ld1nExQ@jetpack": "https://people.mozilla.org/~elee/user-profile-research.xpi?src=external-testpilot",
};

// Get the test params for a given add-on from storage or remote
function getTestParams(addonId) {
  let deferredParams = defer();

  // Give back the add-on's test params if all fields are there
  function resolvePromise() {
    let addonParams;
    try {
      addonParams = storage.cachedParams[addonId];

      // Make sure all params are available
      REQUIRED_PARAMS.forEach(param => {
        if (addonParams[param] == null) {
          console.log("Missing param", param, addonId);
          addonParams = null;
        }
      });
    }
    catch(ex) {}
    deferredParams.resolve(addonParams);
  }

  // Wrap remaining functionality in a callback to always return the promise
  setTimeout(() => {
    let {cachedTime} = storage;
    let now = Date.now();
    if (cachedTime != null) {
      let delta = now - cachedTime;
      console.log("Cached test params from", delta, "ms ago");
      if (delta < CACHE_DURATION) {
        console.log("Reusing cached test params");
        resolvePromise();
        return;
      }
    }

    // Only the first call triggers the request
    if (getTestParams.fetchPromise == null) {
      let deferredFetch = defer();
      getTestParams.fetchPromise = deferredFetch.promise;

      console.log("Fetching new test params", HOSTED_TEST_PARAMS);
      Request({
        url: HOSTED_TEST_PARAMS,
        onComplete: response => {
          // Cache the response for future/other use
          storage.cachedParams = response.json;
          storage.cachedTime = now;

          // Notify everyone waiting for test params
          deferredFetch.resolve();

          // Clear out the promise for future requests after cache expiration
          getTestParams.fetchPromise = null;
        },
      }).get();
    }

    console.log("Waiting for test params", addonId);
    getTestParams.fetchPromise.then(resolvePromise);
  });

  return deferredParams.promise;
}

// Go through each add-on and check against test params
function doInstallCheck() {
  // Check if we need to install each of the add-ons
  Object.keys(ADDONS_TO_INSTALL).forEach(addonId => {
    console.log("Checking for addon", addonId);
    AddonManager.getAddonByID(addonId, addon => {
      // Skip if we've already got the add-on installed
      if (addon != null) {
        console.log("Add-on already installed", addonId);
        return;
      }

      // Might need to install the add-on, so check metadata
      if (storage[addonId] == null) {
        console.log("Initializing local metadata", addonId);
        storage[addonId] = {
          randomizer: Math.random(),
          triggered: false,
        };
      }

      // Skip if throttler previously installed or attempted
      if (storage[addonId].triggered) {
        console.log("Add-on previously triggered install", addonId);
        return;
      }

      // Wait for additional test parameters that might be remotely hosted
      getTestParams(addonId).then(params => {
        if (params == null) {
          console.log("Missing test params", addonId);
          return;
        }

        let {distribution, hash, localeRegex, threshold} = params;
        console.log("Using params", JSON.stringify(params), addonId);

        let locale = Prefs.get(LOCALE_PREF);
        console.log("Checking locale:", locale, "regex:", localeRegex, addonId);
        if (!new RegExp("^" + localeRegex, "i").test(locale)) {
          console.log("Not selected because of locale", addonId);
          return;
        }

        let {randomizer} = storage[addonId];
        console.log("Checking rand:", randomizer, "thres:", threshold, addonId);
        if (randomizer > threshold) {
          console.log("Not selected for random participation", addonId);
          return;
        }

        // Remember that we passed the checks and will try to install
        storage[addonId].triggered = true;

        let addonUrl = ADDONS_TO_INSTALL[addonId] + "-" + distribution;
        console.log("Fetching AddonInstall", addonUrl, addonId);
        AddonManager.getInstallForURL(addonUrl, install => {
          if (install == null) {
            console.log("Null install object", addonId);
            return;
          }

          console.log("Installing add-on", addonId);
          install.install();
        }, "application/x-xpinstall", hash);
      });
    });
  });
}

exports.main = function() {
  // Check for installs when the add-on starts
  doInstallCheck();

  // Also check on idle
  Services.obs.addObserver(doInstallCheck, IDLE_NOTIFICATION, false);
};

exports.onUnload = function() {
  Services.obs.removeObserver(doInstallCheck, IDLE_NOTIFICATION);
};
