/**
 * The /api URL prefix — single source for both halves of the web transport.
 * The node half registers this prefix on the web server; browser-side path
 * literals currently live in the apiproxy client layer (out of scope here).
 */

/** Route prefix owning every api request (`/api` and `/api/<anything>`). */
export const API_PATH = '/api'
