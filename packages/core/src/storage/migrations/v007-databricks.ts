import type { Database } from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration: Migration = {
    version: 7,
    up(db: Database): void {
        db.exec(`
      ALTER TABLE app_settings
      ADD COLUMN databricks_config TEXT
    `);
        console.log('[v007] Added databricks_config column');
    },
    down(db: Database): void {
        db.exec(`
      ALTER TABLE app_settings
      DROP COLUMN databricks_config
    `);
        console.log('[v007] Removed databricks_config column');
    },
};
