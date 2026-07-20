/**
 * vendor/timer types its handle as `number | NodeJS.Timeout` (runtime is
 * platform-neutral). In the browser, timer handles ARE numbers, so alias the
 * namespace type to number instead of admitting @types/node.
 */
declare namespace NodeJS {
  type Timeout = number
}
