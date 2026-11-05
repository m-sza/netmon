"use strict";

/* Chrome (Manifest V3) background entry point: a service worker can't list
 * several scripts in the manifest, so it loads the same ones Firefox does. */
importScripts("compat.js", "common.js", "background.js");
