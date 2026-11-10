/**
 * DARKONYX PANEL — Database Compatibility Layer
 * ---------------------------------------------
 * The panel backend was written against MariaDB/MySQL. This module keeps that
 * exact SQL dialect working while letting the panel run with ZERO external
 * services (a bundled SQLite database, powered by Node's built-in `node:sqlite`).
 *
 *  - DB_DRIVER=sqlite  -> bundled, zero-config, default
 *  - DB_DRIVER=mysql   -> classic MariaDB/MySQL (mysql2)
 *
 * Everything the MySQL engine accepted is translated on the fly:
 * backticks, ENGINE/CHARSET clauses, inline KEY / CONSTRAINT definitions,
 * AUTO_INCREMENT, TINYINT(1), DATETIME/TIMESTAMP, DEFAULT CURRENT_TIMESTAMP,
 * ON DUPLICATE KEY UPDATE ... VALUES(col), DATE_ADD(NOW(), INTERVAL n DAY), ...
 */
const path = require('path');
const fs = require('fs');

/* ------------------------------------------------------------------ *
 *  Statement splitting (multi-statement exec support)
 * ------------------------------------------------------------------ */
function splitStatements(sql) {
  const out = [];
  let buf = '';
  let quote = null;

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    const next = sql[i + 1];

    // Line comments
    if (!quote && ch === '-' && next === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
      buf += '\n';
      continue;
    }
    if (!quote && ch === '#') {
      while (i < sql.length && sql[i] !== '\n') i++;
      buf += '\n';
      continue;
    }
    // Block comments
    if (!quote && ch === '/' && next === '*') {
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i++;
      continue;
    }

    if (quote) {
      if (ch === quote) {
        // handle doubled quote escaping ('')
        if (next === quote) {
          buf += ch + next;
          i++;
          continue;
        }
        quote = null;
      }
      buf += ch;
      continue;
    }

    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      buf += ch;
      continue;
    }

    if (ch === ';') {
      if (buf.trim()) out.push(buf.trim());
      buf = '';
      continue;
    }

    buf += ch;
  }

  if (buf.trim()) out.push(buf.trim());
  return out;
}

/* ------------------------------------------------------------------ *
 *  DDL translation  (MySQL schema  ->  SQLite schema)
 * ------------------------------------------------------------------ */
function translateDDL(sql) {
  let s = sql;

  /* ---- 1. timestamp defaults must be handled before generic types ---- */
  s = s.replace(
    /\bDEFAULT\s+CURRENT_TIMESTAMP\s*(?:\(\s*\))?(?:\s+ON\s+UPDATE\s+CURRENT_TIMESTAMP\s*(?:\(\s*\))?)?/gi,
    'DEFAULT (@@NOW_DEFAULT@@)'
  );
  s = s.replace(/\bON\s+UPDATE\s+CURRENT_TIMESTAMP\s*(?:\(\s*\))?/gi, '');

  /* ---- 2. table options ---- */
  s = s.replace(/\bENGINE\s*=\s*[\w]+/gi, '');
  s = s.replace(/\bDEFAULT\s+CHARSET\s*=\s*[\w]+/gi, '');
  s = s.replace(/\bCHARSET\s*=\s*[\w]+/gi, '');
  s = s.replace(/\bCHARACTER\s+SET\s+[\w]+/gi, '');
  s = s.replace(/\bCOLLATE\s*=?\s*[\w]+/gi, '');
  s = s.replace(/\bROW_FORMAT\s*=\s*\w+/gi, '');
  s = s.replace(/\bAUTO_INCREMENT\s*=\s*\d+/gi, '');

  /* ---- 3. inline indexes & foreign keys inside CREATE TABLE ---- */
  s = s.replace(/,?\s*(?:UNIQUE\s+)?(?:KEY|INDEX)\s+`?\w+`?\s*\([^)]*\)/gi, '');
  s = s.replace(
    /,?\s*(?:CONSTRAINT\s+`?\w+`?\s+)?FOREIGN\s+KEY\s*\([^)]*\)\s*REFERENCES\s*`?\w+`?\s*\([^)]*\)(?:\s+ON\s+(?:DELETE|UPDATE)\s+[A-Z ]+)*/gi,
    ''
  );

  /* ---- 4. column types (keep a trailing space so tokens stay separated) ---- */
  s = s.replace(/\b(LONGTEXT|MEDIUMTEXT|TINYTEXT)\b/gi, 'TEXT ');
  s = s.replace(/\bTINYINT\s*\(\s*\d+\s*\)/gi, 'INTEGER ');
  s = s.replace(/\b(DATETIME|TIMESTAMP)\b\s*\(\s*\d+\s*\)/gi, 'TEXT ');
  s = s.replace(/\b(DATETIME|TIMESTAMP)\b/gi, 'TEXT ');
  s = s.replace(/\b(TINYINT|SMALLINT|MEDIUMINT|BIGINT|INT|INTEGER)\b\s*(?:\(\s*\d+\s*\))?/gi, 'INTEGER ');
  s = s.replace(/\b(DOUBLE|FLOAT|DECIMAL|NUMERIC)\b\s*(?:\(\s*[\d,\s]+\s*\))?/gi, 'REAL ');
  s = s.replace(/\b(VARCHAR|CHAR)\s*\(\s*\d+\s*\)/gi, 'TEXT ');
  s = s.replace(/\b(JSON|ENUM\s*\([^)]*\))/gi, 'TEXT ');
  s = s.replace(/\bUNSIGNED\b/gi, '');
  s = s.replace(/\bAUTO_INCREMENT\b/gi, '');

  /* ---- 5. primary keys become SQLite rowid aliases ---- */
  s = s.replace(/\bINTEGER\s+PRIMARY\s+KEY\b(?!\s+AUTOINCREMENT)/gi, 'INTEGER PRIMARY KEY AUTOINCREMENT');

  /* ---- 6. restore the timestamp default expression ---- */
  s = s.replace(/@@NOW_DEFAULT@@/g, "datetime('now','localtime')");

  /* ---- 7. tidy up the leftovers ---- */
  s = s.replace(/,\s*,/g, ',');
  s = s.replace(/,\s*\)/g, ')');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

/* ------------------------------------------------------------------ *
 *  DML translation  (MySQL statements  ->  SQLite statements)
 * ------------------------------------------------------------------ */
function translateDML(sql) {
  let s = sql;

  // Date & time functions
  s = s.replace(/\bDATE_ADD\s*\(\s*(NOW\(\)|CURRENT_TIMESTAMP)\s*,\s*INTERVAL\s+(\d+)\s+(\w+)\s*\)/gi,
    (m, _n, num, unit) => `datetime('now','localtime','+${num} ${unit.toLowerCase()}')`);
  s = s.replace(/\bDATE_SUB\s*\(\s*(NOW\(\)|CURRENT_TIMESTAMP)\s*,\s*INTERVAL\s+(\d+)\s+(\w+)\s*\)/gi,
    (m, _n, num, unit) => `datetime('now','localtime','-${num} ${unit.toLowerCase()}')`);
  s = s.replace(/\bNOW\s*\(\s*\)/gi, "datetime('now','localtime')");
  s = s.replace(/\bCURDATE\s*\(\s*\)/gi, "date('now','localtime')");
  s = s.replace(/\bCURRENT_DATE\b/gi, "date('now','localtime')");
  s = s.replace(/\bUNIX_TIMESTAMP\s*\(\s*\)/gi, "strftime('%s','now')");
  s = s.replace(/\bDATE_FORMAT\s*\(([^,]+),\s*'%Y-%m-%d'\s*\)/gi, "date($1)");

  // ON DUPLICATE KEY UPDATE a = VALUES(a)  ->  ON CONFLICT DO UPDATE SET a = excluded.a
  if (/ON\s+DUPLICATE\s+KEY\s+UPDATE/i.test(s)) {
    s = s.replace(/\bVALUES\s*\(\s*([`"\w.]+)\s*\)/gi, (_m, col) => `excluded.${String(col).replace(/[`"]/g, '')}`);
    s = s.replace(/ON\s+DUPLICATE\s+KEY\s+UPDATE/gi, 'ON CONFLICT DO UPDATE SET');
  }

  // INSERT IGNORE -> INSERT OR IGNORE
  s = s.replace(/^\s*INSERT\s+IGNORE\b/i, 'INSERT OR IGNORE');

  // LIMIT a, b  ->  LIMIT b OFFSET a
  s = s.replace(/\bLIMIT\s+(\d+)\s*,\s*(\d+)/gi, 'LIMIT $2 OFFSET $1');

  return s;
}

function translate(sql) {
  const isDDL = /^\s*(CREATE|ALTER|DROP)\b/i.test(sql);
  return isDDL ? translateDDL(sql) : translateDML(sql);
}

/* ------------------------------------------------------------------ *
 *  Parameter normalisation
 * ------------------------------------------------------------------ */
function pad(n) { return String(n).padStart(2, '0'); }

function toSqliteValue(p) {
  if (p === undefined || p === null) return null;
  if (typeof p === 'boolean') return p ? 1 : 0;
  if (p instanceof Date) {
    return `${p.getFullYear()}-${pad(p.getMonth() + 1)}-${pad(p.getDate())} ${pad(p.getHours())}:${pad(p.getMinutes())}:${pad(p.getSeconds())}`;
  }
  if (typeof p === 'object') return JSON.stringify(p);
  if (typeof p === 'number' && !Number.isFinite(p)) return null;
  return p;
}

/* ------------------------------------------------------------------ *
 *  SQLite engine wrapper
 * ------------------------------------------------------------------ */
class SqliteEngine {
  constructor(dbFile) {
    const { DatabaseSync } = require('node:sqlite');
    fs.mkdirSync(path.dirname(dbFile), { recursive: true });
    this.file = dbFile;
    this.db = new DatabaseSync(dbFile);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = OFF');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.stmtCache = new Map();
  }

  prepare(sql) {
    let stmt = this.stmtCache.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      if (this.stmtCache.size > 400) this.stmtCache.clear();
      this.stmtCache.set(sql, stmt);
    }
    return stmt;
  }
}

const isReadStatement = (sql) =>
  /^\s*(SELECT|WITH|PRAGMA|EXPLAIN)\b/i.test(sql) || /\bRETURNING\b/i.test(sql);

class SqlitePoolAdapter {
  constructor(dbFile) {
    this.engine = new SqliteEngine(dbFile);
    this.dialect = 'sqlite';
  }

  /** mysql2-compatible: resolves to [rows, fields] */
  async query(rawSql, params = []) {
    let sql = String(rawSql || '').replace(/\\`/g, '`');

    // MySQL metadata probes used by the admin telemetry page
    if (/^\s*SHOW\s+(STATUS|VARIABLES)/i.test(sql)) {
      return [[{ Variable_name: 'Threads_connected', Value: 1 }], []];
    }
    if (/SELECT\s+VERSION\s*\(\s*\)/i.test(sql)) {
      return [[{ v: 'SQLite (Darkonyx embedded) ' + this.sqliteVersion() }], []];
    }

    sql = translate(sql);
    const bound = (Array.isArray(params) ? params : []).map(toSqliteValue);

    if (!isReadStatement(sql)) {
      const stmt = this.engine.prepare(sql);
      const info = stmt.run(...bound);
      return [{
        affectedRows: Number(info.changes || 0),
        changes: Number(info.changes || 0),
        insertId: info.lastInsertRowid !== undefined ? Number(info.lastInsertRowid) : null,
        lastID: info.lastInsertRowid !== undefined ? Number(info.lastInsertRowid) : null
      }, []];
    }

    const stmt = this.engine.prepare(sql);
    const rows = stmt.all(...bound).map((r) => ({ ...r }));
    return [rows, []];
  }

  async exec(sql) {
    const statements = splitStatements(String(sql || '').replace(/\\`/g, '`'));
    for (const statement of statements) {
      try { await this.pool.query(statement); } catch (e) { /* best effort DDL */ }
    }
  }

  sqliteVersion() {
    try {
      const row = this.engine.db.prepare('SELECT sqlite_version() AS v').get();
      return row ? row.v : '3';
    } catch (e) {
      return '3';
    }
  }

  async getConnection() {
    return {
      query: (sql, params) => this.query(sql, params),
      release: () => {},
      beginTransaction: async () => this.engine.db.exec('BEGIN'),
      commit: async () => this.engine.db.exec('COMMIT'),
      rollback: async () => this.engine.db.exec('ROLLBACK')
    };
  }

  async exec(sql) {
    const statements = splitStatements(String(sql || '').replace(/\\`/g, '`'));
    for (const statement of statements) {
      try {
        if (isReadStatement(statement)) {
          await this.query(statement);
        } else {
          this.engine.db.exec(translateDDL(statement));
        }
      } catch (err) {
        // DDL is intentionally best-effort (schema drift, duplicate columns...)
        if (/^\s*(CREATE|ALTER|DROP)\b/i.test(statement)) continue;
        throw err;
      }
    }
  }

  async end() {
    try { this.engine.db.close(); } catch (e) {}
  }
}

class MysqlPoolAdapter {
  constructor(mysqlPool) {
    this.pool = mysqlPool;
    this.dialect = 'mysql';
  }
  query(sql, params) { return this.pool.query(sql, params); }
  getConnection() { return this.pool.getConnection(); }
  async exec(sql) {
    for (const statement of splitStatements(sql)) {
      try { await this.pool.query(statement); } catch (e) { /* best effort DDL */ }
    }
  }
  async end() { try { await this.pool.end(); } catch (e) {} }
}

module.exports = {
  splitStatements,
  translate,
  translateDDL,
  translateDML,
  toSqliteValue,
  SqlitePoolAdapter,
  MysqlPoolAdapter
};
