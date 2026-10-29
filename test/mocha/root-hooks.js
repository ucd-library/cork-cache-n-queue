import { execFile } from 'child_process';
import { promisify } from 'util';
import pg from 'pg';
import path from 'path';
import { fileURLToPath } from 'url';
import config from '../../src/lib/config.js';
import { Db } from '../../src/lib/db/pool.js';

const { Client } = pg;
const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SQL_FILE = path.join(__dirname, '..', '..', 'sql', '001-queue.sql');

const POSTGRES_IMAGE = process.env.CCNQ_TEST_POSTGRES_IMAGE || 'postgres:16';
const POSTGRES_USER = 'postgres';
const POSTGRES_PASSWORD = 'postgres';
const POSTGRES_DATABASE = 'ccnq_test';
const CONTAINER_NAME = `ccnq-test-postgres-${process.pid}-${Date.now()}`;

let containerName = null;

/**
 * @function docker
 * @description run a docker CLI command.
 *
 * @param {Array<String>} args
 * @returns {Promise<Object>} {stdout, stderr}
 */
async function docker(args) {
  return execFileAsync('docker', args, { maxBuffer: 1024 * 1024 });
}

/**
 * @function getPublishedPort
 * @description resolve the host port docker published for the container's
 * postgres port.
 *
 * @param {String} name container name
 * @returns {Promise<String>}
 */
async function getPublishedPort(name) {
  let { stdout } = await docker(['port', name, '5432/tcp']);
  let endpoint = stdout.trim().split('\n')[0];
  let match = endpoint.match(/:(\d+)$/);
  if (!match) throw new Error(`Could not parse Postgres port from docker output: ${stdout}`);
  return match[1];
}

/**
 * @function applyConnectionConfig
 * @description point the app's shared config object at the ephemeral test
 * Postgres instance.
 *
 * @param {String} port resolved host port
 * @returns {void}
 */
function applyConnectionConfig(port) {
  Object.assign(config.postgres, {
    host: '127.0.0.1',
    port: Number(port),
    user: POSTGRES_USER,
    password: POSTGRES_PASSWORD,
    database: POSTGRES_DATABASE
  });
}

/**
 * @function waitForPostgres
 * @description poll until the test Postgres instance accepts connections.
 *
 * @returns {Promise<void>}
 */
async function waitForPostgres() {
  let deadline = Date.now() + 45000;
  let lastError;

  while (Date.now() < deadline) {
    let client = new Client({
      host: config.postgres.host,
      port: config.postgres.port,
      user: config.postgres.user,
      password: config.postgres.password,
      database: config.postgres.database
    });

    try {
      await client.connect();
      await client.query('SELECT 1');
      await client.end();
      return;
    } catch (err) {
      lastError = err;
      try { await client.end(); } catch (endErr) { /* still starting up */ }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  throw new Error(`Timed out waiting for test Postgres to start: ${lastError?.message || 'unknown error'}`);
}

/**
 * @function stopPostgres
 * @description stop the ephemeral test Postgres container.
 *
 * @returns {Promise<void>}
 */
async function stopPostgres() {
  if (!containerName) return;
  let name = containerName;
  containerName = null;
  await docker(['stop', name]);
}

export const mochaHooks = {
  async beforeAll() {
    this.timeout(60000);

    try {
      await docker([
        'run',
        '--rm',
        '--detach',
        '--name', CONTAINER_NAME,
        '--env', `POSTGRES_USER=${POSTGRES_USER}`,
        '--env', `POSTGRES_PASSWORD=${POSTGRES_PASSWORD}`,
        '--env', `POSTGRES_DB=${POSTGRES_DATABASE}`,
        '--publish', '127.0.0.1::5432',
        '--tmpfs', '/var/lib/postgresql/data:rw,size=512m',
        POSTGRES_IMAGE
      ]);
      containerName = CONTAINER_NAME;

      let port = await getPublishedPort(containerName);
      applyConnectionConfig(port);
      await waitForPostgres();

      let db = new Db({ postgres: config.postgres });
      await db.init(SQL_FILE);
      await db.end();
    } catch (err) {
      await stopPostgres().catch(() => {});
      throw new Error(`Failed to start Docker Postgres for tests: ${err.message}`);
    }
  },

  async afterAll() {
    this.timeout(30000);
    await stopPostgres();
  }
};
