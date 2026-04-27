// Drizzle table definitions for explorer cloud-backup tables
import {
  pgTable,
  text,
  timestamp,
  doublePrecision,
  jsonb,
  inet,
  index,
} from 'drizzle-orm/pg-core';

export const accounts = pgTable('accounts', {
  username: text('username').primaryKey(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  ipFirstSeen: inet('ip_first_seen'),
});

export const visits = pgTable(
  'visits',
  {
    id: text('id').primaryKey(),
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
    usernameIdx: index('visits_username_idx').on(t.username),
  })
);

export const favorites = pgTable(
  'favorites',
  {
    id: text('id').primaryKey(),
    username: text('username')
      .notNull()
      .references(() => accounts.username, { onDelete: 'cascade' }),
    payload: jsonb('payload').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    usernameIdx: index('favorites_username_idx').on(t.username),
  })
);

export const savedLocations = pgTable(
  'saved_locations',
  {
    id: text('id').primaryKey(),
    username: text('username')
      .notNull()
      .references(() => accounts.username, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    value: text('value').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    usernameIdx: index('saved_locations_username_idx').on(t.username),
  })
);

export const history = pgTable(
  'history',
  {
    id: text('id').primaryKey(),
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
    usernameIdx: index('history_username_idx').on(t.username),
  })
);
