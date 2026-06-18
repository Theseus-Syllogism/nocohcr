// Stub: Blindvault ships no React. Shoelace's *.react.js wrappers are never
// loaded by the autoloader, so these are import-map placeholders only.
const noop = () => {};
export const createElement = () => null;
export const forwardRef = (c) => c;
export const useImperativeHandle = noop;
export const useLayoutEffect = noop;
export const useEffect = noop;
export const useState = (v) => [v, noop];
export const useRef = () => ({ current: null });
export const Fragment = Symbol.for("react.fragment");
export default { createElement, forwardRef, useImperativeHandle, useLayoutEffect, useEffect, useState, useRef, Fragment };
