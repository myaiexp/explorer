// Drizzle table definitions for wander cloud-backup tables
import {
  pgTable,
  text,
  timestamp,
  doublePrecision,
  jsonb,
  inet,
  primaryKey,
} from 'drizzle-orm/pg-core';

export const accounts = pgTable('accounts', {
  username: text('username').primaryKey(),
  // SHA-256 hex digest of the 32-byte base64url bearer (audit #7058). The
  // plaintext is returned once at POST /accounts and never stored. Unique so
  // two accounts cannot share a credential even after hashing.
  token: text('token').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  ipFirstSeen: inet('ip_first_seen'),
});

// Composite PK (username, id): the client-supplied id is unique only WITHIN an
// account, not globally. A bare `id` PK let one account's PUT conflict on and
// silently overwrite another account's row (audit #4832/#4855); it also aborted
// imports of a shared walks-export JSON, where two accounts carry identical ids.
// (username, id) makes cross-tenant collision structurally impossible — the same
// id under two owners is two rows. The PK's leading `username` column also serves
// the GET/DELETE `WHERE username = ?` scans, so no separate username index is
// needed (all four section tables follow this shape).
export const visits = pgTable(
  'visits',
  {
    id: text('id').notNull(),
    username: text('username')
      .notNull()
      .references(() => accounts.username, { onDelete: 'cascade' }),
    date: timestamp('date', { withTimezone: true, mode: 'string' }).notNull(),
    startLat: doublePrecision('start_lat').notNull(),
    startLng: doublePrecision('start_lng').notNull(),
    startLabel: text('start_label'),
    destLat: doublePrecision('dest_lat').notNull(),
    destLng: doublePrecision('dest_lng').notNull(),
    destName: text('dest_name'),
    poiCategory: text('poi_category'),
    tripMode: text('trip_mode'),
    distance: doublePrecision('distance').notNull(),
    routeCoords: jsonb('route_coords'),
    routeDuration: doublePrecision('route_duration'),
    returnRouteCoords: jsonb('return_route_coords'),
    returnRouteDuration: doublePrecision('return_route_duration'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.username, t.id] }),
  })
);

export const favorites = pgTable(
  'favorites',
  {
    id: text('id').notNull(),
    username: text('username')
      .notNull()
      .references(() => accounts.username, { onDelete: 'cascade' }),
    payload: jsonb('payload').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.username, t.id] }),
  })
);

export const savedLocations = pgTable(
  'saved_locations',
  {
    id: text('id').notNull(),
    username: text('username')
      .notNull()
      .references(() => accounts.username, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    value: text('value').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.username, t.id] }),
  })
);

export const history = pgTable(
  'history',
  {
    id: text('id').notNull(),
    username: text('username')
      .notNull()
      .references(() => accounts.username, { onDelete: 'cascade' }),
    date: timestamp('date', { withTimezone: true, mode: 'string' }).notNull(),
    startLat: doublePrecision('start_lat').notNull(),
    startLng: doublePrecision('start_lng').notNull(),
    startLabel: text('start_label'),
    destLat: doublePrecision('dest_lat').notNull(),
    destLng: doublePrecision('dest_lng').notNull(),
    destName: text('dest_name'),
    tripMode: text('trip_mode'),
    distance: doublePrecision('distance').notNull(),
    routeCoords: jsonb('route_coords'),
    routeDuration: doublePrecision('route_duration'),
    returnRouteCoords: jsonb('return_route_coords'),
    returnRouteDuration: doublePrecision('return_route_duration'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.username, t.id] }),
  })
);
