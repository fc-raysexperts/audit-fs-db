import { cache } from 'react';
import { createContext } from '../../lib/server.mjs';

let ctx;
/** One server context for the whole process (settings are read once). */
export const getContext = () => (ctx ??= createContext());

/** The current view, read from Redis once per request even when the layout and the page both ask. */
export const getView = cache(() => getContext().view());
