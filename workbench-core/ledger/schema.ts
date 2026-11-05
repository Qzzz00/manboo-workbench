/**
 * 表结构(v3 §5.2.6 乙案:一个库,一次提交 = 一个事务)。
 *
 * events / request_log / outbox 是账本身;objects / deliveries / asks 是从 events 折出来的视图,
 * 在同一个事务里随事件一起写,也可以 rebuildViews 从事件重算。
 */
export const SCHEMA_VERSION = 1

export const DDL = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS events (
  seq            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts             INTEGER NOT NULL,
  topic          TEXT    NOT NULL,
  object_id      TEXT,
  object_version INTEGER,
  kind           TEXT    NOT NULL,
  actor          TEXT    NOT NULL,
  evidence       TEXT,
  request_id     TEXT,
  payload        TEXT    NOT NULL,
  origin_device  TEXT    NOT NULL,
  origin_seq     INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS events_origin  ON events(origin_device, origin_seq);
CREATE INDEX        IF NOT EXISTS events_object  ON events(object_id, seq) WHERE object_id IS NOT NULL;
CREATE INDEX        IF NOT EXISTS events_request ON events(request_id) WHERE request_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS request_log (
  request_id TEXT PRIMARY KEY,
  op         TEXT,
  device_id  TEXT,
  person     TEXT,
  ok         INTEGER NOT NULL,
  result     TEXT    NOT NULL,
  seq        INTEGER,
  ts         INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS objects (
  object_id   TEXT PRIMARY KEY,
  owner       TEXT    NOT NULL,
  owner_epoch INTEGER NOT NULL,
  version     INTEGER NOT NULL,
  status      TEXT,
  data        TEXT    NOT NULL,
  legacy_id   TEXT,
  created_seq INTEGER NOT NULL,
  updated_seq INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS objects_legacy ON objects(legacy_id) WHERE legacy_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS deliveries (
  delivery_id TEXT PRIMARY KEY,
  object_id   TEXT    NOT NULL,
  n           INTEGER NOT NULL,
  family      TEXT    NOT NULL,
  channel     TEXT,
  target      TEXT,
  attempt_id  INTEGER NOT NULL,
  status      TEXT    NOT NULL,
  data        TEXT    NOT NULL,
  updated_seq INTEGER NOT NULL,
  UNIQUE (object_id, n)
) STRICT;

CREATE TABLE IF NOT EXISTS asks (
  ask_id        TEXT PRIMARY KEY,
  object_id     TEXT    NOT NULL,
  delivery_id   TEXT    NOT NULL,
  attempt_id    INTEGER NOT NULL,
  ask_version   INTEGER NOT NULL,
  content_hash  TEXT    NOT NULL,
  owner         TEXT    NOT NULL,
  owner_epoch   INTEGER NOT NULL,
  target        TEXT    NOT NULL,
  kind          TEXT    NOT NULL,
  options       TEXT    NOT NULL,
  expires_at    INTEGER NOT NULL,
  status        TEXT    NOT NULL,
  answer        TEXT,
  closed_reason TEXT,
  opened_seq    INTEGER NOT NULL,
  updated_seq   INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS asks_open     ON asks(status, expires_at);
CREATE INDEX IF NOT EXISTS asks_object   ON asks(object_id, status);
CREATE INDEX IF NOT EXISTS asks_delivery ON asks(delivery_id, status);

CREATE TABLE IF NOT EXISTS outbox (
  destination    TEXT PRIMARY KEY,
  last_acked_seq INTEGER NOT NULL,
  updated_ts     INTEGER NOT NULL
) STRICT;
`
