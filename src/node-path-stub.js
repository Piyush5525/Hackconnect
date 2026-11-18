// Stand-in for Node's "path" module: the Nexconn SDKs reference it on a Node-only branch that never runs in a browser.
export const resolve = (p) => p;
export default { resolve };
