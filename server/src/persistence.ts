/**
 * Where accounts and per-user data are stored.
 *  - DATABASE_URL set  -> PostgreSQL (two tables: users, and user_data with one JSONB document per user)
 *  - otherwise         -> JSON files in server/data/ (zero setup, fine for local use)
 * Everything is loaded into memory once at startup and written back as it changes, so this suits one server instance.
 */
import fs from 'fs';
import path from 'path';
import { config } from './config';

export interface UserRecord {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
  verified: boolean;
  tokenVersion: number;
  createdAt: string;
}

export interface Persistence {
  readonly mode: 'file' | 'postgres';
  init(): Promise<void>;
  loadUsers(): Promise<UserRecord[]>;
  saveUser(u: UserRecord): Promise<void>;
  loadAllUserData(): Promise<Map<string, any>>;
  saveUserData(userId: string, json: string): Promise<void>;
  /** A short human-readable status line (used by `npm run check`). */
  ping(): Promise<string>;
}

// ---- JSON files ------------------------------------------------------------------------------------------

class FilePersistence implements Persistence {
  readonly mode = 'file' as const;
  private users = new Map<string, UserRecord>();
  private usersFile = path.join(config.dataDir, 'users.json');
  private storesDir = path.join(config.dataDir, 'stores');
  private fileFor = (id: string) => path.join(this.storesDir, `${id.replace(/[^a-zA-Z0-9_-]/g, '')}.json`);

  async init() {
    fs.mkdirSync(this.storesDir, { recursive: true });
    try {
      for (const u of JSON.parse(fs.readFileSync(this.usersFile, 'utf8')) as UserRecord[]) this.users.set(u.id, u);
    } catch {
      /* no users yet */
    }
  }
  async loadUsers() {
    return [...this.users.values()];
  }
  async saveUser(u: UserRecord) {
    this.users.set(u.id, u);
    fs.writeFileSync(this.usersFile, JSON.stringify([...this.users.values()], null, 2));
  }
  async loadAllUserData() {
    const out = new Map<string, any>();
    try {
      for (const f of fs.readdirSync(this.storesDir)) {
        if (!f.endsWith('.json')) continue;
        try {
          out.set(f.slice(0, -5), JSON.parse(fs.readFileSync(path.join(this.storesDir, f), 'utf8')));
        } catch {
          console.warn(`[files] skipped unreadable ${f}`);
        }
      }
    } catch {
      /* nothing saved yet */
    }
    return out;
  }
  async saveUserData(userId: string, json: string) {
    fs.mkdirSync(this.storesDir, { recursive: true });
    const f = this.fileFor(userId);
    fs.writeFileSync(f + '.tmp', json);
    fs.renameSync(f + '.tmp', f);
  }
  async ping() {
    return `JSON files in ${config.dataDir}`;
  }
}

// ---- PostgreSQL ------------------------------------------------------------------------------------------

class PgPersistence implements Persistence {
  readonly mode = 'postgres' as const;
  private pool: any;

  async init() {
    const pg: any = await import('pg');
    const Pool = pg.Pool ?? pg.default?.Pool;
    const local = /localhost|127\.0\.0\.1/.test(config.databaseUrl);
    this.pool = new Pool({
      connectionString: config.databaseUrl,
      ssl: local ? undefined : { rejectUnauthorized: false }, // hosted databases (Neon, Supabase, Render) require TLS
      max: 5,
      connectionTimeoutMillis: 15_000,
    });
    try {
      await this.pool.query(`CREATE TABLE IF NOT EXISTS users (
        id text PRIMARY KEY,
        email text UNIQUE NOT NULL,
        name text NOT NULL,
        password_hash text NOT NULL,
        verified boolean NOT NULL DEFAULT false,
        token_version integer NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
      await this.pool.query(`CREATE TABLE IF NOT EXISTS user_data (
        user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        data jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      )`);
    } catch (e: any) {
      throw new Error(`Could not connect to the database. Check DATABASE_URL. (${String(e?.message ?? e).slice(0, 160)})`);
    }
  }
  async loadUsers() {
    const r = await this.pool.query('SELECT id, email, name, password_hash, verified, token_version, created_at FROM users');
    return r.rows.map((row: any) => ({
      id: row.id,
      email: row.email,
      name: row.name,
      passwordHash: row.password_hash,
      verified: row.verified,
      tokenVersion: row.token_version,
      createdAt: new Date(row.created_at).toISOString(),
    }));
  }
  async saveUser(u: UserRecord) {
    await this.pool.query(
      `INSERT INTO users (id, email, name, password_hash, verified, token_version, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO UPDATE SET
         email = EXCLUDED.email, name = EXCLUDED.name, password_hash = EXCLUDED.password_hash,
         verified = EXCLUDED.verified, token_version = EXCLUDED.token_version`,
      [u.id, u.email, u.name, u.passwordHash, u.verified, u.tokenVersion, u.createdAt],
    );
  }
  async loadAllUserData() {
    const r = await this.pool.query('SELECT user_id, data FROM user_data');
    return new Map<string, any>(r.rows.map((row: any) => [row.user_id, row.data]));
  }
  async saveUserData(userId: string, json: string) {
    await this.pool.query(
      `INSERT INTO user_data (user_id, data, updated_at) VALUES ($1, $2::jsonb, now())
       ON CONFLICT (user_id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
      [userId, json],
    );
  }
  async ping() {
    const r = await this.pool.query('SELECT count(*)::int AS n FROM users');
    return `${r.rows[0].n} user(s) stored`;
  }
}

export const persistence: Persistence = config.databaseUrl ? new PgPersistence() : new FilePersistence();
