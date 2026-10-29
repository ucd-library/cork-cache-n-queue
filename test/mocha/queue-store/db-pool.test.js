import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import config from '../../../src/lib/config.js';
import { Db } from '../../../src/lib/db/pool.js';

describe('Db (pg.Pool wrapper)', function () {
  this.timeout(20000);

  it('defaults the schema to "queue" when none is given', () => {
    let db = new Db({ postgres: { ...config.postgres, schema: undefined } });
    assert.strictEqual(db.schema, 'queue');
    return db.end();
  });

  it('query() passes parameters through to Postgres', async () => {
    let db = new Db({ postgres: config.postgres });
    try {
      let resp = await db.query('SELECT $1::int AS val', [42]);
      assert.strictEqual(resp.rows[0].val, 42);
    } finally {
      await db.end();
    }
  });

  it('init() substitutes {{SCHEMA}} with this instance\'s schema before executing', async () => {
    let throwawaySchema = 'ccnq_pool_test_' + Date.now();
    let db = new Db({ postgres: { ...config.postgres, schema: throwawaySchema } });

    let sqlFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ccnq-pool-test-')), 'init.sql');
    fs.writeFileSync(sqlFile, `
      CREATE SCHEMA IF NOT EXISTS {{SCHEMA}};
      CREATE TABLE IF NOT EXISTS {{SCHEMA}}.pool_test_table (id INT);
    `);

    try {
      await db.init(sqlFile);

      let resp = await db.query(
        `SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2`,
        [throwawaySchema, 'pool_test_table']
      );
      assert.strictEqual(resp.rows.length, 1, 'expected the table to exist under the substituted schema name');
    } finally {
      await db.query(`DROP SCHEMA IF EXISTS ${throwawaySchema} CASCADE`);
      await db.end();
    }
  });

  it('end() closes the pool, rejecting subsequent queries', async () => {
    let db = new Db({ postgres: config.postgres });
    await db.end();
    await assert.rejects(db.query('SELECT 1'));
  });
});
