import pg from 'pg';
import fs from 'fs';

const { Pool } = pg;

/**
 * @class Db
 * @description thin wrapper around a pg.Pool, used by the queue store. A
 * single shared pool per process; pg itself manages connection lifecycle and
 * reconnection.
 */
class Db {

  /**
   * @param {Object} opts
   * @param {Object} opts.postgres connection options (host, port, user, password, database, schema, poolMax, statementTimeoutMs)
   */
  constructor(opts = {}) {
    let pgConfig = opts.postgres || {};
    this.schema = pgConfig.schema || 'queue';

    this.pool = new Pool({
      host: pgConfig.host,
      port: pgConfig.port,
      user: pgConfig.user,
      password: pgConfig.password,
      database: pgConfig.database,
      max: pgConfig.poolMax || 10,
      statement_timeout: pgConfig.statementTimeoutMs || 5000
    });
  }

  /**
   * @method query
   * @description run a parameterized query against the pool.
   *
   * @param {String} text sql text
   * @param {Array} [params=[]] query parameters
   * @returns {Promise<Object>} pg query result
   */
  query(text, params = []) {
    return this.pool.query(text, params);
  }

  /**
   * @method init
   * @description read a sql file, substitute the {{SCHEMA}} placeholder with
   * this instance's (already-validated-as-a-safe-identifier) schema name, and
   * execute it. Intended to be called once at startup.
   *
   * @param {String} sqlFilePath path to a .sql file containing a {{SCHEMA}} placeholder
   * @returns {Promise<void>}
   */
  async init(sqlFilePath) {
    let sql = fs.readFileSync(sqlFilePath, 'utf8');
    sql = sql.replaceAll('{{SCHEMA}}', this.schema);
    await this.query(sql);
  }

  /**
   * @method end
   * @description close the underlying connection pool.
   *
   * @returns {Promise<void>}
   */
  end() {
    return this.pool.end();
  }
}

export { Db };
