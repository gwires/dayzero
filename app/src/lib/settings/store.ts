import { getDb } from '$lib/db/client';

/** small key/value settings, backed by the `sync_state` table (see PLAN.md "map"). */
async function getSetting(key: string): Promise<string | undefined> {
	const db = getDb();
	const rows = await db.select<{ value: string | null }>({
		sql: `select value from sync_state where key = ?`,
		params: [key]
	});
	return rows[0]?.value ?? undefined;
}

async function setSetting(key: string, value: string | undefined): Promise<void> {
	const db = getDb();
	if (value) {
		await db.exec({
			sql: `insert into sync_state (key, value) values (?, ?)
				on conflict(key) do update set value = excluded.value`,
			params: [key, value]
		});
	} else {
		await db.exec({ sql: `delete from sync_state where key = ?`, params: [key] });
	}
}

const MAP_TILE_URL_KEY = 'map_tile_url';

/**
 * custom raster tile url template (self-hosted or osm.org) used instead of
 * the bundled offline basemap. see PLAN.md "map".
 */
export function getMapTileUrl(): Promise<string | undefined> {
	return getSetting(MAP_TILE_URL_KEY);
}

export function setMapTileUrl(url: string | undefined): Promise<void> {
	return setSetting(MAP_TILE_URL_KEY, url);
}
