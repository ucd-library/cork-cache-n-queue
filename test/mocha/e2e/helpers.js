import http from 'http';

/**
 * @function startServer
 * @description start a bare Node http server (or an express app, which is
 * itself a valid request listener) on an ephemeral loopback port, for use as
 * either the app-under-test or a stub upstream origin in e2e tests.
 *
 * @param {Function} requestListener (req, res) => void
 * @returns {Promise<Object>} {server, url, close()}
 */
function startServer(requestListener) {
  return new Promise((resolve) => {
    let server = http.createServer(requestListener);
    server.listen(0, '127.0.0.1', () => {
      let { port } = server.address();
      resolve({
        server,
        url: `http://127.0.0.1:${port}`,
        // closeAllConnections first so a failed assertion earlier in a test
        // (leaving an in-flight connection open) can't cascade into a long
        // server.close() hang waiting for that connection to finish itself
        close: () => new Promise(resolve => {
          server.closeAllConnections();
          server.close(resolve);
        })
      });
    });
  });
}

export { startServer };
