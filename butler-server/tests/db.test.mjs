import { afterAll, describe, expect, it } from 'vitest';
import { require, tempHome, cleanupHome } from './_setup.mjs';

const home = tempHome('db');
const { db, Db } = require('../server/db.cjs');

afterAll(() => {
  db.close();
  cleanupHome(home);
});

describe('node:sqlite 适配层(替代 better-sqlite3)', () => {
  it('建了这一刀要的表,没建 Aiboo 的其它表', () => {
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name);
    for (const t of ['avatars', 'avatar_assets', 'tts_models', 'rtc_providers', 'avatar_voice_bindings', 'logical_voice_mappings', 'app_settings']) {
      expect(names).toContain(t);
    }
    for (const t of ['users', 'llm_models', 'chat_messages', 'character_journeys', 'dj_programs']) {
      expect(names).not.toContain(t);
    }
  });

  it('@name 命名参数:对象里多余的键被忽略,undefined 绑成 NULL,布尔绑成 0/1', () => {
    const mem = new Db(':memory:');
    mem.exec('CREATE TABLE t (id TEXT, a INTEGER, b TEXT)');
    mem.prepare('INSERT INTO t (id, a, b) VALUES (@id, @a, @b)').run({ id: 'x', a: true, b: undefined, extra: 'ignored' });
    expect(mem.prepare('SELECT * FROM t WHERE id = ?').get('x')).toMatchObject({ id: 'x', a: 1, b: null });
    mem.close();
  });

  it('transaction:中途抛错整体回滚;嵌套事务用 SAVEPOINT', () => {
    const mem = new Db(':memory:');
    mem.exec('CREATE TABLE t (id TEXT PRIMARY KEY)');
    const ins = mem.prepare('INSERT INTO t (id) VALUES (?)');
    const outer = mem.transaction(() => {
      ins.run('a');
      const inner = mem.transaction(() => {
        ins.run('b');
        throw new Error('boom');
      });
      expect(() => inner()).toThrow('boom');
      // 内层回滚不影响外层已写的 a
      ins.run('c');
    });
    outer();
    expect(mem.prepare('SELECT id FROM t ORDER BY id').all().map((r) => r.id)).toEqual(['a', 'c']);
    expect(() => mem.transaction(() => { ins.run('d'); throw new Error('x'); })()).toThrow('x');
    expect(mem.prepare('SELECT COUNT(*) AS n FROM t').get().n).toBe(2);
    mem.close();
  });
});
