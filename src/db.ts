/**
 * WebThings Gateway Database.
 *
 * Stores a list of Things connected to the gateway.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import config from 'config';
import {verbose, Database as SQLiteDatabase} from 'sqlite3';
import fs from 'fs';
import path from 'path';
import {TokenData} from './models/jsonwebtoken';
import User from './models/user';
import UserProfile from './user-profile';

const sqlite3 = verbose();

const TABLES = [
  'users',
  'jsonwebtokens',
  'things',
  'settings',
  'pushSubscriptions',
];

const DEBUG = false || (process.env.NODE_ENV === 'test');

class Database {
  /**
   * SQLite3 Database object.
   */
  private db?: SQLiteDatabase;

  /**
   * Open the database.
   */
  open(): void {
    // If the database is already open, just return.
    if (this.db) {
      return;
    }

    // Don't pull this from user-profile.js, because that would cause a
    // circular dependency.
    const filename = path.join(UserProfile.configDir, 'db.sqlite3');

    // Check if database already exists
    let exists = fs.existsSync(filename);
    const removeBeforeOpen = config.get('database.removeBeforeOpen');
    if (exists && removeBeforeOpen) {
      fs.unlinkSync(filename);
      exists = false;
    }

    console.log(exists ? 'Opening' : 'Creating', 'database:', filename);
    // Open database or create it if it doesn't exist
    this.db = new sqlite3.Database(filename);

    // Set a timeout in case the database is locked. 10 seconds is a bit long,
    // but it's better than crashing.
    this.db.configure('busyTimeout', 10000);

    this.db.serialize(() => {
      this.createTables();
      this.migrate();
      // If database newly created, populate with default data
      if (!exists) {
        this.populate();
      }
    });
  }

  createTables(): void {
    // Create Things table
    this.db!.run('CREATE TABLE IF NOT EXISTS things (' +
      'id TEXT PRIMARY KEY,' +
      'description TEXT' +
    ');');

    // Create Users table
    this.db!.run('CREATE TABLE IF NOT EXISTS users (' +
      'id INTEGER PRIMARY KEY ASC,' +
      'email TEXT UNIQUE,' +
      'password TEXT,' +
      'name TEXT,' +
      'mfaSharedSecret TEXT,' +
      'mfaEnrolled BOOLEAN DEFAULT 0,' +
      'mfaBackupCodes TEXT' +
    ');');

    /**
     * This really should have a foreign key constraint but it does not work
     * with our version of node-sqlite / sqlite.
     *
     * https://github.com/mapbox/node-sqlite3/pull/660
     *
     * Instead, the INTEGER user is either the id of the user or -1 if NULL
     */
    this.db!.run('CREATE TABLE IF NOT EXISTS jsonwebtokens (' +
      'id INTEGER PRIMARY KEY ASC,' +
      'keyId TEXT UNIQUE,' + // public id (kid in JWT terms).
      'user INTEGER,' +
      'issuedAt DATE,' +
      'publicKey TEXT,' +
      'payload TEXT' +
    ');');

    // Create Settings table
    this.db!.run('CREATE TABLE IF NOT EXISTS settings (' +
      'key TEXT PRIMARY KEY,' +
      'value TEXT' +
    ');');

    this.db!.run(`CREATE TABLE IF NOT EXISTS pushSubscriptions (
      id INTEGER PRIMARY KEY,
      subscription TEXT UNIQUE
    );`);
  }

  /**
   * Do anything necessary to migrate from old database schemas.
   */
  migrate(): void {
    /* eslint-disable @typescript-eslint/no-empty-function */
    this.db!.run('DROP TABLE IF EXISTS jsonwebtoken_to_user', () => {});
    this.db!.run('ALTER TABLE users ADD COLUMN mfaSharedSecret TEXT', () => {});
    this.db!.run('ALTER TABLE users ADD COLUMN mfaEnrolled BOOLEAN DEFAULT 0', () => {});
    this.db!.run('ALTER TABLE users ADD COLUMN mfaBackupCodes TEXT', () => {});
    /* eslint-enable @typescript-eslint/no-empty-function */
  }

  /**
   * Populate the database with default data.
   */
  populate(): void {
    // Add any settings provided.
    const generateSettings = (obj: any, baseKey: string): any => {
      const settings = [];

      for (const key in obj) {
        let newKey;
        if (baseKey !== '') {
          newKey = `${baseKey}.${key}`;
        } else {
          newKey = key;
        }

        if (typeof obj[key] === 'object') {
          settings.push(...generateSettings(obj[key], newKey));
        } else {
          settings.push([newKey, obj[key]]);
        }
      }
      return settings;
    };

    const settings = generateSettings(config.get('settings.defaults'), '');
    for (const setting of settings) {
      this.db!.run(
        'INSERT INTO settings (key, value) VALUES (?, ?)',
        [setting[0], setting[1]],
        (error) => {
          if (error) {
            console.error(`Failed to insert setting ${
              setting[0]}`);
          } else if (DEBUG) {
            console.log(`Saved setting ${setting[0]} = ${
              setting[1]}`);
          }
        }
      );
    }
  }

  /**
   * Get all Things stored in the database.
   *
   * @return Promise which resolves with a list of Thing objects.
   */
  getThings(): Promise<any[]> {
    return new Promise((resolve, reject) => {
      this.db!.all(
        'SELECT id, description FROM things',
        ((err, rows) => {
          if (err) {
            reject(err);
          } else {
            const things = [];
            for (const row of rows) {
              const thing = JSON.parse(row.description);
              thing.id = row.id;
              things.push(thing);
            }
            resolve(things);
          }
        }));
    });
  }

  /**
   * Add a new Thing to the Database.
   *
   * @param String id The ID to give the new Thing.
   * @param String description A serialised Thing description.
   */
  createThing<T>(id: string, description: T): Promise<T> {
    return new Promise((resolve, reject) => {
      const db = this.db!;
      db.run(
        'INSERT INTO things (id, description) VALUES (?, ?)',
        [id, JSON.stringify(description)],
        (error) => {
          if (error) {
            reject(error);
          } else {
            resolve(description);
          }
        });
    });
  }

  /**
   * Update a Thing in the Database.
   *
   * @param String id ID of the thing to update.
   * @param String description A serialised Thing description.
   */
  updateThing<T>(id: string, description: T): Promise<T> {
    return new Promise((resolve, reject) => {
      const db = this.db!;
      db.run(
        'UPDATE things SET description=? WHERE id=?',
        [JSON.stringify(description), id],
        (error) => {
          if (error) {
            reject(error);
          } else {
            resolve(description);
          }
        });
    });
  }

  /**
   * Remove a Thing from the Database.
   *
   * @param String id The ID of the Thing to remove.
   */
  removeThing(id: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const db = this.db!;
      db.run('DELETE FROM things WHERE id = ?', id, (error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * Get a user by their email address.
   */
  getUser(email: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const db = this.db!;
      db.get(
        'SELECT * FROM users WHERE email = ?',
        email,
        (error, row) => {
          if (error) {
            reject(error);
          } else {
            resolve(row);
          }
        });
    });
  }

  /**
   * Get a user by it's primary key (id).
   */
  async getUserById(id: number): Promise<any> {
    return await this.get(
      'SELECT * FROM users WHERE id = ?',
      id
    );
  }

  /**
   * Get all Users stored in the database.
   *
   * @return {Promise<Array<User>>} resolves with a list of User objects
   */
  getUsers(): Promise<any[]> {
    return new Promise((resolve, reject) => {
      this.db!.all('SELECT * FROM users', (err, rows) => {
        if (err) {
          reject(err);
        } else {
          resolve(rows);
        }
      });
    });
  }

  async getUserCount(): Promise<number> {
    const {count} = <{count: number}>(await this.get('SELECT count(*) as count FROM users'));
    return count;
  }

  /**
   * Get a setting or return undefined
   * @param {String} key
   * @return {Promise<Object?>} value
   */
  async getSetting(key: string): Promise<any> {
    const res = await this.get('SELECT value FROM settings WHERE key=?', key);
    if (DEBUG) {
      console.log('getSetting', key, res);
    }

    if (!res) {
      return;
    }

    const {value} = <{value?: string}>res;
    if (typeof value === 'undefined') {
      return value;
    } else {
      return JSON.parse(value);
    }
  }

  /**
   * Set a setting. Assumes that the only access to the database is
   * single-threaded.
   *
   * @param {String} key
   * @param {Object} value
   * @return {Promise}
   */
  async setSetting(key: string, value: any): Promise<any> {
    value = JSON.stringify(value);
    const currentValue = await this.getSetting(key);
    if (typeof currentValue === 'undefined') {
      return this.run('INSERT INTO settings (key, value) VALUES (?, ?)',
                      [key, value]);
    } else {
      return this.run('UPDATE settings SET value=? WHERE key=?', [value, key]);
    }
  }

  /**
   * Remove a setting. Assumes that the only access to the database is
   * single-threaded.
   *
   * @param {String} key
   * @return {Promise}
   */
  async deleteSetting(key: string): Promise<void> {
    this.run('DELETE FROM settings WHERE key = ?', [key]);
  }

  /**
   * Create a user
   * @param {User} user
   * @return {Promise<User>}
   */
  async createUser(user: User): Promise<number> {
    const result = await this.run(
      'INSERT INTO users ' +
      '(email, password, name, mfaSharedSecret, mfaEnrolled, mfaBackupCodes) ' +
      'VALUES (?, ?, ?, ?, ?, ?)',
      [
        user.getEmail(),
        user.getPassword(),
        user.getName(),
        user.getMfaSharedSecret(),
        user.getMfaEnrolled(),
        JSON.stringify(user.getMfaBackupCodes() || '[]'),
      ]
    );
    return (result as any).lastID;
  }

  /**
   * Edit a user.
   * @param {User} user
   * @return Promise that resolves when operation is complete.
   */
  async editUser(user: User): Promise<any> {
    return this.run(
      'UPDATE users SET ' +
      'email=?, password=?, name=?, mfaSharedSecret=?, mfaEnrolled=?, ' +
      'mfaBackupCodes=? WHERE id=?',
      [
        user.getEmail(),
        user.getPassword(),
        user.getName(),
        user.getMfaSharedSecret(),
        user.getMfaEnrolled(),
        JSON.stringify(user.getMfaBackupCodes() || '[]'),
        user.getId(),
      ]
    );
  }

  /**
   * Delete a user.
   * @param {Number} userId
   * @return Promise that resolves when operation is complete.
   */
  deleteUser(userId: number): Promise<any[]> {
    const deleteUser = this.run(
      'DELETE FROM users WHERE id = ?',
      [userId]
    );
    const deleteTokens = this.deleteJSONWebTokensForUser(userId);
    /**
     * XXX: This is a terrible hack until we get foreign key constraint support
     * turned on with node-sqlite. As is this could leave junk around in the db.
     */
    return Promise.all([deleteTokens, deleteUser]);
  }

  /**
   * Delete all jsonwebtoken's for a given user.
   */
  deleteJSONWebTokensForUser(userId: number): Promise<any> {
    return this.run(
      'DELETE FROM jsonwebtokens WHERE user = ?',
      [userId]
    );
  }

  /**
   * Insert a JSONWebToken into the database
   * @param {JSONWebToken} token
   * @return {Promise<number>} resolved to JWT's primary key
   */
  async createJSONWebToken(token: TokenData): Promise<number> {
    const result = await this.run(
      'INSERT INTO jsonwebtokens (keyId, user, issuedAt, publicKey, payload) ' +
      'VALUES (?, ?, ?, ?, ?)',
      [
        token.keyId,
        token.user,
        token.issuedAt,
        token.publicKey,
        JSON.stringify(token.payload),
      ]
    );
    return (result as any).lastID;
  }

  /**
   * Get a JWT by its key id.
   * @param {string} keyId
   * @return {Promise<Object>} jwt data
   */
  getJSONWebTokenByKeyId(keyId: string): Promise<any> {
    return this.get(
      'SELECT * FROM jsonwebtokens WHERE keyId = ?',
      keyId
    );
  }

  /**
   * Get all known JWTs of a user
   * @param {number} userId
   * @return {Promise<Array<Object>>}
   */
  getJSONWebTokensByUser(userId: number): Promise<any[]> {
    return new Promise((resolve, reject) => {
      this.db!.all(
        'SELECT * FROM jsonwebtokens WHERE user = ?',
        [userId],
        (err, rows) => {
          if (err) {
            reject(err);
          } else {
            resolve(rows);
          }
        });
    });
  }

  /**
   * Delete a JWT by it's key id.
   * @param {string} keyId
   * @return {Promise<boolean>} whether deleted
   */
  async deleteJSONWebTokenByKeyId(keyId: string): Promise<boolean> {
    const result = await this.run(
      'DELETE FROM jsonwebtokens WHERE keyId = ?',
      [keyId]
    );
    return (result as any).changes !== 0;
  }

  /**
   * Store a new Push subscription
   * @param {Object} subscription
   * @return {Promise<number>} resolves to sub id
   */
  createPushSubscription(desc: any): Promise<number> {
    const description = JSON.stringify(desc);

    const insert = () => {
      return this.run(
        'INSERT INTO pushSubscriptions (subscription) VALUES (?)',
        [description]
      ).then((res) => {
        return parseInt((res as any).lastID);
      });
    };

    return this.get(
      'SELECT id FROM pushSubscriptions WHERE subscription = ?',
      description
    ).then((res) => {
      if (typeof res === 'undefined') {
        return insert();
      }

      return (res as any).id;
    }).catch(() => {
      return insert();
    });
  }

  /**
   * Get all push subscriptions
   * @return {Promise<Array<PushSubscription>>}
   */
  getPushSubscriptions(): Promise<any[]> {
    return new Promise((resolve, reject) => {
      this.db!.all(
        'SELECT id, subscription FROM pushSubscriptions',
        [],
        (err, rows) => {
          if (err) {
            reject(err);
            return;
          }
          const subs = [];
          for (const row of rows) {
            const sub = JSON.parse(row.subscription);
            sub.id = row.id;
            subs.push(sub);
          }
          resolve(subs);
        }
      );
    });
  }

  /**
   * Delete a single subscription
   * @param {number} id
   */
  deletePushSubscription(id: string): Promise<any> {
    return this.run('DELETE FROM pushSubscriptions WHERE id = ?', [id]);
  }

  /**
   * ONLY for tests (clears all tables).
   */
  async deleteEverything(): Promise<any[]> {
    return Promise.all(TABLES.map((t) => {
      return this.run(`DELETE FROM ${t}`, []);
    }));
  }

  get(sql: string, ...params: any[]): Promise<any> {
    return new Promise((resolve, reject) => {
      params.push((err: unknown, row: any) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(row);
      });

      try {
        this.db!.get(sql, ...params);
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Run a SQL statement
   * @param {String} sql
   * @param {Array<any>} values
   * @return {Promise<Object>} promise resolved to `this` of statement result
   */
  run(sql: string, values: any[]): Promise<any> {
    return new Promise((resolve, reject) => {
      try {
        this.db!.run(sql, values, function(err) {
          if (err) {
            reject(err);
            return;
          }
          // node-sqlite puts results on "this" so avoid arrrow fn.
          resolve(this);
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  all(sql: string, values: any[], callback?: (this: any, err: Error|null, rows: any[]) => void):
  void {
    this.db!.all(sql, values, callback);
  }
}

const db = new Database();
export default db;
