/**
 * The pure domain logic, re-exported.
 *
 * Nothing in this package may perform I/O or read the clock or randomness directly -
 * see the pure-core principle in `CLAUDE.md`. Every function that needs the time
 * takes it as an argument.
 *
 * Author: John Grimes
 */

export * from "./accounts/rules.js";
export * from "./checks/evaluate.js";
export * from "./events/rules.js";
export * from "./limits/slidingWindow.js";
export * from "./pairing/registrationFields.js";
export * from "./pairing/stateMachine.js";
