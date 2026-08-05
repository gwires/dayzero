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
	`
];
