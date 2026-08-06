// numbered sql migrations, applied in order by the worker on startup
// (tracked via sqlite's `user_version` pragma, so index 0 === user_version 1).
export const migrations: string[] = [
	// 1: initial schema (see PLAN.md "client data model")
	`
	create table entries (
		id text primary key,
		entry_date text,
		markdown text not null default '',
		location_lat real,
		location_lng real,
		location_name text,
		deleted integer not null default 0,
		updated_at text not null
	);
	create index entries_entry_date on entries(entry_date);
	create index entries_deleted on entries(deleted);

	create table entry_tags (
		entry_id text not null references entries(id) on delete cascade,
		tag text not null,
		primary key (entry_id, tag)
	);
	create index entry_tags_tag on entry_tags(tag);

	create table ydocs (
		entry_id text primary key references entries(id) on delete cascade,
		snapshot blob not null
	);

	create table outbox (
		entry_id text not null,
		update_ blob not null,
		created_at text not null
	);

	create table attachments (
		id text primary key,
		mime text not null,
		width integer,
		height integer,
		bytes blob not null,
		pushed integer not null default 0
	);

	create table sync_state (
		key text primary key,
		value text
	);
	`,

	// 2: multiple diaries — entries.diary_id materialized from meta.diary_id
	// ('default' when the doc has no such key), plus a snapshot table for
	// non-entry well-known docs (the `_diaries` registry). that snapshot can't
	// live in `ydocs`, whose entry_id references entries(id).
	`
	alter table entries add column diary_id text not null default 'default';
	create index entries_diary_id on entries(diary_id);

	create table meta_ydocs (
		doc_id text primary key,
		snapshot blob not null
	);
	`
];
